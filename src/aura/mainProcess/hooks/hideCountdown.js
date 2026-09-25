// @ts-check

/**
 * 隐藏倒计日组件 (Hide Countdown Days) 主进程钩子
 *
 * 目标: 集控下发的「倒计日」卡片 —— 窗口名 "countdown", 由 public/countdown.js
 * 渲染, 界面文案为标题「倒计日」+「距离<事件>仅有 N 天」。它不是按秒的倒计时,
 * 而是按天递减的倒计日, 由云端通过 messageType 1004 下发。
 *
 * 原理: 倒计日由独立窗口 ("countdown") 承载,
 * 消息处理器 (模块 132, 单例) 监听 WS 消息:
 *   messageType === 1004 (GET_COUNTDOWN_MES):
 *     - e.data.vaildType === 1 -> 创建/刷新 countdown 窗口
 *     - 否则                   -> 关闭 countdown 窗口
 *
 * 本钩子的行为 (只隐藏, 不吞指令):
 *   1. 指令照常交给原生处理器 —— 原生状态 (message / getCountdownMessage 等)
 *      与数据完整保留, 不做任何"拦截丢弃"。
 *   2. 开关启用时, 在原生处理完之后立刻收掉卡片窗口, 屏上不显示。
 *   3. 开关由开变关时, 若云端最后一次下发的是"显示"(vaildType === 1), 立即按原生
 *      流程把卡片补回来 —— 隐藏可逆, 不会出现"隐藏过就再也打不开"。
 *
 * 其他消息类型完全不介入, 不影响 bellRinging 等其他组件。
 * 版本容错: 自检失败时优雅降级, 仅打印诊断日志。
 */

const { withRetry, getPrototypeMethod, resolveModule } = require("./retryHook");

const COUNTDOWN_MESSAGE_TYPE = 1004; // GET_COUNTDOWN_MES
const VALID_TYPE_SHOW = 1; // vaildType === 1 表示云端要求显示卡片

const hookFn = (central) => {
  let diagLogged = false;

  // 安装成功后的处理器与原生方法引用 (还原卡片时复用)
  let installed = null;
  // 云端最后一次下发的倒计日指令, 用于判断"现在是否应该显示卡片"
  let lastCommand = null;
  // 当前是否处于"被本钩子隐藏"的状态: 仅开 -> 关的切换需要还原
  let hiding = false;

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

  /** 开关由开变关: 云端若要求显示卡片, 就按原生流程把它补回来 */
  const restoreCountdown = () => {
    if (!installed || !lastCommand || !lastCommand.wantsShow) return;
    try {
      installed.originalOnMessage({
        messageType: COUNTDOWN_MESSAGE_TYPE,
        data: lastCommand.data,
      });
      console.log(
        "[HugoAura / HideCountdown] Restored countdown-day card (hide disabled)."
      );
    } catch (err) {
      console.warn("[HugoAura / HideCountdown] Failed to restore card:", err);
    }
  };

  // 配置变更: 打开则收掉卡片, 关闭则还原该显示的卡片
  const onConfigRefresh = () => {
    if (shouldHide()) {
      hiding = true;
      closeCountdownWindow();
      return;
    }
    if (!hiding) return;
    hiding = false;
    restoreCountdown();
  };

  // 单次安装尝试: 成功返回 true, 模块未就绪返回 false (触发重试)
  const tryInstall = () => {
    const handler = resolveModule(central, 132);

    // 运行时自检: 确认模块 132 是倒计日消息处理器 (版本容错)
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
          `[HugoAura / HideCountdown] Module 132 self-check failed. ` +
            `typeof(handler)=${typeof handler}, ` +
            `onMessage=${handler && typeof handler.onMessage}`
        );
      }
      console.debug(
        "[HugoAura / HideCountdown] Module 132 not ready, retrying..."
      );
      return false;
    }

    const originalOnMessage = handler.onMessage.bind(handler);
    handler.onMessage = (e) => {
      if (!e || e.messageType !== COUNTDOWN_MESSAGE_TYPE) {
        // 其他消息完全不介入
        originalOnMessage(e);
        return;
      }

      // 记录云端意图 (1 = 显示, 其他 = 关闭), 供开关关闭时还原
      lastCommand = {
        data: e.data,
        wantsShow: Boolean(e.data && e.data.vaildType === VALID_TYPE_SHOW),
      };

      // 指令不吞: 原生照常处理, 状态 / 数据 / 窗口创建全部保留
      originalOnMessage(e);

      // 开关启用时再把卡片收掉: 窗口刚被同步创建出来, 同一个 tick 内销毁
      if (shouldHide()) {
        hiding = true;
        closeCountdownWindow();
        console.log(
          "[HugoAura / HideCountdown] Hid countdown-day card (messageType 1004)."
        );
      }
    };

    installed = { handler, originalOnMessage };

    console.log(
      "[HugoAura / HideCountdown] Source interception installed (module 132)."
    );
    return true;
  };

  // 懒加载容错: 模块未就绪时延迟重试
  withRetry(tryInstall, { label: "HideCountdown" })();

  try {
    const eventBus = global.__HUGO_AURA_EVENT_BUS__;
    if (eventBus && typeof eventBus.on === "function") {
      eventBus.on("$aura.config.refreshConfig", onConfigRefresh);
    }
    // 启动时开关就是打开的: 先进入隐藏态, 并收掉可能已在屏上的卡片
    if (shouldHide()) {
      hiding = true;
      closeCountdownWindow();
    }
  } catch (err) {
    console.warn(
      "[HugoAura / HideCountdown] Failed to register config listener:",
      err
    );
  }
};

module.exports = { hookFunc: hookFn };
