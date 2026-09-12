const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");

const source = fs.readFileSync(
  path.join(__dirname, "../src/aura/init/shared/configManager.js"), "utf8"
);
const password = crypto.createHash("sha256").update("test credential").digest("hex");
const windowsOnly = { skip: process.platform !== "win32" };

function harness(values = {}, child = childProcess, platform = process.platform) {
  const state = { values: { ...values }, writes: [], failWrite: false };
  class Registry {
    readRegKeySync(base, key) {
      return { success: key in state.values, data: state.values[key] ?? null };
    }
    async readRegKey(...args) { return this.readRegKeySync(...args); }
    createOrUpdateRegKeySync(base, key, value) {
      if (state.failWrite) return { success: false };
      state.writes.push(key);
      state.values[key] = value;
      return { success: true };
    }
    async createOrUpdateRegKey(...args) { return this.createOrUpdateRegKeySync(...args); }
  }
  const context = {
    module: { exports: {} }, Buffer,
    process: { ...process, platform, env: { ...process.env } },
    console: { error: (...args) => console.error(...args), warn() {}, log() {}, debug() {} },
    require(name) {
      if (name === "./registryManager") return Registry;
      if (name === "child_process") return child;
      return require(name);
    },
  };
  vm.runInNewContext(source, context, { filename: "configManager.js" });
  const manager = Object.create(context.module.exports.prototype);
  manager.priv_getMacAddr = () => "AABBCCDDEEFF";
  return { manager, state };
}

function legacy(fakeMac = false) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const mac = fakeMac ? "112233445566" : "AABBCCDDEEFF";
  const key = crypto.scryptSync(mac, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(password), cipher.final()]);
  return {
    LMAK_Value: ciphertext.toString("hex"),
    LMAK_Salt: salt.toString("hex"), LMAK_IV: iv.toString("hex"),
    LMAK_AuthTag: cipher.getAuthTag().toString("hex"),
    ...(fakeMac ? { LMAK_FakeMac: mac } : {}),
  };
}

test("DPAPI saves one protected value and reads it without MAC in both paths", windowsOnly, async () => {
  const wrapped = { ...childProcess };
  wrapped.execFile = (file, args, options, callback) => {
    assert.ok(!args.join(" ").includes(password));
    assert.ok(!args.join(" ").includes(Buffer.from(password).toString("base64")));
    assert.ok(args.join(" ").includes("::CurrentUser"));
    assert.equal(options.windowsHide, true);
    return childProcess.execFile(file, args, options, callback);
  };
  const { manager, state } = harness({}, wrapped);
  manager.priv_getMacAddr = () => { throw new Error("MAC must not be used"); };
  assert.equal(await manager.saveEncPassword(password), true);
  const first = state.values.LMAK_Value;
  assert.match(first, /^dpapi:v2:/);
  assert.ok(!first.includes(password));
  assert.deepEqual(state.writes, ["LMAK_Value"]);
  assert.equal(manager.retrieveEncPassword().data, password);
  assert.equal((await manager.retrieveEncPasswordAsync()).data, password);
  await manager.saveEncPassword(password);
  assert.notEqual(state.values.LMAK_Value, first);
});

for (const asyncRead of [false, true]) {
  for (const fakeMac of [false, true]) {
    test(`legacy migration: async=${asyncRead}, fakeMac=${fakeMac}`, windowsOnly, async () => {
      const { manager, state } = harness(legacy(fakeMac));
      const result = asyncRead ? await manager.retrieveEncPasswordAsync() : manager.retrieveEncPassword();
      assert.equal(result.success, true);
      assert.equal(result.data, password);
      assert.match(state.values.LMAK_Value, /^dpapi:v2:/);
      assert.deepEqual(state.writes, ["LMAK_Value"]);
      manager.priv_getMacAddr = () => { throw new Error("Legacy path must not run"); };
      assert.equal(manager.retrieveEncPassword().data, password);
    });
  }
}

test("corrupt DPAPI data fails without falling back to MAC", windowsOnly, async () => {
  const { manager, state } = harness({ LMAK_Value: "dpapi:v2:AAAA" });
  let macCalls = 0;
  manager.priv_getMacAddr = () => { macCalls++; return "AABBCCDDEEFF"; };
  assert.equal(manager.retrieveEncPassword().success, false);
  assert.equal((await manager.retrieveEncPasswordAsync()).success, false);
  assert.equal(macCalls, 0);
  assert.equal(state.writes.length, 0);
});

test("registry failure is reported and leaves old credential intact", windowsOnly, async () => {
  const original = legacy();
  const { manager, state } = harness(original);
  state.failWrite = true;
  await assert.rejects(manager.saveEncPassword(password), /persist protected/);
  assert.equal(manager.retrieveEncPassword().success, false);
  assert.deepEqual(state.values, original);
});

test("DPAPI unavailable does not persist a raw or MAC-derived credential", windowsOnly, async () => {
  const unavailable = {
    execFile() { throw new Error("Unavailable"); },
    execFileSync() { throw new Error("Unavailable"); },
  };
  const original = legacy();
  const { manager, state } = harness(original, unavailable);
  await assert.rejects(manager.saveEncPassword(password));
  assert.equal(manager.retrieveEncPassword().success, false);
  assert.equal((await manager.retrieveEncPasswordAsync()).success, false);
  assert.deepEqual(state.values, original);
  assert.equal(state.writes.length, 0);
});

test("non-Windows uses the legacy AES credential path", async () => {
  const { manager, state } = harness({}, childProcess, "linux");
  manager.priv_getMacAddr = () => "AABBCCDDEEFF";
  assert.equal(await manager.saveEncPassword(password), true);
  assert.match(state.values.LMAK_Value, /^[0-9a-f]+$/i);
  assert.ok(state.values.LMAK_Salt);
  assert.equal((await manager.retrieveEncPasswordAsync()).data, password);
  assert.equal(manager.retrieveEncPassword().data, password);
});
