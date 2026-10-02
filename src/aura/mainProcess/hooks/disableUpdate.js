// @ts-check

/**
 * 禁止管家更新 (Disable App Update) 主进程钩子
 *
 * 原理: 希沃管家的升级由集控驱动, 链路为:
 *   集控通过代理 WS (模块390, proxyWebsocketHost) 下发:
 *     - /serviceUpgrade/status   -> 模块394 广播 UPGRADE_STATUS
 *       (前端 assistant.js handleGetUpgradeStatus: status===1 时显示"升级"入口)
 *     - /serviceUpgrade/feedback -> 模块394 广播 UPGRADE_FEEDBACK
 *       (前端展示升级进度/失败提示)
 *   用户点击升级入口后, 前端 POST /api/v1/serviceUpgrade/upgradeLastVersion 触发升级。
 *
 * 本钩子分两层拦截:
 *   1. 处理器级: 包装模块 394 的 onMessage, 吞掉 /serviceUpgrade/status 与
 *      /serviceUpgrade/feedback (需 auraSettings.disableUpdate 打开)。
 *   2. 数据总线兜底 (关键): 包装模块 2 (DataBus) 的 share, 把 UPGRADE_STATUS
 *      改写成"已是最新"、UPGRADE_FEEDBACK 改写成"无事发生"。
 *
 * 为什么必须有第 2 层 (真机教训):
 *   第 1 层依赖消息能到达模块 394, 而 WS 层的拦截依赖"主动断线重连让蹦床进入
 *   闭包", 存在时序/通道漏洞 —— 真机日志里同一条 /serviceUpgrade/status 第一次
 *   被拦、第二次漏过。前端的 hasUpdate 只由 DataBus 里的 UPGRADE_STATUS 决定,
 *   所以在 DataBus 层改写状态是唯一与通道、时序都无关的兜底: 无论消息从哪条
 *   通道、什么时机漏进来, 前端拿到的永远是"已是最新"。
 *   开关语义: disableUpdate 或 cloudUpdateIntercept.enabled 任一打开即生效
 *   (两者都表达"不要更新"的意愿), 且运行时读取, 改开关无需重装钩子。
 *
 * 版本容错: 模块号 (394 / 2) 为构建相关的快路径; 失配时按工厂源码特征扫描
 * 重新定位 (394: /serviceUpgrade/status 全包唯一; 2: shareData + publishData)。
 * 自检始终失败时优雅降级, 不影响 /disableCover 等其他消息。
 */

const {
  withRetry,
  getPrototypeMethod,
  resolveModule,
  resolveByScan,
  shouldScan,
} = require("./retryHook");

// 共享数据总线 (DataBus) 模块号: 构建相关的快路径
const DATA_BUS_ID = 2;

const UPGRADE_STATUS_KEY = "UPGRADE_STATUS";
const UPGRADE_FEEDBACK_KEY = "UPGRADE_FEEDBACK";

/**
 * 把"有更新"的状态改写成"已是最新"。
 * 保留其余字段, 只把 latestVersion 拉回 localVersion、status 置 0,
 * 避免破坏前端对该结构的其它用法。
 * @param {any} value 原始 UPGRADE_STATUS 载荷
 */
const sanitizeUpgradeStatus = (value) => {
  if (!value || typeof value !== "object") return { status: 0 };
  const local = typeof value.localVersion === "string" ? value.localVersion : "";
  return {
    ...value,
    latestVersion: local || value.latestVersion,
    status: 0,
  };
};

/**
 * 把升级反馈改写成"无事发生" (前端 upgradeStatus === 0 时不提示任何东西)。
 * @param {any} value 原始 UPGRADE_FEEDBACK 载荷
 */
const sanitizeUpgradeFeedback = (value) =>
  value && typeof value === "object"
    ? { ...value, upgradeStatus: 0 }
    : { upgradeStatus: 0 };

const hookFn = (central) => {
  // 自检失败诊断日志: 每层只记录一次
  let diagLogged = false;
  let busDiagLogged = false;
  let dataBusGuardInstalled = false;
  let handlerHookInstalled = false;

  const readConfig = () => {
    try {
      const mgr = global.__HUGO_AURA_CONFIG_MGR__;
      if (!mgr) return null;
      return mgr.loadConfig();
    } catch (err) {
      console.error("[HugoAura / DisableUpdate / Error] Failed to read config:", err);
      return null;
    }
  };

  const shouldDisable = () => {
    const config = readConfig();
    return Boolean(config && config.auraSettings && config.auraSettings.disableUpdate);
  };

  // 数据总线兜底的开关: 两个开关任一打开都表示"不要更新"
  const shouldSuppressUpgrade = () => {
    const config = readConfig();
    const settings = config && config.auraSettings;
    if (!settings) return false;
    return Boolean(
      settings.disableUpdate ||
        (settings.cloudUpdateIntercept && settings.cloudUpdateIntercept.enabled)
    );
  };

  // 运行时自检: 该模块是否为升级状态分发器 (版本容错)。
  // 特征串 /serviceUpgrade/status 是模块作用域常量, 不在 onMessage 方法体内,
  // 因此改用 onMessage 体内的 UPGRADE_STATUS / UPGRADE_FEEDBACK 确认身份。
  const isUpgradeHandler = (handler) => {
    if (!handler || typeof handler.onMessage !== "function") return false;
    const unbound = getPrototypeMethod(handler, "onMessage");
    if (typeof unbound !== "function") return false;
    const src = String(unbound);
    return src.includes("UPGRADE_STATUS") || src.includes("UPGRADE_FEEDBACK");
  };

  // 运行时自检: 该模块是否为共享数据总线
  const isDataBus = (bus) =>
    Boolean(
      bus &&
        typeof bus.share === "function" &&
        typeof bus.getData === "function" &&
        typeof bus.setData === "function"
    );

  /**
   * 第 2 层: 数据总线兜底。与模块 394 是否定位成功无关, 独立安装。
   * @returns {boolean} 是否安装成功 (失败返回 false, 由重试流程再试)
   */
  const installDataBusGuard = () => {
    let bus = resolveModule(central, DATA_BUS_ID);

    if (!isDataBus(bus) && shouldScan("dataBus")) {
      const recovered = resolveByScan(
        central,
        ["shareData", "publishData"],
        isDataBus
      );
      if (recovered) {
        bus = recovered.mod;
        console.warn(
          `[HugoAura / DisableUpdate] DataBus (module ${DATA_BUS_ID}) unavailable, ` +
            `recovered via ${recovered.how} (module ${recovered.id}).`
        );
      }
    }

    if (!isDataBus(bus)) {
      if (!busDiagLogged) {
        busDiagLogged = true;
        console.warn(
          `[HugoAura / DisableUpdate] DataBus self-check failed. ` +
            `typeof(bus)=${typeof bus}, ` +
            `share=${bus && typeof bus.share}, ` +
            `getData=${bus && typeof bus.getData}, ` +
            `setData=${bus && typeof bus.setData}, ` +
            `moduleTable=${!!(central.m && central.c)}`
        );
      }
      return false;
    }

    if (bus.__auraUpgradeGuard) {
      dataBusGuardInstalled = true;
      return true;
    }

    const originalShare = bus.share.bind(bus);
    bus.share = (typeName, value, windowKey) => {
      if (shouldSuppressUpgrade()) {
        if (typeName === UPGRADE_STATUS_KEY) {
          const sanitized = sanitizeUpgradeStatus(value);
          console.log(
            `[HugoAura / DisableUpdate] Suppressed upgrade status: ` +
              `latestVersion ${value && value.latestVersion} -> ${sanitized.latestVersion}, status -> 0.`
          );
          return originalShare(typeName, sanitized, windowKey);
        }
        if (typeName === UPGRADE_FEEDBACK_KEY) {
          return originalShare(typeName, sanitizeUpgradeFeedback(value), windowKey);
        }
      }
      return originalShare(typeName, value, windowKey);
    };
    bus.__auraUpgradeGuard = true;

    // 清掉本钩子安装前就已经共享出去的"有更新"状态 (会走上面的包装被改写并重新广播)
    try {
      const shared = bus.shareData && bus.shareData._default;
      if (shared && shared[UPGRADE_STATUS_KEY]) {
        bus.share(UPGRADE_STATUS_KEY, shared[UPGRADE_STATUS_KEY]);
      }
    } catch (err) {
      console.error("[HugoAura / DisableUpdate] Failed to reset shared upgrade status:", err);
    }

    dataBusGuardInstalled = true;
    console.log(
      "[HugoAura / DisableUpdate] Upgrade status guard installed (DataBus level)."
    );
    return true;
  };

  // 第 1 层: 处理器级拦截
  const installHandlerHook = () => {
    // 幂等保护: DataBus 未就绪时重试会继续走到这里, 不加保护会把 onMessage
    // 层层包裹 (每层重复判断一遍, 日志也会重复打印)
    if (handlerHookInstalled) return true;

    // 先取模块导出; 若 central 返回的是未执行工厂, resolveModule 会兜底执行
    let messageHandler = resolveModule(central, 394);

    // 模块号失配兜底: 模块 ID 是 webpack 构建产物, 管家换版本即可能漂移;
    // 一旦失配, 单纯重试永远不会成功 (真机日志中的 "Gave up" 多属此类)。
    // 按"工厂源码含 /serviceUpgrade/status"(全包唯一) 重新定位。
    if (!isUpgradeHandler(messageHandler) && shouldScan("disableUpdate")) {
      const recovered = resolveByScan(
        central,
        ["/serviceUpgrade/status"],
        isUpgradeHandler
      );
      if (recovered) {
        messageHandler = recovered.mod;
        console.warn(
          `[HugoAura / DisableUpdate] Module 394 unavailable, ` +
            `recovered via ${recovered.how} (module ${recovered.id}).`
        );
      }
    }

    if (!isUpgradeHandler(messageHandler)) {
      if (!diagLogged) {
        diagLogged = true;
        const proto = Object.getPrototypeOf(messageHandler);
        console.warn(
          `[HugoAura / DisableUpdate] Module 394 self-check failed. ` +
            `typeof(messageHandler)=${typeof messageHandler}, ` +
            `onMessage=${messageHandler && typeof messageHandler.onMessage}, ` +
            `proto.onMessage=${proto && typeof proto.onMessage}, ` +
            `moduleTable=${!!(central.m && central.c)}, ` +
            `tableEntries=${central.m ? Object.keys(central.m).length : 0}, ` +
            `cacheEntries=${central.c ? Object.keys(central.c).length : 0}`
        );
      }
      console.debug(
        "[HugoAura / DisableUpdate] Module 394 not ready, retrying..."
      );
      return false;
    }

    const originalOnMessage = messageHandler.onMessage.bind(messageHandler);
    messageHandler.onMessage = (e) => {
      if (e && e.url) {
        if (
          shouldDisable() &&
          (e.url === "/serviceUpgrade/status" ||
            e.url === "/serviceUpgrade/feedback")
        ) {
          // 用 console.log 而非 debug: 这层是否生效必须能在真机日志里看见
          console.log(
            `[HugoAura / DisableUpdate] Blocked upgrade message: ${e.url}`
          );
          return;
        }
      }
      // /disableCover 等其他消息正常透传
      originalOnMessage(e);
    };

    handlerHookInstalled = true;
    console.log("[HugoAura / DisableUpdate] Source interception installed (module 394).");
    return true;
  };

  // 单次安装尝试: 两层都成功才返回 true; 数据总线兜底独立于模块 394
  const tryInstall = () => {
    // DataBus 与升级处理器可能分别懒加载。不能只看处理器层是否成功，
    // 否则处理器先就绪时 withRetry 会提前结束，DataBus 后续永远不会补装。
    const dataBusReady =
      dataBusGuardInstalled || installDataBusGuard();
    const handlerReady = installHandlerHook();
    return dataBusReady && handlerReady;
  };

  // 懒加载容错: 模块未就绪时延迟重试
  withRetry(tryInstall, { label: "DisableUpdate" })();
};

module.exports = { hookFunc: hookFn };
