// @ts-check

/**
 * 禁用屏幕保护 (Screensaver) 主进程钩子
 *
 * 原理: 希沃管家的屏幕保护由集控通过 SeewoProxyHTTP 下发 `/displayScreenSaver`
 * 消息触发, 处理逻辑位于主进程模块 121 (ScreensaverManager 单例实例)。
 * 本钩子包装该实例的 onMessage / startScreensaver, 并在配置启用时吞掉
 * 屏保触发消息, 使屏幕永不进入屏保状态。
 *
 * 风险处理:
 * 1. 集控侧异常: 拦截后主动调用原始 stopScreensaver() 上报 screenSaver/reset,
 *    让集控认为设备已正常关闭屏保, 避免状态卡死。
 * 2. 模块 ID 版本漂移: 源头拦截与窗口守卫各自独立 try-catch, 互不影响;
 *    自检失败时仅跳过源头拦截, 窗口守卫仍生效。
 * 3. 误拦截其他窗口: 守卫用正则精确匹配 screensaver.html, 且监听
 *    did-start-loading (browser-window-created 时 URL 可能尚未加载)。
 * 4. 护眼模式兼容: 配置关闭时完全透传原 onMessage, 原逻辑中的
 *    eyeProtectionMode === "pause" 检查保留不变, 两者互不干扰。
 */

const { withRetry, getPrototypeMethod, resolveModule } = require("./retryHook");

const isScreensaverManager = (value) => {
  const onMessage = getPrototypeMethod(value, "onMessage");
  return Boolean(
    value &&
      typeof value.onMessage === "function" &&
      typeof value.startScreensaver === "function" &&
      typeof value.stopScreensaver === "function" &&
      typeof onMessage === "function" &&
      String(onMessage).includes("screensaverTransitionList")
  );
};

const resolveScreensaverManager = (central) => {
  const preferred = resolveModule(central, 121);
  if (isScreensaverManager(preferred)) return preferred;

  // Module IDs are build-specific. Search webpack's module table by the
  // stable method characteristic before executing a candidate factory.
  const table = central && central.m;
  if (table && typeof table === "object") {
    for (const [id, factory] of Object.entries(table)) {
      if (id === "121" || typeof factory !== "function") continue;
      if (!String(factory).includes("screensaverTransitionList")) continue;
      const candidate = resolveModule(central, Number(id));
      if (isScreensaverManager(candidate)) return candidate;
    }
  }
  return null;
};

const hookFn = (central) => {
  const readConfig = () => {
    try {
      const mgr = global.__HUGO_AURA_CONFIG_MGR__;
      if (!mgr) return null;
      return mgr.loadConfig();
    } catch (err) {
      console.error("[HugoAura / Screensaver / Error] Failed to read config:", err);
      return null;
    }
  };

  const shouldDisable = () => {
    const config = readConfig();
    return Boolean(config && config.auraSettings && config.auraSettings.disableScreenSaver);
  };

  // 保存原始 stopScreensaver 引用, 供拦截后主动上报使用
  let originalStopScreensaver = null;
  // 防止多条屏保消息触发重复上报
  let resetReportPending = false;
  // 自检失败诊断日志: 只记录一次
  let diagLogged = false;

  // >>> 风险2: 源头拦截 (独立 try-catch, 不影响窗口守卫) <<< //
  // 懒加载容错: 模块未就绪时延迟重试, 直到就绪或放弃
  const tryInstallSource = () => {
    // 先取模块导出; 若 central 返回的是未执行工厂, resolveModule 会兜底执行
    const screensaver = resolveScreensaverManager(central);

    // 运行时自检: 确认定位到的模块确实是屏保管理器。
    if (!isScreensaverManager(screensaver)) {
      if (!diagLogged) {
        diagLogged = true;
        const proto = screensaver ? Object.getPrototypeOf(screensaver) : null;
        console.warn(
          `[HugoAura / Screensaver] Screensaver manager self-check failed. ` +
            `typeof(screensaver)=${typeof screensaver}, ` +
            `onMessage=${screensaver && typeof screensaver.onMessage}, ` +
            `startScreensaver=${screensaver && typeof screensaver.startScreensaver}, ` +
            `stopScreensaver=${screensaver && typeof screensaver.stopScreensaver}, ` +
            `proto.onMessage=${proto && typeof proto.onMessage}, ` +
            `moduleTable=${!!(central.m && central.c)}`
        );
      }
      console.debug(
        "[HugoAura / Screensaver] Screensaver manager not ready, retrying..."
      );
      return false;
    }

    originalStopScreensaver = screensaver.stopScreensaver.bind(screensaver);

    const originalOnMessage = screensaver.onMessage.bind(screensaver);
    screensaver.onMessage = (e) => {
      if (shouldDisable() && e && e.url === "/displayScreenSaver") {
        console.debug("[HugoAura / Screensaver] Blocked screen saver trigger message.");
        // 风险1: 主动上报 "屏保已关闭", 避免集控侧状态卡死
        // stopScreensaver 会执行: closeWindow(无窗口,无操作) + share(null) + 上报 reset + outQueue
        if (!resetReportPending) {
          resetReportPending = true;
          setTimeout(() => {
            try {
              originalStopScreensaver();
              console.debug("[HugoAura / Screensaver] Reported screen saver reset to controller.");
            } catch (err) {
              console.error("[HugoAura / Screensaver] Failed to report reset:", err);
            } finally {
              resetReportPending = false;
            }
          }, 100);
        }
        return;
      }
      // 风险4: 配置关闭时完全透传, 原逻辑中的护眼模式检查保留
      originalOnMessage(e);
    };

    const originalStartScreensaver = screensaver.startScreensaver.bind(screensaver);
    screensaver.startScreensaver = () => {
      if (shouldDisable()) {
        console.debug("[HugoAura / Screensaver] Blocked startScreensaver.");
        return;
      }
      originalStartScreensaver();
    };

    console.log("[HugoAura / Screensaver] Source interception installed.");
    return true;
  };

  withRetry(tryInstallSource, { label: "ScreensaverSource" })();

  // 最终兜底: 屏保任务最终通过窗口管理器创建 "screensaver" 窗口。
  // 这样即使触发路径绕过管理器 onMessage/startScreensaver，也不会显示屏保。
  try {
    const windowManager = resolveModule(central, 20);
    if (windowManager && typeof windowManager.newWindow === "function") {
      const originalNewWindow = windowManager.newWindow.bind(windowManager);
      windowManager.newWindow = (windowName, ...args) => {
        if (shouldDisable() && windowName === "screensaver") {
          console.debug(
            "[HugoAura / Screensaver] Blocked screensaver window creation."
          );
          return null;
        }
        return originalNewWindow(windowName, ...args);
      };
      console.log("[HugoAura / Screensaver] Window creation interception installed.");
    }
  } catch (err) {
    console.error(
      "[HugoAura / Screensaver / WindowHook / Error] Failed to install:",
      err
    );
  }

  // >>> 窗口守卫 (独立 try-catch, 版本无关兜底) <<< //
  try {
    const electron = central(1);
    const app = electron && electron.app;
    if (app && typeof app.on === "function") {
      // 风险3: 精确匹配 screensaver.html, 避免误伤其他窗口
      const isScreensaverUrl = (url) => {
        return (
          typeof url === "string" &&
          /(?:^|[\\/])screensaver(?:\.html)?(?:[?#/]|$)/i.test(url)
        );
      };

      const destroyIfScreensaver = (browserWindow) => {
        if (!browserWindow || browserWindow.isDestroyed()) return false;
        const wc = browserWindow.webContents;
        if (!wc) return false;
        try {
          const url = wc.getURL();
          if (isScreensaverUrl(url)) {
            browserWindow.destroy();
            console.log("[HugoAura / Screensaver] Screen saver window destroyed by guard.");
            // 风险1: 守卫销毁后也上报重置
            if (originalStopScreensaver) {
              try { originalStopScreensaver(); } catch {}
            }
            return true;
          }
        } catch {}
        return false;
      };

      const guard = (_event, browserWindow) => {
        if (!shouldDisable()) return;
        // 窗口刚创建时 URL 可能尚未加载, 立即检查一次 + 监听 did-start-loading
        if (destroyIfScreensaver(browserWindow)) return;
        const wc = browserWindow && browserWindow.webContents;
        if (wc && typeof wc.once === "function") {
          wc.once("did-start-loading", () => {
            if (shouldDisable()) destroyIfScreensaver(browserWindow);
          });
        }
      };
      app.on("browser-window-created", guard);
      console.log("[HugoAura / Screensaver] Window guard installed.");
    }
  } catch (err) {
    console.error("[HugoAura / Screensaver / Guard / Error]", err);
  }
};

module.exports = { hookFunc: hookFn };
