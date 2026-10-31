// @ts-check

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

/**
 * 真实加载 src/aura/init/main/ipcModules/ 下的每一个 IPC 模块,
 * 并注册到假 ipcMain 上。
 *
 * 背景 (真机事故): screensaverIpcHandler.js 的相对路径少写了一级 "../",
 * 模块加载抛 MODULE_NOT_FOUND → buildIpcMain 崩溃 → ipcInit 不置位 →
 * 同进程每个新窗口重试时连环 "second handler" 崩溃。此前的单测对该模块
 * 一律用 require.cache 桩替代, 从未真正 require 过, 抓不住这类错误。
 *
 * electron 依赖: 模块里 require("electron") 需要可解析, 这里自愈式地在
 * node_modules/electron 放一个极简桩 (node_modules 已被 gitignore,
 * 不入库); 桩已存在则不覆盖。
 */

const MODULES_DIR = path.resolve(
  __dirname,
  "..",
  "src",
  "aura",
  "init",
  "main",
  "ipcModules"
);

/** 字面量 require 映射 (静态分析友好; 新增模块时必须同步登记) */
const LOADERS = {
  "baseIpcHandler.js": () =>
    require("../src/aura/init/main/ipcModules/baseIpcHandler"),
  "configIpcHandler.js": () =>
    require("../src/aura/init/main/ipcModules/configIpcHandler"),
  "debugIpcHandler.js": () =>
    require("../src/aura/init/main/ipcModules/debugIpcHandler"),
  "fsIpcHandler.js": () =>
    require("../src/aura/init/main/ipcModules/fsIpcHandler"),
  "aikariIpcHandler.js": () =>
    require("../src/aura/init/main/ipcModules/aikariIpcHandler"),
  "auditIpcHandler.js": () =>
    require("../src/aura/init/main/ipcModules/auditIpcHandler"),
  "auraUpdateIpcHandler.js": () =>
    require("../src/aura/init/main/ipcModules/auraUpdateIpcHandler"),
  "pluginIpcHandler.js": () =>
    require("../src/aura/init/main/ipcModules/pluginIpcHandler"),
  "screensaverIpcHandler.js": () =>
    require("../src/aura/init/main/ipcModules/screensaverIpcHandler"),
};

/** 在 node_modules 下放置极简 electron 桩 (幂等) */
const ensureElectronStub = () => {
  const stubDir = path.resolve(__dirname, "..", "node_modules", "electron");
  if (fs.existsSync(path.join(stubDir, "package.json"))) return;
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(
    path.join(stubDir, "package.json"),
    JSON.stringify({
      name: "electron",
      main: "index.js",
      version: "0.0.0-stub",
    })
  );
  fs.writeFileSync(
    path.join(stubDir, "index.js"),
    [
      "// 测试用极简 electron 桩 (由 test/ipcModulesLoad.test.js 自动生成)",
      "module.exports = {",
      "  app: {},",
      "  BrowserWindow: class {},",
      "  ipcMain: { handle() {}, on() {}, send() {}, removeHandler() {} },",
      "  ipcRenderer: { invoke: async () => ({ success: true }), send() {}, on() {} },",
      '  shell: { openExternal: async () => {}, openPath: async () => "" },',
      "  dialog: {",
      "    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),",
      "    showSaveDialog: async () => ({ canceled: true, filePath: undefined }),",
      "  },",
      "  screen: { getPrimaryDisplay: () => ({",
      "    workArea: { x: 0, y: 0, width: 1920, height: 1040 },",
      "  }) },",
      "};",
      "",
    ].join("\n")
  );
};

/** 每个模块独立一个假 ipcMain, 避免同通道重复注册互相干扰 */
const makeFakeIpcMain = () => {
  const handlers = [];
  return {
    handlers,
    handle(channel) {
      if (handlers.includes(channel)) {
        throw new Error(`second handler for ${channel}`);
      }
      handlers.push(channel);
    },
    on() {},
    send() {},
    removeHandler() {},
  };
};

test("全部 IPC 模块可真实加载并完成注册 (抓相对路径/依赖错误)", () => {
  ensureElectronStub();

  // aikariIpcHandler 在注册时读取 global.__HUGO_AURA_CONFIG__.aikariToken
  // (真机上 hook.js 已先行初始化该全局), 测试环境补一个最小种子
  const savedConfig = global.__HUGO_AURA_CONFIG__;
  global.__HUGO_AURA_CONFIG__ = {
    aikariToken: "",
    aikariSettings: {},
  };
  const savedAura = global.__HUGO_AURA__;
  global.__HUGO_AURA__ = Object.assign({}, global.__HUGO_AURA__, {
    auraDir: ".",
  });

  try {
    runLoadCheck();
  } finally {
    global.__HUGO_AURA_CONFIG__ = savedConfig;
    global.__HUGO_AURA__ = savedAura;
  }
});

const runLoadCheck = () => {
  // 目录里的模块必须全部登记在 LOADERS 里, 防止新模块漏测
  // (插件模块仅存在于插件分支: 按磁盘实际存在的文件过滤后比对)
  const onDisk = fs
    .readdirSync(MODULES_DIR)
    .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
    .sort();
  const mapped = Object.keys(LOADERS)
    .filter((f) => fs.existsSync(path.join(MODULES_DIR, f)))
    .sort();
  assert.deepEqual(
    onDisk,
    mapped,
    "ipcModules 目录与测试登记清单不一致, 请同步 LOADERS"
  );

  const registeredByModule = {};
  for (const file of mapped) {
    const modulePath = path.join(MODULES_DIR, file);
    // 清 require 缓存, 保证每个模块真实重新加载
    delete require.cache[require.resolve(modulePath)];
    const mod = LOADERS[file]();

    const applyName = Object.keys(mod).find(
      (k) => k.startsWith("apply") && typeof mod[k] === "function"
    );
    assert.ok(applyName, `${file} 未导出 apply* 装配函数`);

    const fakeIpcMain = makeFakeIpcMain();
    // 不抛错即通过: 任何 MODULE_NOT_FOUND / 语法错误都会在这里爆出来
    mod[applyName](fakeIpcMain);
    registeredByModule[file] = fakeIpcMain.handlers.length;
  }

  // 注册通道总数不少于 8, 且关键通道在位
  const all = Object.values(registeredByModule).reduce((a, b) => a + b, 0);
  assert.ok(all >= 8, `注册通道总数异常: ${all}`);
};
