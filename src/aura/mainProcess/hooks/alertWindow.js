// @ts-check

/**
 * 独立提醒小窗 (Standalone Alert Window)
 *
 * 背景: 远程锁屏 / 远程关机的提醒弹窗画在注入了 global.js 的窗口里
 * (assistant / desktopAssistant, 见 ui/hookDefinitions)。当这些窗口都
 * 不可见时 (管家主窗口已关闭、管家助手被隐藏或最小化为 Fab), DOM 弹窗
 * 会静默失效 —— 拦截仍在生效, 但用户看不到任何提醒。
 *
 * 本模块由拦截器在推送渲染层弹窗的同时调用:
 *   - 任一注入窗口可见 → 交由 DOM 弹窗显示, 不弹独立小窗 (避免同屏重复);
 *   - 全部不可见 → 主进程创建一个 frameless + alwaysOnTop 的右下角小窗,
 *     样式与 DOM 弹窗一致, 显示 duration 毫秒后自动销毁。
 *
 * 标题/时长逻辑与渲染层 (ui/js/global.js 的 showAlert) 保持同源:
 *   锁屏 5 秒 (lockScreenInterceptor.NOTIFY_DELAY_MS) / 关机 10 秒
 *   (powerOffInterceptor notify 分支的 delay), 改动时两处需同步。
 */

const path = require("path");

const ALERT_PAGE = path.join(
  __dirname,
  "..",
  "..",
  "ui",
  "pages",
  "windows",
  "alertWindow",
  "index.html"
);

/** 注入了 global.js (含 DOM 提醒弹窗) 的窗口名 */
const DOM_ALERT_WINDOWS = ["assistant", "desktopAssistant"];

/** @type {any} 当前存活的提醒小窗 (单例, 新弹窗会替换旧窗) */
let currentAlertWindow = null;

/**
 * 判断是否有任一注入窗口当前可见 (可见即代表 DOM 弹窗已能覆盖)
 * @param {any} electron
 * @returns {boolean}
 */
const hasVisibleDomAlertWindow = (electron) => {
  try {
    const hooked = global.__HUGO_AURA__ && global.__HUGO_AURA__.hookedWindows;
    if (!hooked || !electron || !electron.BrowserWindow) return false;
    const allWindows = electron.BrowserWindow.getAllWindows();
    for (const key of DOM_ALERT_WINDOWS) {
      const entry = hooked.get(key);
      const wc = entry && entry.webContents;
      if (!wc) continue;
      const win = allWindows.find((w) => {
        try {
          return w.webContents === wc;
        } catch (err) {
          return false;
        }
      });
      if (win && typeof win.isVisible === "function" && win.isVisible()) {
        return true;
      }
    }
  } catch (err) {
    console.error(
      "[HugoAura / AlertWindow] Failed to check window visibility:",
      err
    );
  }
  return false;
};

const closeAlertWindow = () => {
  if (!currentAlertWindow) return;
  const win = currentAlertWindow;
  currentAlertWindow = null;
  try {
    if (!win.isDestroyed()) win.destroy();
  } catch (err) {
    console.error("[HugoAura / AlertWindow] Failed to close window:", err);
  }
};

/**
 * 弹出独立置顶提醒小窗 (仅当所有注入窗口都不可见时才真正弹出)
 * @param {any} electron central(1) 获取的 electron 模块
 * @param {{action?: string, source?: string, ts?: string, _logType?: string}} record
 *        与渲染层弹窗同源的拦截记录 (lockScreen / powerOff 拦截器构造)
 * @returns {boolean} 是否弹出了独立小窗 (false = DOM 弹窗可见或创建失败)
 */
const showAlertWindow = (electron, record) => {
  try {
    if (!electron || !electron.BrowserWindow || !record) return false;
    if (hasVisibleDomAlertWindow(electron)) return false;

    const isLock = record._logType === "lockScreen";
    const actionName = isLock ? "远程锁屏" : "远程关机";
    const blocked = record.action === "blocked";
    // 延迟秒数须与渲染层弹窗 (ui/js/global.js showAlert) 保持一致
    const delaySeconds = isLock ? 5 : 10;
    const title = blocked
      ? `已阻止${actionName}`
      : isLock
        ? `即将在 ${delaySeconds} 秒后锁屏`
        : `检测到${actionName}, ${delaySeconds} 秒后执行`;
    const durationMs = isLock ? 5000 : 10000;

    closeAlertWindow();

    const workArea = electron.screen.getPrimaryDisplay().workArea;
    const width = 348;
    const height = 102;

    const win = new electron.BrowserWindow({
      width,
      height,
      useContentSize: true,
      x: workArea.x + workArea.width - width - 20,
      y: workArea.y + workArea.height - height - 20,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        devTools: false,
      },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    currentAlertWindow = win;
    win.on("closed", () => {
      if (currentAlertWindow === win) currentAlertWindow = null;
    });

    const query = {
      title: encodeURIComponent(title),
      meta: encodeURIComponent(
        `来源: ${record.source || "unknown"} · ${
          record.ts ? new Date(record.ts).toLocaleTimeString("zh-CN") : "-"
        }`
      ),
      type: blocked ? "blocked" : "notify",
      duration: String(durationMs),
    };
    win
      .loadFile(ALERT_PAGE, { query })
      .catch((err) =>
        console.error("[HugoAura / AlertWindow] Failed to load page:", err)
      );
    win.once("ready-to-show", () => {
      try {
        // 不抢焦点 (focusable:false + showInactive), 课堂中不打断输入
        if (!win.isDestroyed()) win.showInactive();
      } catch (err) {
        console.error("[HugoAura / AlertWindow] Failed to show window:", err);
      }
    });

    // 主进程侧兜底销毁 (页面内另有 window.close() 兜底)
    const destroyTimer = setTimeout(closeAlertWindow, durationMs + 2000);
    if (typeof destroyTimer.unref === "function") destroyTimer.unref();

    console.log(
      `[HugoAura / AlertWindow] Standalone alert shown (${blocked ? "blocked" : "notify"}, ${durationMs}ms).`
    );
    return true;
  } catch (err) {
    console.error("[HugoAura / AlertWindow] Failed to show alert:", err);
    return false;
  }
};

module.exports = { showAlertWindow, closeAlertWindow };
