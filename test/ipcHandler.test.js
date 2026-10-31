// @ts-check

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const HANDLER_PATH = path.resolve(
  __dirname,
  "../src/aura/init/main/ipcHandler.js"
);
const IPC_MODULES_DIR = path.join(path.dirname(HANDLER_PATH), "ipcModules");

// buildIpcMain 装配时会逐个 require 这些子模块; 本测试只关心 ipcMain.send /
// flushPendingIpcMessages 的行为, 统一替换为空桩即可。
const IPC_MODULE_STUBS = [
  "baseIpcHandler",
  "debugIpcHandler",
  "configIpcHandler",
  "fsIpcHandler",
  "aikariIpcHandler",
  "auditIpcHandler",
  "auraUpdateIpcHandler",
  "pluginIpcHandler",
  "screensaverIpcHandler",
];

/**
 * 模拟销毁后仍留在 hookedWindows 里的原生窗口 (auraWsKeepAlive 的真实形态):
 * Electron 对已销毁对象访问 webContents getter 会抛 "Object has been destroyed",
 * 可选链 `?.` 只防 null/undefined, 防不了 getter 抛错 —— v0.3.1 真机审计推送崩溃的根因。
 */
class DestroyedNativeWindow {
  get webContents() {
    throw new Error("Object has been destroyed");
  }
}

const loadHandler = (t) => {
  for (const name of IPC_MODULE_STUBS) {
    const stubPath = path.join(IPC_MODULES_DIR, `${name}.js`);
    const applyName = `apply${name[0].toUpperCase()}${name.slice(1)}`;
    require.cache[stubPath] = {
      id: stubPath,
      filename: stubPath,
      loaded: true,
      exports: { [applyName]: () => {} },
    };
  }

  global.__HUGO_AURA__ = {
    hookedWindows: new Map(),
    pendingIpcMessages: new Map(),
  };

  delete require.cache[HANDLER_PATH];
  const { buildIpcMain } = require("../src/aura/init/main/ipcHandler.js");
  const electron = { app: {}, ipcMain: { on() {}, handle() {} } };
  buildIpcMain(electron);
  return electron;
};

test('ipcMain.send("*"): 表里混入已销毁原生窗口时不抛错, 存活窗口照常收到', (t) => {
  const electron = loadHandler(t);
  const delivered = [];
  global.__HUGO_AURA__.hookedWindows.set(
    "auraWsKeepAlive",
    new DestroyedNativeWindow()
  );
  global.__HUGO_AURA__.hookedWindows.set("desktopAssistant", {
    webContents: {
      isDestroyed: () => false,
      send: (channel, data) => delivered.push([channel, data]),
    },
  });

  electron.ipcMain.send("*", "$aura.audit.onLog", { record: 1 });

  assert.deepEqual(delivered, [["$aura.audit.onLog", { record: 1 }]]);
  // 失效条目自愈清理, 存活条目保留
  assert.equal(global.__HUGO_AURA__.hookedWindows.has("auraWsKeepAlive"), false);
  assert.equal(
    global.__HUGO_AURA__.hookedWindows.has("desktopAssistant"),
    true
  );
});

test("ipcMain.send: webContents 已销毁但条目未清理时只跳过, 不抛错", (t) => {
  const electron = loadHandler(t);
  const sent = [];
  global.__HUGO_AURA__.hookedWindows.set("assistant", {
    webContents: { isDestroyed: () => true, send: (...args) => sent.push(args) },
  });

  electron.ipcMain.send("assistant", "$aura.audit.onLog", { record: 2 });

  assert.equal(sent.length, 0);
});

test("ipcMain.send: 目标窗口未注册时入队; flush 遇到已销毁窗口自愈不抛错", (t) => {
  const electron = loadHandler(t);

  // 窗口尚未注册 -> 消息入队
  electron.ipcMain.send("assistant", "$aura.a", 1);
  assert.equal(
    global.__HUGO_AURA__.pendingIpcMessages.get("assistant").length,
    1
  );

  // 此期间窗口销毁: 条目变成已销毁的原生窗口 (覆盖 flush 的 getter 抛错路径)
  global.__HUGO_AURA__.hookedWindows.set(
    "assistant",
    new DestroyedNativeWindow()
  );
  global.__HUGO_AURA__.flushPendingIpcMessages("assistant");

  assert.equal(global.__HUGO_AURA__.pendingIpcMessages.has("assistant"), false);
  assert.equal(global.__HUGO_AURA__.hookedWindows.has("assistant"), false);
});
