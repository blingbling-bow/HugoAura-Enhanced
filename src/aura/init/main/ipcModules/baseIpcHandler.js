// @ts-check

const { BrowserWindow, shell } = require("electron");

const { validateUrlResolved } = require("../../../utils/urlSafety");

const composables = {
  getBrowserWindowInstance: (windowKey) => {
    if (!global.__HUGO_AURA__.hookedWindows) return null;
    const hookedWindowIns = global.__HUGO_AURA__.hookedWindows.get(windowKey);
    if (!hookedWindowIns) return undefined;
    const browserWindowIns = BrowserWindow.fromWebContents(
      hookedWindowIns.webContents
    );
    return browserWindowIns;
  },
};

/**
 *
 * @param {import("electron").IpcMain} ipcMain
 */
const applyBaseIpcHandler = (ipcMain) => {
  const methodBase = "$aura.base";

  ipcMain.on(
    `${methodBase}.minimizeWindow`,
    /**
     *
     * @param {import("electron").IpcMainEvent} _event
     * @param {{ targetWindowKey: string }} arg
     */
    (_event, arg) => {
      const browserWindowIns = composables.getBrowserWindowInstance(
        arg.targetWindowKey
      );
      if (!browserWindowIns) return;

      browserWindowIns.minimize();
    }
  );

  ipcMain.on(
    `${methodBase}.closeWindow`,
    /**
     *
     * @param {import("electron").IpcMainEvent} _event
     * @param {{ targetWindowKey: string }} arg
     */
    (_event, arg) => {
      const browserWindowIns = composables.getBrowserWindowInstance(
        arg.targetWindowKey
      );
      if (!browserWindowIns) return;

      browserWindowIns.close();
    }
  );

  ipcMain.handle(`${methodBase}.getAuraDirAsync`, (_evt, _arg) => {
    return {
      success: true,
      data: global.__HUGO_AURA__.auraDir,
    };
  });

  ipcMain.on(`${methodBase}.getAuraDirSync`, (event, _arg) => {
    event.returnValue = {
      success: true,
      data: global.__HUGO_AURA__.auraDir,
    };
  });

  // 用系统默认浏览器打开外链 (关于页链接注入在管家 DOM 里, <a> 跳转会被
  // Electron 吞掉, 必须经主进程 shell.openExternal)。
  // 与更新客户端同一套 URL 安全校验: 仅 http/https, host 拒绝 localhost /
  // 环回 / 私有 / 保留地址; 本进程自身不做任何请求。
  ipcMain.handle(`${methodBase}.openExternal`, async (_event, arg) => {
    const url = arg && typeof arg.url === "string" ? arg.url : "";
    if (!url) {
      return { success: false, error: "URL_REQUIRED" };
    }

    const safety = await validateUrlResolved(url);
    if (!safety.ok) {
      console.warn(
        `[HugoAura / Base] Rejected openExternal (${safety.reason}): ${url}`
      );
      return { success: false, error: safety.reason };
    }

    try {
      await shell.openExternal(safety.url.href);
      return { success: true };
    } catch (err) {
      console.error("[HugoAura / Base] Failed to open external url:", err);
      return { success: false, error: "OPEN_FAILED" };
    }
  });

  // >>> 主进程构建指纹 (与 preload 的指纹日志配套, 便于真机确认跑的是哪份代码) <<<
  console.log(`[HugoAura / Base] Main-side code: ${__dirname}`);

  // >>> 自定义屏保图片 (Issue #15): IPC 注册 + 启动应用 <<<
  // 从 baseIpcHandler 装配 (而非 ipcHandler.js / hook.js): 这两个文件的插件
  // hunks 整体走插件分支, dev 分支不含插件代码时屏保功能同样完整可用。
  // 整段 try/catch 兜底: 单个 IPC 模块失败绝不能拖垮整个 buildIpcMain
  // (否则 ipcInit 不置位, 同进程后续窗口重试时连环 second handler 崩溃)。
  try {
    const { applyScreensaverIpcHandler } = require("./screensaverIpcHandler");
    const { applyIfEnabled } = require("../../../mainProcess/hooks/customScreenSaver");
    applyScreensaverIpcHandler(ipcMain);
    try {
      applyIfEnabled();
    } catch (err) {
      console.error(
        "[HugoAura / Base] Custom screen saver startup apply failed:",
        err
      );
    }
  } catch (err) {
    console.error(
      "[HugoAura / Base] Failed to wire custom screen saver IPC:",
      err
    );
  }
};

module.exports = { applyBaseIpcHandler };
