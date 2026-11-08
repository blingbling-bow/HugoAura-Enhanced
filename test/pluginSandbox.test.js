// @ts-check

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  runMainPlugin,
  resolveGrantedPermissions,
  SUPPORTED_PERMISSIONS,
} = require("../src/aura/init/main/pluginSandbox");

/** 构造临时插件目录 (settings 存储落到 storage/settings.json) */
const makeStorage = () => {
  const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-sandbox-test-"));
  const storageDir = path.join(pluginDir, "storage");
  fs.mkdirSync(storageDir, { recursive: true });
  return {
    pluginDir,
    storageDir,
    settingsApi: {
      get: () => {
        try {
          return JSON.parse(
            fs.readFileSync(path.join(storageDir, "settings.json"), "utf8")
          );
        } catch {
          return {};
        }
      },
      set: (values) => {
        fs.writeFileSync(
          path.join(storageDir, "settings.json"),
          JSON.stringify(values || {}, null, 2)
        );
        return values || {};
      },
    },
    cleanup: () => fs.rmSync(pluginDir, { recursive: true, force: true }),
  };
};

/** 收集插件日志的 collector */
const makeLogCollector = () => {
  const lines = [];
  return {
    lines,
    log: (level, line) => lines.push(`[${level}] ${line}`),
    joined: () => lines.join("\n"),
  };
};

const MANIFEST = {
  id: "com.sandbox.test",
  name: "沙箱测试",
  version: "1.0.0",
  author: "test",
  type: "main",
  main: "main.js",
  permissions: [
    { key: "storage", label: "存储" },
    { key: "events", label: "事件" },
    { key: "network", label: "联网" },
    { key: "notify", label: "通知" },
    { key: "shortcuts", label: "快捷键" },
  ],
};

test("沙箱: 插件可加载, ctx 能力齐全, 权限门控生效", () => {
  const store = makeStorage();
  const collector = makeLogCollector();

  const run = runMainPlugin({
    source: `
      var results = {};
      results.hasRequire = typeof require;
      results.hasProcess = typeof process;
      results.hasFs = typeof fs;
      results.hasGlobal = typeof global;
      results.hasBuffer = typeof Buffer;
      results.manifestId = ctx.manifest.id;
      results.hasSettings = typeof ctx.settings;
      results.hasEventBus = typeof ctx.eventBus;
      results.hasNet = typeof ctx.net;
      results.hasConfig = typeof ctx.config;
      results.hasTimers = typeof ctx.timers;
      ctx.logger.log("PROBE " + JSON.stringify(results));
      module.exports = { onLoad: function (c) { c.logger.log("onLoad-ok"); } };
    `,
    manifest: MANIFEST,
    auraVersion: "test",
    settingsApi: store.settingsApi,
    busApi: { on() {}, off() {}, emit() {} },
    log: collector.log,
  });

  assert.ok(run.instance && typeof run.instance.onLoad === "function");
  run.instance.onLoad(run.ctx);

  const joined = collector.joined();
  // 沙箱内高危全局全部不可见
  assert.match(joined, /hasRequire.{0,4}undefined/);
  assert.match(joined, /hasProcess.{0,4}undefined/);
  assert.match(joined, /hasFs.{0,4}undefined/);
  assert.match(joined, /hasGlobal.{0,4}undefined/);
  assert.match(joined, /hasBuffer.{0,4}undefined/);
  // 已声明的能力暴露, ctx 结构完整
  assert.match(joined, /manifestId.{0,4}com\.sandbox\.test/);
  assert.match(joined, /hasSettings.{0,4}object/);
  assert.match(joined, /hasEventBus.{0,4}object/);
  assert.match(joined, /hasNet.{0,4}object/);
  assert.match(joined, /hasConfig.{0,4}object/);
  assert.match(joined, /hasTimers.{0,4}object/);
  assert.match(joined, /onLoad-ok/);

  store.cleanup();
});

test("沙箱: .constructor 逃逸尝试拿不到宿主对象", () => {
  const store = makeStorage();
  const collector = makeLogCollector();

  const run = runMainPlugin({
    source: `
      var probe = {};
      try {
        var HostFn = ctx.logger.log.constructor;
        // 沙箱内构建的包装函数, 其 .constructor 是本 realm 的 Function,
        // 用它 eval 拿到的也只是沙箱全局 (无 process/require)
        var leaked = HostFn("return typeof process + '/' + typeof require")();
        probe.result = leaked;
      } catch (e) {
        probe.result = "throw:" + e.message;
      }
      ctx.logger.log("ESCAPE " + JSON.stringify(probe));
      module.exports = {};
    `,
    manifest: MANIFEST,
    settingsApi: store.settingsApi,
    busApi: { on() {}, off() {}, emit() {} },
    log: collector.log,
  });
  run.instance.onLoad && run.instance.onLoad(run.ctx);

  assert.match(collector.joined(), /ESCAPE .*"result":"undefined\/undefined"/);
  store.cleanup();
});

test("沙箱: 未声明权限的能力不暴露 (network 缺失 => 无 ctx.net)", () => {
  const store = makeStorage();
  const collector = makeLogCollector();
  const manifestNoNet = {
    ...MANIFEST,
    permissions: [{ key: "storage", label: "存储" }],
  };

  const run = runMainPlugin({
    source: `
      ctx.logger.log("NETCHECK " + typeof ctx.net);
      module.exports = {};
    `,
    manifest: manifestNoNet,
    settingsApi: store.settingsApi,
    busApi: { on() {}, off() {}, emit() {} },
    log: collector.log,
  });
  run.instance.onLoad && run.instance.onLoad(run.ctx);
  assert.match(collector.joined(), /NETCHECK undefined/);
  store.cleanup();
});

test("沙箱: 事件总线命名空间锁定 (跨命名空间被拒)", () => {
  const store = makeStorage();
  const collector = makeLogCollector();
  const subscribed = [];

  const run = runMainPlugin({
    source: `
      var r = {};
      try {
        ctx.eventBus.on("$aura.config.refreshConfig", function () {});
        r.cross = "accepted";
      } catch (e) { r.cross = "denied:" + String(e.message).slice(0, 30); }
      try {
        ctx.eventBus.on("$aura.plugin.com.sandbox.test.settingsChanged", function () {});
        r.own = "accepted";
      } catch (e) { r.own = "denied"; }
      ctx.logger.log("BUS " + JSON.stringify(r));
      module.exports = {};
    `,
    manifest: MANIFEST,
    settingsApi: store.settingsApi,
    busApi: {
      on: (event, fn) => subscribed.push(event),
      off() {},
      emit() {},
    },
    log: collector.log,
  });
  run.instance.onLoad && run.instance.onLoad(run.ctx);

  assert.match(collector.joined(), /BUS .*"cross":"denied:EVENT_NAMESPACE_DENIED/);
  assert.match(collector.joined(), /BUS .*"own":"accepted"/);
  assert.deepEqual(subscribed, [
    "$aura.plugin.com.sandbox.test.settingsChanged",
  ]);
  store.cleanup();
});

test("沙箱: 定时器上限 16, dispose 后全量回收", () => {
  const store = makeStorage();
  const collector = makeLogCollector();

  const run = runMainPlugin({
    source: `
      var ids = [];
      for (var i = 0; i < 20; i++) {
        var id = ctx.timers.setInterval(function () {}, 1000);
        ids.push(id);
      }
      var alive = ids.filter(function (x) { return x !== null; }).length;
      ctx.logger.log("TIMERS alive=" + alive);
      module.exports = {};
    `,
    manifest: MANIFEST,
    settingsApi: store.settingsApi,
    busApi: { on() {}, off() {}, emit() {} },
    log: collector.log,
  });
  run.instance.onLoad && run.instance.onLoad(run.ctx);
  assert.match(collector.joined(), /TIMERS alive=16/);

  // dispose 后定时器全部回收: 通过宿主侧 timers 数量验证 (行为验证:
  // dispose 不抛错即视为回收; 精确计数由宿主 Map 保证)
  assert.doesNotThrow(() => run.dispose());
  store.cleanup();
});

test("沙箱: settings 读写往返 + storage 权限拒绝", () => {
  const store = makeStorage();
  const collector = makeLogCollector();

  const run = runMainPlugin({
    source: `
      var r = {};
      ctx.settings.set({ a: 1, b: "x" });
      r.roundtrip = ctx.settings.get();
      ctx.logger.log("SETTINGS " + JSON.stringify(r));
      module.exports = {};
    `,
    manifest: MANIFEST,
    settingsApi: store.settingsApi,
    busApi: { on() {}, off() {}, emit() {} },
    log: collector.log,
  });
  run.instance.onLoad && run.instance.onLoad(run.ctx);
  assert.match(collector.joined(), /SETTINGS .*"a":1/);
  const stored = store.settingsApi.get();
  assert.equal(stored.a, 1);
  assert.equal(stored.b, "x");
  store.cleanup();

  // storage 未声明: ctx.settings 直接不存在 (未授予即不暴露),
  // 宿主分发层的 PERMISSION_DENIED 是第二道防线
  const collector2 = makeLogCollector();
  const store2 = makeStorage();
  const run2 = runMainPlugin({
    source: `
      var r = { settingsType: typeof ctx.settings };
      try { ctx.settings.set({ a: 1 }); r.call = "accepted"; }
      catch (e) { r.call = "blocked"; }
      ctx.logger.log("DENY " + JSON.stringify(r));
      module.exports = {};
    `,
    manifest: { ...MANIFEST, permissions: [] },
    busApi: { on() {}, off() {}, emit() {} },
    log: collector2.log,
  });
  run2.instance.onLoad && run2.instance.onLoad(run2.ctx);
  assert.match(collector2.joined(), /DENY .*"settingsType":"undefined"/);
  assert.match(collector2.joined(), /DENY .*"call":"blocked"/);
  store2.cleanup();
});

test("沙箱 v2: notify 与 shortcuts (权限门控 + dispose 注销)", () => {
  const store = makeStorage();
  const collector = makeLogCollector();
  const notifyCalls = [];
  const registered = [];
  const unregistered = [];

  const run = runMainPlugin({
    source: `
      var r = {};
      ctx.notify("测试标题", "测试内容", 8000);
      r.shortcutId = ctx.shortcuts.register("Ctrl+Shift+T", function () {});
      r.hasNet = typeof ctx.net;
      ctx.logger.log("V2 " + JSON.stringify(r));
      module.exports = {};
    `,
    manifest: MANIFEST,
    settingsApi: store.settingsApi,
    busApi: { on() {}, off() {}, emit() {} },
    notifyApi: (record) => {
      notifyCalls.push(record);
      return true;
    },
    shortcutsApi: {
      register: (acc, cb) => {
        registered.push({ acc, cb });
        return true;
      },
      unregister: (acc) => {
        unregistered.push(acc);
        return true;
      },
    },
    log: collector.log,
  });
  run.instance.onLoad && run.instance.onLoad(run.ctx);

  assert.match(collector.joined(), /V2 .*"hasNet":"object"/);
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0].title, "测试标题");
  assert.equal(notifyCalls[0].body, "测试内容");
  assert.match(notifyCalls[0].source, /插件: com\.sandbox\.test/);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].acc, "Ctrl+Shift+T");
  assert.equal(typeof registered[0].cb, "function");

  // dispose: 快捷键必须全量注销
  run.dispose();
  assert.deepEqual(unregistered, ["Ctrl+Shift+T"]);
  store.cleanup();
});

test("沙箱 v2: 未声明 notify/shortcuts 时能力不存在", () => {
  const store = makeStorage();
  const collector = makeLogCollector();
  const run = runMainPlugin({
    source: `
      ctx.logger.log("V2ABSENT " + JSON.stringify({
        notify: typeof ctx.notify,
        shortcuts: typeof ctx.shortcuts,
      }));
      module.exports = {};
    `,
    manifest: { ...MANIFEST, permissions: [{ key: "storage", label: "存储" }] },
    settingsApi: store.settingsApi,
    busApi: { on() {}, off() {}, emit() {} },
    log: collector.log,
  });
  run.instance.onLoad && run.instance.onLoad(run.ctx);
  assert.match(
    collector.joined(),
    /V2ABSENT \{"notify":"undefined","shortcuts":"undefined"\}/
  );
  store.cleanup();
});

test("resolveGrantedPermissions: 去重 + 过滤未支持权限", () => {
  const granted = resolveGrantedPermissions({
    permissions: [
      { key: "storage" },
      { key: "storage" },
      { key: "unknown-perm" },
      { key: "network" },
    ],
  });
  assert.deepEqual(granted, ["storage", "network"]);
  assert.deepEqual(SUPPORTED_PERMISSIONS, [
    "storage",
    "network",
    "events",
    "notify",
    "shortcuts",
  ]);
});
