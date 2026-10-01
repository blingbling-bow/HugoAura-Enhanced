// @ts-check

/**
 * 隐藏倒计日组件 (Hide Countdown Days) 主进程钩子
 *
 * 目标: 集控下发的「倒计日」卡片 —— 窗口名 "countdown", 由 public/countdown.js
 * 渲染, 界面文案为标题「倒计日」+「距离<事件>仅有 N 天」。它不是按秒的倒计时,
 * 而是按天递减的倒计日, 由云端通过 messageType 1004 下发, 窗口管理器
 * (模块 3) newOne("countdown") 创建。它是槽位卡片 (yIndex 3)。
 *
 * 原先只在「收到 1004」和「开关 refresh」时 close() 窗口。卡片往往在钩子
 * 装上之前就已经 newOne 出来, 启动时那一次 close 对空窗口是空操作; 之后没有
 * 新的配置刷新, 开关虽然是开的, 卡片却一直留在屏上, 必须再拨一次开关才会收掉。
 *
 * 现在改为: 包住 newOne, 在 BrowserWindow 创建、onFinished 调用 show() 之前
 * 就装上槽位隐藏。开关原本就是开的也会立刻 hide + 释放槽位, 不必再拨开关。
 * 之后原生再次 show() 也会被槽位工具收回。关掉开关则恢复显示和槽位。
 */

const { withRetry, resolveModule } = require("./retryHook");
const { createSlotCardHider, readConfigPath } = require("./slotCardHider");

const WINDOW_MANAGER_ID = 3;
const WINDOW_NAME = "countdown";
const WRAPPED_FLAG = "__auraHideCountdownWrapped";

/**
 * 倒计日页面地址。file URL 可能带 query。
 *
 * @param {string | null | undefined} url
 * @returns {boolean}
 */
const isCountdownUrl = (url) => {
  return (
    typeof url === "string" &&
    /(?:^|[\\/])countdown\.html(?:[?#]|$)/i.test(url)
  );
};

const isHideEnabled = () => {
  return Boolean(
    readConfigPath("networkRewrite.appearance/hideCountdown.enabled")
  );
};

/**
 * @param {(id: number) => any} central
 */
const hookFn = (central) => {
  /** @type {WeakSet<object>} */
  const attached = new WeakSet();
  let creatingCountdown = false;
  let watching = false;

  /**
   * @param {import("electron").BrowserWindow | null | undefined} browserWindow
   */
  const attach = (browserWindow) => {
    if (!browserWindow || attached.has(browserWindow)) return;
    try {
      if (
        typeof browserWindow.isDestroyed === "function" &&
        browserWindow.isDestroyed()
      ) {
        return;
      }
    } catch (err) {
      return;
    }
    attached.add(browserWindow);
    createSlotCardHider({
      central,
      browserWindow,
      windowName: WINDOW_NAME,
      label: "HideCountdown",
      isEnabled: isHideEnabled,
    });
  };

  /**
   * newOne 期间用创建标记识别; 其余路径 (钩子安装前已存在的窗口) 用页面地址。
   *
   * @param {import("electron").BrowserWindow | null | undefined} browserWindow
   */
  const consider = (browserWindow) => {
    if (creatingCountdown) {
      attach(browserWindow);
      return;
    }
    try {
      if (!browserWindow || typeof browserWindow.isDestroyed !== "function") {
        return;
      }
      if (browserWindow.isDestroyed()) return;
      const wc = browserWindow.webContents;
      if (!wc || typeof wc.getURL !== "function") return;

      const check = () => {
        try {
          if (browserWindow.isDestroyed()) return;
          if (isCountdownUrl(wc.getURL())) attach(browserWindow);
        } catch (err) {
          console.warn(
            "[HugoAura / HideCountdown] Failed to inspect window URL:",
            err
          );
        }
      };

      check();
      if (!attached.has(browserWindow) && typeof wc.on === "function") {
        const onLoad = () => {
          check();
          if (
            attached.has(browserWindow) &&
            typeof wc.removeListener === "function"
          ) {
            wc.removeListener("did-start-loading", onLoad);
            wc.removeListener("did-finish-load", onLoad);
          }
        };
        wc.on("did-start-loading", onLoad);
        wc.on("did-finish-load", onLoad);
      }
    } catch (err) {
      console.warn("[HugoAura / HideCountdown] Failed to watch window:", err);
    }
  };

  const watchWindows = () => {
    if (watching) return;
    try {
      const electron = central(1);
      const BrowserWindow = electron && electron.BrowserWindow;
      if (BrowserWindow && typeof BrowserWindow.getAllWindows === "function") {
        for (const win of BrowserWindow.getAllWindows()) consider(win);
      }
      const app = electron && electron.app;
      if (!app || typeof app.on !== "function") return;
      watching = true;
      app.on("browser-window-created", (_event, browserWindow) => {
        consider(browserWindow);
      });
    } catch (err) {
      console.warn(
        "[HugoAura / HideCountdown] Failed to watch new windows:",
        err
      );
    }
  };

  const tryInstall = () => {
    watchWindows();

    const windowMgr = resolveModule(central, WINDOW_MANAGER_ID);
    const ready =
      windowMgr &&
      typeof windowMgr.newOne === "function" &&
      typeof windowMgr.checkWindowExist === "function" &&
      typeof windowMgr.getInstance === "function";
    if (!ready) {
      console.debug(
        "[HugoAura / HideCountdown] Window manager (module 3) not ready, retrying..."
      );
      return false;
    }

    if (!windowMgr[WRAPPED_FLAG]) {
      const originalNewOne = windowMgr.newOne.bind(windowMgr);
      windowMgr.newOne = (name, ...args) => {
        const mark = name === WINDOW_NAME;
        if (mark) creatingCountdown = true;
        try {
          const win = originalNewOne(name, ...args);
          if (mark) attach(win);
          return win;
        } finally {
          if (mark) creatingCountdown = false;
        }
      };
      windowMgr[WRAPPED_FLAG] = true;
      console.log("[HugoAura / HideCountdown] Wrapped window manager newOne.");
    }

    try {
      if (windowMgr.checkWindowExist(WINDOW_NAME)) {
        attach(windowMgr.getInstance(WINDOW_NAME));
      }
    } catch (err) {
      console.warn(
        "[HugoAura / HideCountdown] Failed to hide existing countdown window:",
        err
      );
    }

    return true;
  };

  withRetry(tryInstall, { label: "HideCountdown" })();
};

module.exports = { hookFunc: hookFn, isCountdownUrl };
