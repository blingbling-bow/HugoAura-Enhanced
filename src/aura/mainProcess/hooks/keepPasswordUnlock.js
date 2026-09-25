// @ts-check

/**
 * 联网时保留密码解锁 (Keep Password Unlock) 主进程钩子
 *
 * 背景: 集控 (云端) 有「联网时禁用密码解锁」策略 —— 设备联网时, 锁屏上的
 * 「密码」解锁页签被隐藏, 只留「扫码 / 激活码」。其实现链路:
 *
 *   模块 399 (hugoServiceWebsocket).onMessage
 *     → JSON.parse → w.onMessage(t)      [w = 模块 137, 解锁方式策略处理器]
 *   模块 137.onMessage: messageType === 1214 且 data.unlockMode === 1
 *     → 数据总线 (模块 2).share("hasNetworkHidePasswordBlock", true)
 *     (否则 share 同一个键为 false)
 *
 * 渲染层: public/vendor.js 的锁屏认证组件 (public/screenLock.js 以
 *   actionType = { normal: 1, admin: 3 } 引用它) 注册该键:
 *   loadHasNetworkHidePasswordBlock(true)  → 从解锁方式列表中摘掉「密码」页签
 *   loadHasNetworkHidePasswordBlock(false) → 扫码 / 激活码 / 密码 三种都保留
 *
 * 本钩子包装模块 137 的 onMessage: 开关启用时, messageType 1214 一律就地处理 ——
 * 只把 "hasNetworkHidePasswordBlock" 共享为 false, 不交回原生, 因此不管集控下发
 * 的 unlockMode 是 1 还是 0, 锁屏上的「密码」解锁都会保留; 开关关闭时完全透传,
 * 与原生行为一致。messageType 1212 (qrcodeFeeedback) 等其他消息一律原样透传。
 *
 * 注意: 集控锁屏的 admin 模式 (模块 33 依据锁屏指令 mode === "admin" 建窗,
 * actionType = 3) 由渲染层另行隐藏密码页签, 属该锁屏方式的固有设计, 与本钩子
 * 无关, 不受影响。
 *
 * 为什么包装模块 137 而不是 WS 客户端 (模块 399):
 *   模块 399 的分发器以 `w.onMessage(t)` 形式在调用时做属性查找, 因此替换
 *   模块 137 实例的 onMessage 即可生效, 不依赖 WS 基类 (模块 18) create()
 *   在连接建立时对 onMessage 的一次性解构, 无时序竞态。
 *
 * 热生效 (config refresh):
 *   hasNetworkHidePasswordBlock 是"全局共享值" (落在 global.SHAREDATA._default),
 *   锁屏窗口创建时由 public/preLoad.js 从 SHAREDATA 读初值。若开关是在集控策略
 *   下发之后才被打开, 旧值 true 会一直残留到下一次策略下发, 表现为"开了也没用"。
 *   因此开关打开时 (含钩子安装时开关已打开) 主动补发一次 false 复位该键。
 *
 * fail-soft: 数据总线不可用时不做半截拦截 (不吞消息), 直接交回原生 —— 宁可行为
 * 与原生一致, 也不出现"消息被吞掉、共享值却没更新"的中间态。
 * 版本容错: 自检失败时优雅降级, 仅打印诊断日志。
 */

const { withRetry, getPrototypeMethod, resolveModule } = require("./retryHook");

// 解锁方式策略处理器 (messageType 1214 / 1212), 由模块 399 分发调用
const PASSWORD_POLICY_HANDLER_ID = 137;
// 数据总线 (share / getData / setData), 全局共享值的出口
const DATA_BUS_ID = 2;
// 集控下发解锁方式策略的 messageType
const UNLOCK_MODE_MESSAGE_TYPE = 1214;
// 渲染层据此隐藏「密码」解锁页签的共享键
const PASSWORD_BLOCK_KEY = "hasNetworkHidePasswordBlock";

const hookFn = (central) => {
  let diagLogged = false;
  /** 安装成功时缓存的数据总线实例 (模块 2) */
  let dataBus = null;

  const readConfig = () => {
    try {
      const mgr = global.__HUGO_AURA_CONFIG_MGR__;
      if (!mgr) return null;
      return mgr.loadConfig();
    } catch (err) {
      console.error(
        "[HugoAura / KeepPasswordUnlock / Error] Failed to read config:",
        err
      );
      return null;
    }
  };

  const isEnabled = () => {
    const config = readConfig();
    const cfg =
      config &&
      config.networkRewrite &&
      config.networkRewrite["appearance/keepPasswordUnlock"];
    return Boolean(cfg && cfg.enabled);
  };

  /**
   * 把「联网隐藏密码解锁」共享键复位为 false (幂等)
   * @returns {boolean} 数据总线可用且已复位
   */
  const clearPasswordBlockFlag = () => {
    try {
      if (!dataBus || typeof dataBus.share !== "function") {
        throw new Error("data bus is not available");
      }
      dataBus.share(PASSWORD_BLOCK_KEY, false);
      return true;
    } catch (err) {
      console.error(
        "[HugoAura / KeepPasswordUnlock] Failed to reset the password-block flag:",
        err
      );
      return false;
    }
  };

  // 配置热更新: 打开开关时立刻复位全局共享值, 消除上一次策略留下的 true
  const onConfigRefresh = () => {
    if (!dataBus) return; // 钩子尚未安装: 安装时会自行复位
    if (!isEnabled()) return;
    if (clearPasswordBlockFlag()) {
      console.log(
        "[HugoAura / KeepPasswordUnlock] Password-block flag reset, password unlock stays available."
      );
    }
  };

  // 仅接管解锁方式策略 (messageType 1214)
  const isUnlockModePolicy = (parsed) =>
    !!parsed && parsed.messageType === UNLOCK_MODE_MESSAGE_TYPE;

  // 单次安装尝试: 成功返回 true, 模块未就绪返回 false (触发重试)
  const tryInstall = () => {
    const handler = resolveModule(central, PASSWORD_POLICY_HANDLER_ID);
    const bus = resolveModule(central, DATA_BUS_ID);

    // 运行时自检: 源码特征匹配 (该处理器是本键唯一的写入方, 见文件头链路说明),
    // 失败即认为模块编号假设失效, 优雅降级不挂钩子。
    const unboundOnMessage = getPrototypeMethod(handler, "onMessage");
    const sourceMatched = !!(
      unboundOnMessage && String(unboundOnMessage).includes(PASSWORD_BLOCK_KEY)
    );
    const isPasswordPolicyHandler =
      handler &&
      typeof handler.onMessage === "function" &&
      sourceMatched;
    const isDataBus =
      bus && typeof bus.share === "function" && typeof bus.getData === "function";

    if (!isPasswordPolicyHandler || !isDataBus) {
      if (!diagLogged) {
        diagLogged = true;
        console.warn(
          `[HugoAura / KeepPasswordUnlock] Self-check failed. ` +
            `module ${PASSWORD_POLICY_HANDLER_ID}: onMessage=${handler && typeof handler.onMessage}, ` +
            `sourceMatched=${sourceMatched}; ` +
            `module ${DATA_BUS_ID}: share=${bus && typeof bus.share}`
        );
      }
      console.debug(
        "[HugoAura / KeepPasswordUnlock] Modules not ready, retrying..."
      );
      return false;
    }

    dataBus = bus;
    const originalOnMessage = handler.onMessage.bind(handler);

    // 模块 399 的分发器取实例属性调用, 替换到位即全部命中
    handler.onMessage = (e) => {
      let parsed = e;
      try {
        if (typeof e === "string") parsed = JSON.parse(e);
      } catch (err) {
        parsed = null;
      }

      if (isEnabled() && isUnlockModePolicy(parsed)) {
        // 只接管 1214: 复位共享键后不交回原生, 原生也就不会把它置回 true
        if (clearPasswordBlockFlag()) {
          const mode = parsed.data ? parsed.data.unlockMode : undefined;
          console.log(
            `[HugoAura / KeepPasswordUnlock] Kept password unlock available ` +
              `(messageType ${UNLOCK_MODE_MESSAGE_TYPE}, unlockMode=${mode === undefined ? "unknown" : mode}).`
          );
          return;
        }
        console.warn(
          "[HugoAura / KeepPasswordUnlock] Flag reset failed, handing the message back to the native handler (fail-soft)."
        );
      }

      return originalOnMessage(e);
    };

    // 钩子晚于策略下发的场景: 安装时开关已打开则补发一次复位
    if (isEnabled()) clearPasswordBlockFlag();

    console.log(
      `[HugoAura / KeepPasswordUnlock] Source interception installed (module ${PASSWORD_POLICY_HANDLER_ID}).`
    );
    return true;
  };

  // 懒加载容错: 模块未就绪时延迟重试
  withRetry(tryInstall, { label: "KeepPasswordUnlock" })();

  try {
    const eventBus = global.__HUGO_AURA_EVENT_BUS__;
    if (eventBus && typeof eventBus.on === "function") {
      eventBus.on("$aura.config.refreshConfig", onConfigRefresh);
    }
  } catch (err) {
    console.warn(
      "[HugoAura / KeepPasswordUnlock] Failed to register config listener:",
      err
    );
  }
};

module.exports = { hookFunc: hookFn };