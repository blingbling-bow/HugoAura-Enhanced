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

/** DPAPI 功能探测: 当前环境不可用时相关用例跳过 (不引入新的常红用例) */
let dpapiProbeResult = null;
const dpapiAvailable = async () => {
  if (dpapiProbeResult === null) {
    try {
      const { manager } = harness({});
      await manager.saveEncPassword("probe");
      dpapiProbeResult = true;
    } catch {
      dpapiProbeResult = false;
    }
  }
  return dpapiProbeResult;
};

test("重复 retrieve 命中口令缓存, 不再拉起 DPAPI 子进程", windowsOnly, async (t) => {
  if (!(await dpapiAvailable())) {
    return t.skip("当前环境无法使用 DPAPI (缺 SystemRoot), 跳过");
  }
  let execFileCalls = 0;
  const wrapped = { ...childProcess };
  wrapped.execFile = (file, args, options, callback) => {
    execFileCalls += 1;
    return childProcess.execFile(file, args, options, callback);
  };

  // 实例 A: 保存凭据 (1 次 DPAPI protect), save 直接写入口令缓存
  const a = harness({}, wrapped);
  await a.manager.saveEncPassword(password);
  assert.equal(execFileCalls, 1);
  assert.equal(a.manager.retrieveEncPassword().data, password);
  assert.equal(execFileCalls, 1, "保存后读取应命中 save 写入的缓存");

  // 实例 B: 冷缓存 (模拟进程重启), 首次读取 1 次 unprotect, 之后命中
  const b = harness(a.state.values, wrapped);
  assert.equal(b.manager.retrieveEncPassword().data, password);
  assert.equal(execFileCalls, 2);
  assert.equal(b.manager.retrieveEncPassword().data, password);
  assert.equal((await b.manager.retrieveEncPasswordAsync()).data, password);
  assert.equal(execFileCalls, 2, "缓存命中不得再拉起 DPAPI");
});

test("saveEncPassword 后口令缓存立即指向新凭据", windowsOnly, async (t) => {
  if (!(await dpapiAvailable())) {
    return t.skip("当前环境无法使用 DPAPI (缺 SystemRoot), 跳过");
  }
  const { manager } = harness({});
  await manager.saveEncPassword("first-password");
  assert.equal(manager.retrieveEncPassword().data, "first-password");
  await manager.saveEncPassword("second-password");
  assert.equal(
    manager.retrieveEncPassword().data,
    "second-password",
    "换密码后缓存必须指向新值"
  );
});

test("加密配置读取命中解密缓存, 文件变化后失效", async () => {
  const os = require("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aura-dec-cache-"));
  const { manager } = harness({});
  manager.configPath = path.join(root, "config.json");
  manager.encConfigPath = path.join(root, "enc.dat");
  manager.useEncConfig = true;
  // 实例桩: 口令与解密都不依赖 DPAPI, 专注验证文件指纹缓存语义
  manager.retrieveEncPassword = () => ({ success: true, data: "unit-test-pw" });
  let decryptCalls = 0;
  manager.decryptConfig = () => {
    decryptCalls += 1;
    return { success: true, data: { hello: "world", nested: { v: 1 } } };
  };

  fs.writeFileSync(manager.encConfigPath, "blob-v1");
  const first = manager.readConfig();
  assert.equal(decryptCalls, 1);
  assert.equal(
    JSON.stringify(first),
    JSON.stringify({ hello: "world", nested: { v: 1 } })
  );

  // 第二次读取: 文件指纹未变 → 命中缓存, 不再解密; 且返回深拷贝
  const second = manager.readConfig();
  assert.equal(decryptCalls, 1, "指纹未变不得重复解密");
  // 注意: readConfig 在 vm harness 内执行, JSON.parse 产物是 vm realm 的
  // 对象, 与宿主字面量原型不同, deepStrictEqual(跨 realm) 会误报,
  // 这里用 JSON 字符串比较结构
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.notEqual(second, first, "缓存命中必须返回深拷贝");
  second.hello = "mutated";
  const third = manager.readConfig();
  assert.equal(third.hello, "world", "调用方改动不得污染缓存");

  // 文件变化 → 指纹失效 → 重新解密
  fs.writeFileSync(manager.encConfigPath, "blob-v2-longer");
  manager.readConfig();
  assert.equal(decryptCalls, 2, "文件变化后必须重新解密");

  fs.rmSync(root, { recursive: true, force: true });
});

test("legacy 路径: save 后 retrieve 一致 (save 使口令缓存失效重取)", async () => {
  const { manager, state } = harness({}, childProcess, "linux");
  manager.priv_getMacAddr = () => "AABBCCDDEEFF";
  await manager.saveEncPassword(password);
  assert.match(state.values.LMAK_Value, /^[0-9a-f]+$/i);
  assert.equal((await manager.retrieveEncPasswordAsync()).data, password);
  assert.equal(manager.retrieveEncPassword().data, password);
});

test("getDefaultConfig 命中解析缓存 (default.json 不重复读盘)", windowsOnly, () => {
  const { manager } = harness({});
  manager.defaultConfigPath = path.resolve(
    __dirname, "../src/aura/init/shared/default.json"
  );
  const first = manager.getDefaultConfig();
  const second = manager.getDefaultConfig();
  assert.equal(first, second, "同一实例应返回缓存的同一对象");
});
