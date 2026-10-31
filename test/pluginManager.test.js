// @ts-check

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pluginManager = require("../src/aura/init/main/pluginManager.js");

/** 建临时 auraDir (global.__HUGO_AURA__.auraDir) */
const makeEnv = (t, { enabledMap = {} } = {}) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-plugins-test-"));
  const config = {
    auraSettings: { plugins: { enabled: { ...enabledMap } } },
  };

  global.__HUGO_AURA__ = global.__HUGO_AURA__ || {};
  global.__HUGO_AURA__.auraDir = tmpDir;
  global.__HUGO_AURA__.version = "v9.9.9";
  global.__HUGO_AURA__.central = () => "central-stub";
  global.__HUGO_AURA_CONFIG_MGR__ = { loadConfig: () => config };

  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});

  return {
    tmpDir,
    config,
    /** 在 plugins/<id>/ 下落一个插件目录 */
    makePlugin: (id, { type = "main", onLoadBody = "" } = {}) => {
      const pluginDir = path.join(tmpDir, "plugins", id);
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, "manifest.json"),
        JSON.stringify({
          id,
          name: `Plugin ${id}`,
          version: "1.0.0",
          author: "tester",
          description: "test plugin",
          type,
          main: "main.js",
        })
      );
      fs.writeFileSync(
        path.join(pluginDir, "main.js"),
        [
          "const s = (global.__pluginTestState = global.__pluginTestState || {});",
          `s["${id}"] = { loaded: true };`,
          "module.exports = {",
          `  onLoad(ctx) { s["${id}"].ctx = { storageDir: ctx.storageDir, centralOk: typeof ctx.central === "function", version: ctx.auraVersion, eventName: ctx.eventBus ? "ok" : null }; },`,
          "  onUnload() { s[\"" + id + "\"].unloaded = true; }",
          "};",
          onLoadBody,
        ].join("\n")
      );
      return pluginDir;
    },
    cleanup() {
      // loadedMainPlugins 是模块级的: 先卸载运行实例, 否则会泄漏到后续用例
      // (loadPlugins 看到"已加载"就跳过, 新目录永远不会被加载)
      for (const id of ["demo.a", "demo.ui", "demo.disabled"]) {
        try {
          pluginManager.disablePlugin(id);
        } catch (_err) {
          /* 未加载时静默跳过 */
        }
      }
      delete global.__pluginTestState;
      delete global.__HUGO_AURA__.auraDir;
      delete global.__HUGO_AURA__.central;
      delete global.__HUGO_AURA__.version;
      delete global.__HUGO_AURA_CONFIG_MGR__;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
};

test("validateManifest: 结构校验", () => {
  const ok = pluginManager.validateManifest({
    id: "com.demo.a",
    name: "n",
    version: "1.0.0",
    author: "a",
    description: "d",
    type: "main",
    main: "main.js",
  });
  assert.strictEqual(ok.ok, true);

  assert.strictEqual(
    pluginManager.validateManifest({ id: "bad id!", name: "n", version: "1", author: "a", type: "main", main: "m.js" }).ok,
    false,
    "非法 id 应拒绝"
  );
  assert.strictEqual(
    pluginManager.validateManifest({ name: "n", version: "1", author: "a", type: "main", main: "m.js" }).ok,
    false,
    "缺 id 应拒绝"
  );
  assert.strictEqual(
    pluginManager.validateManifest({ id: "com.demo.a", name: "n", version: "1", author: "a", type: "worker", main: "m.js" }).ok,
    false,
    "非法 type 应拒绝"
  );
  assert.strictEqual(
    pluginManager.validateManifest({ id: "com.demo.a", name: "n", version: "1", author: "a", type: "main", main: "../evil.js" }).ok,
    false,
    "main 带路径应拒绝"
  );
  assert.strictEqual(
    pluginManager.validateManifest(
      { id: "com.demo.b", name: "n", version: "1", author: "a", type: "main", main: "m.js" },
      "com.demo.a"
    ).ok,
    false,
    "id 与目录名不一致应拒绝"
  );
});

test("loadPlugins: 已启用的 main 插件被加载并拿到 ctx", (t) => {
  const env = makeEnv(t, { enabledMap: { "demo.a": true } });
  try {
    env.makePlugin("demo.a");

    const res = pluginManager.loadPlugins();
    assert.strictEqual(res.installed, 1);
    assert.strictEqual(res.loaded, 1);
    assert.strictEqual(pluginManager.isMainPluginLoaded("demo.a"), true);

    const state = global.__pluginTestState["demo.a"];
    assert.strictEqual(state.loaded, true);
    assert.strictEqual(state.ctx.centralOk, true, "ctx.central 应可用");
    assert.strictEqual(state.ctx.version, "v9.9.9");
    assert.ok(fs.existsSync(state.ctx.storageDir), "storageDir 应已创建");
  } finally {
    env.cleanup();
  }
});

test("loadPlugins: 未启用 / ui 类型 / 非法目录均被跳过", (t) => {
  const env = makeEnv(t, {});
  try {
    env.makePlugin("demo.disabled"); // 未启用
    env.makePlugin("demo.ui", { type: "ui" }); // ui 类型不走主进程加载
    // 非法目录: 缺 manifest
    fs.mkdirSync(path.join(env.tmpDir, "plugins", "demo.broken"), { recursive: true });

    const res = pluginManager.loadPlugins();
    assert.strictEqual(res.installed, 2, "非法目录不计入 installed");
    assert.strictEqual(res.loaded, 0);
    assert.strictEqual(pluginManager.isMainPluginLoaded("demo.disabled"), false);
  } finally {
    env.cleanup();
  }
});

test("disablePlugin / enablePlugin: onUnload 被调, require 缓存被清", (t) => {
  const env = makeEnv(t, { enabledMap: { "demo.a": true } });
  try {
    env.makePlugin("demo.a");
    pluginManager.loadPlugins();
    assert.strictEqual(pluginManager.isMainPluginLoaded("demo.a"), true);

    pluginManager.disablePlugin("demo.a");
    assert.strictEqual(global.__pluginTestState["demo.a"].unloaded, true);
    assert.strictEqual(pluginManager.isMainPluginLoaded("demo.a"), false);

    // 再启用: 重新加载 (require 缓存已清, onLoad 再次执行)
    pluginManager.enablePlugin("demo.a");
    assert.strictEqual(pluginManager.isMainPluginLoaded("demo.a"), true);
  } finally {
    env.cleanup();
  }
});

test("enablePlugin: ui 类型只校验不加载主进程实例", (t) => {
  const env = makeEnv(t, {});
  try {
    env.makePlugin("demo.ui", { type: "ui" });
    pluginManager.enablePlugin("demo.ui");
    assert.strictEqual(pluginManager.isMainPluginLoaded("demo.ui"), false);
  } finally {
    env.cleanup();
  }
});
