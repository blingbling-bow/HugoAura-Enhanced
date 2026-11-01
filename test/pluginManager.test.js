// @ts-check

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pluginManager = require("../src/aura/init/main/pluginManager.js");

/** 建临时 auraDir (global.__HUGO_AURA__.auraDir) */
const makeEnv = (t, { enabledMap = {}, permissionsMap = {} } = {}) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-plugins-test-"));
  const config = {
    auraSettings: {
      plugins: {
        enabled: { ...enabledMap },
        permissions: { ...permissionsMap },
      },
    },
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
    makePlugin: (id, { type = "main" } = {}) => {
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
          permissions: [
            { key: "storage", label: "存储" },
            { key: "events", label: "事件" },
          ],
        })
      );
      fs.writeFileSync(
        path.join(pluginDir, "main.js"),
        [
          "// 沙箱契约插件: 通过 settings 持久化向宿主测试断言暴露状态",
          "var savedCtx = null;",
          "module.exports = {",
          "  onLoad: function (ctx) {",
          "    savedCtx = ctx;",
          "    ctx.settings.set({",
          "      loaded: true,",
          "      version: ctx.auraVersion,",
          "      manifestId: ctx.manifest.id,",
          "      eventBusType: typeof ctx.eventBus,",
          "    });",
          "  },",
          "  onUnload: function () {",
          "    if (savedCtx) savedCtx.settings.set({ unloaded: true });",
          "  },",
          "};",
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

test("loadPlugins: 已启用的 main 插件经沙箱加载并可观测", (t) => {
  const env = makeEnv(t, { enabledMap: { "demo.a": true } });
  try {
    env.makePlugin("demo.a");

    const res = pluginManager.loadPlugins();
    assert.strictEqual(res.installed, 1);
    assert.strictEqual(res.loaded, 1);
    assert.strictEqual(pluginManager.isMainPluginLoaded("demo.a"), true);

    // 沙箱契约: 状态经 settings 持久化暴露 (沙箱内不可见宿主 global)
    const settingsPath = path.join(
      env.tmpDir, "plugins", "demo.a", "storage", "settings.json"
    );
    const state = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.strictEqual(state.loaded, true);
    assert.strictEqual(state.version, "v9.9.9");
    assert.strictEqual(state.manifestId, "demo.a");
    assert.strictEqual(state.eventBusType, "object", "events 权限应暴露 eventBus");
    assert.ok(
      fs.existsSync(path.join(env.tmpDir, "plugins", "demo.a", "storage")),
      "storage 目录应已创建"
    );
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

test("disablePlugin / enablePlugin: onUnload 被调 + 沙箱资源回收后可重新加载", (t) => {
  const env = makeEnv(t, { enabledMap: { "demo.a": true } });
  try {
    env.makePlugin("demo.a");
    pluginManager.loadPlugins();
    assert.strictEqual(pluginManager.isMainPluginLoaded("demo.a"), true);
    const settingsPath = path.join(
      env.tmpDir, "plugins", "demo.a", "storage", "settings.json"
    );

    pluginManager.disablePlugin("demo.a");
    const afterUnload = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.strictEqual(afterUnload.unloaded, true, "onUnload 应被调");
    assert.strictEqual(pluginManager.isMainPluginLoaded("demo.a"), false);

    // 再启用: 沙箱资源已回收, onLoad 再次执行
    pluginManager.enablePlugin("demo.a");
    const afterReload = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.strictEqual(afterReload.loaded, true);
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

test("权限运行时强制: 用户关闭 storage 后, 未探测的插件加载失败 / 探测型插件正常", (t) => {
  // 用户在详情弹窗关闭了 demo.a 的 storage 权限
  const env = makeEnv(t, {
    enabledMap: { "demo.a": true, "demo.probe": true },
    permissionsMap: { "demo.a": { storage: false }, "demo.probe": { storage: false } },
  });
  try {
    // demo.a: onLoad 无条件触碰 ctx.settings → 能力不存在 → 加载失败
    env.makePlugin("demo.a");
    // demo.probe: 先探测 typeof ctx.settings 再使用 → 优雅降级, 正常加载
    const probeDir = path.join(env.tmpDir, "plugins", "demo.probe");
    fs.mkdirSync(probeDir, { recursive: true });
    fs.writeFileSync(
      path.join(probeDir, "manifest.json"),
      JSON.stringify({
        id: "demo.probe",
        name: "probe",
        version: "1.0.0",
        author: "tester",
        description: "t",
        type: "main",
        main: "main.js",
        permissions: [{ key: "storage", label: "存储" }],
      })
    );
    fs.writeFileSync(
      path.join(probeDir, "main.js"),
      [
        "module.exports = {",
        "  onLoad: function (ctx) {",
        "    if (typeof ctx.settings !== 'undefined') ctx.settings.set({ probed: true });",
        "  },",
        "};",
      ].join("\n")
    );

    const res = pluginManager.loadPlugins();
    assert.strictEqual(res.installed, 2);
    assert.strictEqual(res.loaded, 1, "触碰被关闭能力的插件应加载失败");
    assert.strictEqual(pluginManager.isMainPluginLoaded("demo.a"), false);
    assert.strictEqual(
      pluginManager.isMainPluginLoaded("demo.probe"),
      true,
      "探测型插件应正常加载"
    );
  } finally {
    env.cleanup();
  }
});
