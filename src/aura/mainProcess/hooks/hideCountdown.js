// @ts-check

/**
 * 隐藏倒计时组件 (Hide Countdown) 主进程钩子
 *
 * 原理: 管家的倒计时由独立窗口 ("countdown", 模块 193) 承载,
 * 消息处理器 (模块 131, 单例) 监听 WS 消息:
 *   messageType === 1004 (GET_COUNTDOWN_MES):
 *     - e.data.vaildType === 1 -> 创建/刷新 countdown 窗口
 *     - 否则                   -> 关闭 countdown 窗口
 *
 * 本钩子包装模块 131 的 onMessage: 配置启用时吞掉所有 1004 消息,
 * 并主动关闭已存在的 countdown 窗口, 使倒计时组件永不显示。
 * 其他消息类型正常透传, 不影响 bellRinging 等其他组件。
 *
 * 版本容错: 自检失败时优雅降级, 仅打印诊断日志。
 */

const { withRetry, getPrototypeMethod, resolveModule } = require("./retryHook");

const COUNTDOWN_MESSAGE_TYPE = 1004; // GET_COUNTDOWN_MES

const hookFn = (central) => {
  let diagLogged = false;

  const readConfig = () => {
    try {
      const mgr = global.__HUGO_AURA_CONFIG_MGR__;
      if (!mgr) return null;
      return mgr.loadConfig();
    } catch (err) {
      console.error(
        "[HugoAura / HideCountdown / Error] Failed to read config:",
        err
      );
      return null;
    }
  };

  const shouldHide = () => {
    const config = readConfig();
    return Boolean(
      config &&
        config.networkRewrite &&
        config.networkRewrite["appearance/hideCountdown"] &&
        config.networkRewrite["appearance/hideCountdown"].enabled
    );
  };

  /** 主动关闭已存在的 countdown 窗口 (模块 3 为窗口管理器) */
  const closeCountdownWindow = () => {
    try {
      const windowMgr = resolveModule(central, 3);
      if (
        windowMgr &&
        typeof windowMgr.checkWindowExist === "function" &&
        typeof windowMgr.close === "function" &&
        windowMgr.checkWindowExist("countdown")
      ) {
        windowMgr.close("countdown");
        console.debug("[HugoAura / HideCountdown] Closed countdown window.");
      }
    } catch (err) {
      console.warn(
        "[HugoAura / HideCountdown] Failed to close countdown window:",
        err
      );
    }
  };

  // 单次安装尝试: 成功返回 true, 模块未就绪返回 false (触发重试)
  const tryInstall = () => {
    const handler = resolveModule(central, 131);

    // 运行时自检: 确认模块 131 是倒计时消息处理器 (版本容错)
    const unboundOnMessage = getPrototypeMethod(handler, "onMessage");
    const isCountdownHandler =
      handler &&
      typeof handler.onMessage === "function" &&
      typeof unboundOnMessage === "function" &&
      String(unboundOnMessage).includes("GET_COUNTDOWN_MES");

    if (!isCountdownHandler) {
      if (!diagLogged) {
        diagLogged = true;
        console.warn(
          `[HugoAura / HideCountdown] Module 131 self-check failed. ` +
            `typeof(handler)=${typeof handler}, ` +
            `onMessage=${handler && typeof handler.onMessage}`
        );
      }
      console.debug(
        "[HugoAura / HideCountdown] Module 131 not ready, retrying..."
      );
      return false;
    }

    const originalOnMessage = handler.onMessage.bind(handler);
    handler.onMessage = (e) => {
      if (shouldHide() && e && e.messageType === COUNTDOWN_MESSAGE_TYPE) {
        // 吞掉倒计时消息, 并关闭可能已显示的窗口
        closeCountdownWindow();
        return;
      }
      // 其他消息正常透传
      originalOnMessage(e);
    };

    console.log(
      "[HugoAura / HideCountdown] Source interception installed (module 131)."
    );
    return true;
  };

  // 懒加载容错: 模块未就绪时延迟重试
  withRetry(tryInstall, { label: "HideCountdown" })();
};

module.exports = { hookFunc: hookFn };
