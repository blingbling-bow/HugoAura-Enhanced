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
 * 本钩子包装模块 394 的 onMessage, 在配置启用时吞掉
 * /serviceUpgrade/status 与 /serviceUpgrade/feedback 消息,
 * 使前端永远收不到"有更新"状态, 不显示升级入口与升级进度。
 * (网络层兜底见 jsRewrite/network/disableAppUpdate.js,
 *  负责拦截 upgradeLastVersion 升级触发请求。)
 *
 * 版本容错: 模块号 (394) 为构建相关的快路径; 失配时按工厂源码中的
 * /serviceUpgrade/status 特征扫描重新定位 (该 URL 全包仅此一处)。
 * 自检始终失败时优雅降级, 不影响 /disableCover 等其他消息。
 */

const {
  withRetry,
  getPrototypeMethod,
  resolveModule,
  resolveByScan,
  shouldScan,
} = require("./retryHook");

const hookFn = (central) => {
  // 自检失败诊断日志: 只记录一次
  let diagLogged = false;
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

  // 单次安装尝试: 成功返回 true, 模块未就绪返回 false (触发重试)
  const tryInstall = () => {
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
          console.debug(
            `[HugoAura / DisableUpdate] Blocked upgrade message: ${e.url}`
          );
          return;
        }
      }
      // /disableCover 等其他消息正常透传
      originalOnMessage(e);
    };

    console.log("[HugoAura / DisableUpdate] Source interception installed (module 394).");
    return true;
  };

  // 懒加载容错: 模块未就绪时延迟重试
  withRetry(tryInstall, { label: "DisableUpdate" })();
};

module.exports = { hookFunc: hookFn };
