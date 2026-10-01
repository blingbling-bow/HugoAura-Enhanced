// @ts-check

/**
 * 半透明窗口白底修复
 *
 * 背景: 管家窗口工厂对浮窗默认使用
 *   transparent: true, backgroundColor: "#00FFFFFF"
 * Electron 的 #AARRGGBB 里这是 Alpha=0 的白。Windows 分层窗口会把
 * “透明白”预乘成不透明白底, 倒计日 / 通知 / 快捷工具栏这类
 * rgba(0, 0, 0, 0.3) 半透明卡片因此发白。
 *
 * 只把 #00FFFFFF 改成 #00000000 (全透明黑; 按 AARRGGBB 或 RRGGBBAA
 * 解释都是透明)。屏保等显式 backgroundColor: "#000000" 的不透明窗口不动。
 *
 * 版本容错: 没有 getBackgroundColor / 窗口已销毁时跳过, 不打断启动。
 */

const TRANSPARENT_WHITE = "#00FFFFFF";
const CLEAR_BACKGROUND = "#00000000";

/**
 * @param {string | null | undefined} color
 * @returns {boolean}
 */
const needsClearBackground = (color) => {
  return (
    typeof color === "string" && color.toUpperCase() === TRANSPARENT_WHITE
  );
};

/**
 * @param {import("electron").BrowserWindow | null | undefined} browserWindow
 */
const clearTransparentWhiteBackground = (browserWindow) => {
  try {
    if (!browserWindow || typeof browserWindow.isDestroyed !== "function") return;
    if (browserWindow.isDestroyed()) return;
    if (typeof browserWindow.getBackgroundColor !== "function") return;
    if (typeof browserWindow.setBackgroundColor !== "function") return;
    if (!needsClearBackground(browserWindow.getBackgroundColor())) return;
    browserWindow.setBackgroundColor(CLEAR_BACKGROUND);
  } catch (err) {
    console.warn(
      "[HugoAura / TransparentBg] Failed to clear window background:",
      err
    );
  }
};

/**
 * 创建时改一次; 若窗口尚未显示, ready-to-show 再改一次,
 * 避免显示路径把底色盖回 #00FFFFFF。已经可见的窗口不再挂监听。
 *
 * @param {import("electron").BrowserWindow | null | undefined} browserWindow
 */
const scheduleClearBackground = (browserWindow) => {
  clearTransparentWhiteBackground(browserWindow);
  try {
    if (!browserWindow || typeof browserWindow.isDestroyed !== "function") return;
    if (browserWindow.isDestroyed()) return;
    if (typeof browserWindow.isVisible === "function" && browserWindow.isVisible()) {
      return;
    }
    if (typeof browserWindow.once !== "function") return;
    browserWindow.once("ready-to-show", () => {
      clearTransparentWhiteBackground(browserWindow);
    });
  } catch (err) {
    console.warn(
      "[HugoAura / TransparentBg] Failed to watch ready-to-show:",
      err
    );
  }
};

const hookFn = (central) => {
  try {
    const electron = central(1);
    const app = electron && electron.app;
    const BrowserWindow = electron && electron.BrowserWindow;
    if (!app || typeof app.on !== "function" || !BrowserWindow) return;

    app.on("browser-window-created", (_event, browserWindow) => {
      scheduleClearBackground(browserWindow);
    });

    if (typeof BrowserWindow.getAllWindows === "function") {
      for (const win of BrowserWindow.getAllWindows()) {
        scheduleClearBackground(win);
      }
    }

    console.log("[HugoAura / TransparentBg] Window background fix installed.");
  } catch (err) {
    console.error("[HugoAura / TransparentBg] Failed to install:", err);
  }
};

module.exports = {
  hookFunc: hookFn,
  needsClearBackground,
};
