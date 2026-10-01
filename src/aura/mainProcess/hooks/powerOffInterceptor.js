// @ts-check

/**
 * 远程关机指令拦截 (Power-Off Interceptor)
 *
 * 原理: 希沃管家通过 proxyWebsocketHost (模块 390) 接收云端集控下发的关机指令,
 * 分发到关机指令处理器 (模块 128, 单例):
 *   模块 390.onMessage → JSON.parse → r.onMessage(t)   [r = 模块 128]
 *   模块 128.onMessage 命中 e.url === "/powerOff/confirm" 后弹出 10 秒倒计时
 *   对话框, 确认后执行 `shutdown -s -f -t 0`。
 *
 * 本钩子包装模块 128 的 onMessage:
 *   1. 直接吞掉关机指令, 设备不会被远程关机 (不提供"仅提醒"放行模式)。
 *   2. 审计日志写入 cloudCommandAudit.log (复用云端指令审计通道)。
 *
 * 为什么包装模块 128 而不是 WS 客户端 (模块 390):
 *   分发器以 `r.onMessage(t)` 形式在**调用时**做属性查找, 因此替换模块 128
 *   实例的 onMessage 即刻生效; 不依赖 WS 基类 (模块 18) create() 在建连时
 *   对 onMessage 的一次性解构, 无时序竞态, 也不受"WS 何时连上"影响。
 *   包装 handler 还能天然覆盖所有调用来源 (其它分发器 / 本地 IPC), 而包装
 *   WS 客户端只能覆盖那一条通道。
 *
 * 旧实现的问题 (教训, 勿回退):
 *   早期版本用 installWsInterceptor 包装 WS 客户端自身的 onMessage, 依赖
 *   "主动断线重连"让 create() 重新捕获蹦床。真机日志显示该路径的 390/399
 *   两个入口在 30 次重试后全部 "Gave up ... hook skipped", 拦截从未生效;
 *   而同一份日志中直接包装 handler 的锁屏拦截没有该问题。
 *
 * 版本容错: 模块号 (128) 为构建相关的快路径, 失败时按工厂源码中的
 * "/powerOff/confirm" 特征扫描 webpack 模块表兜底; 两者都失败时优雅降级,
 * 仅打印诊断日志, 不干扰管家原有行为。
 */

const {
  withRetry,
  getPrototypeMethod,
  resolveModule,
  resolveByScan,
  shouldScan,
} = require("./retryHook");
const auditWriter = require("./auditWriter");
const alertWindow = require("./alertWindow");

// 关机指令匹配规则
const POWER_OFF_RULES = ["/powerOff/confirm"];

// 关机指令处理器模块号 (构建相关, 仅作快路径, 失败时回退源码特征扫描)
const POWER_OFF_HANDLER_ID = 128;

const hookFn = (central) => {
  const electron = central(1);

  // 复用云端指令审计通道: 推送到渲染层指令审计页面
  const pushAuditEvent = (record) => {
    try {
      if (
        electron &&
        electron.ipcMain &&
        typeof electron.ipcMain.send === "function"
      ) {
        electron.ipcMain.send("*", "$aura.audit.onLog", { record });
      }
    } catch (err) {
      console.error("[HugoAura / PowerOff / Audit / Push Error]", err);
    }
  };

  // 关机拦截弹窗通知: 推送到渲染层
  const pushPowerOffNotify = (record) => {
    try {
      if (
        electron &&
        electron.ipcMain &&
        typeof electron.ipcMain.send === "function"
      ) {
        electron.ipcMain.send("*", "$aura.powerOff.onBlocked", { record });
      }
    } catch (err) {
      console.error("[HugoAura / PowerOff / Notify Error]", err);
    }
  };

  const readConfig = () => {
    try {
      const mgr = global.__HUGO_AURA_CONFIG_MGR__;
      if (!mgr) return null;
      return mgr.loadConfig();
    } catch (err) {
      console.error("[HugoAura / PowerOff / Error] Failed to read config:", err);
      return null;
    }
  };

  const getInterceptConfig = () => {
    const config = readConfig();
    const cfg =
      config && config.auraSettings && config.auraSettings.powerOffIntercept;
    if (!cfg || !cfg.enabled) return null;
    // 只有"阻止"一种行为: 开启即吞掉指令, 不再提供仅提醒的放行模式
    return { enabled: true };
  };

  const isPowerOffUrl = (url) => {
    if (typeof url !== "string" || url.length === 0) return false;
    return POWER_OFF_RULES.some((rule) => url.includes(rule));
  };

  // 审计日志: 复用 cloudCommandAudit.log (写入与轮转统一交给共享写入器,
  // 避免与 cloudUpdateInterceptor / lockScreenInterceptor 的句柄互相打架)
  const AUDIT_FILE = "cloudCommandAudit.log";
  const writeAudit = (record) => {
    auditWriter.writeAudit(AUDIT_FILE, record);
  };

  const getSource = () => {
    try {
      const cfg = central(0);
      const host = cfg && cfg.proxyWebsocketHost;
      return host && host.ip ? `${host.ip}${host.url || ""}` : "unknown";
    } catch (err) {
      return "unknown";
    }
  };

  /**
   * 运行时自检: 确认定位到的模块确实是"关机指令处理器"。
   * 首选源码特征 —— onMessage 内的关机倒计时文案; 文案变更时退化为
   * "调用了 shutdown + 具备消息缓存方法集" 的结构特征。
   */
  const isPowerOffHandler = (value) => {
    if (!value || typeof value.onMessage !== "function") return false;
    const unboundOnMessage = getPrototypeMethod(value, "onMessage");
    if (typeof unboundOnMessage !== "function") return false;

    const src = String(unboundOnMessage);
    if (src.includes("自动关机")) return true;

    return (
      src.includes("shutdown") &&
      typeof value.pushMessageToWindow === "function" &&
      typeof value.getMessage === "function"
    );
  };

  // 定位关机指令处理器: 模块号 (128) 是构建相关的快路径; 失配时由
  // resolveByScan 按"工厂源码含 /powerOff/confirm"(全包仅此一处) 扫
  // 模块表 / 模块缓存兜底 —— 先源码过滤再执行工厂, 避免为探测触发无关
  // 模块的副作用。
  const resolvePowerOffHandler = () => {
    const preferred = resolveModule(central, POWER_OFF_HANDLER_ID);
    if (isPowerOffHandler(preferred)) return preferred;

    // 扫描有开销 (模块表数百项), 同一入口 3 秒内只扫一次, 被节流时等下次重试
    if (!shouldScan("powerOff")) return null;

    const hit = resolveByScan(central, POWER_OFF_RULES, isPowerOffHandler);
    if (hit) {
      console.warn(
        `[HugoAura / PowerOff] Module ${POWER_OFF_HANDLER_ID} unavailable, ` +
          `recovered via ${hit.how} (module ${hit.id}).`
      );
      return hit.mod;
    }
    return null;
  };

  // 自检失败诊断日志: 只记录一次
  let diagLogged = false;

  // 单次安装尝试: 成功返回 true, 模块未就绪返回 false (触发重试)
  const tryInstall = () => {
    const handler = resolvePowerOffHandler();

    if (!isPowerOffHandler(handler)) {
      if (!diagLogged) {
        diagLogged = true;
        console.warn(
          `[HugoAura / PowerOff] Handler self-check failed. ` +
            `typeof(handler)=${typeof handler}, ` +
            `onMessage=${handler && typeof handler.onMessage}, ` +
            `moduleTable=${!!(central.m && central.c)}`
        );
      }
      console.debug("[HugoAura / PowerOff] Handler not ready, retrying...");
      return false;
    }

    const originalOnMessage = handler.onMessage.bind(handler);

    handler.onMessage = (e) => {
      // 分发器 (模块 390) 已做过 JSON.parse, 这里拿到的就是对象;
      // 仍兼容直接传字符串的调用方, 保持与旧实现一致。
      let parsed = e;
      if (typeof e === "string") {
        try {
          parsed = JSON.parse(e);
        } catch (err) {
          parsed = null;
        }
      }

      const cfg = getInterceptConfig();
      if (cfg && isPowerOffUrl(parsed && parsed.url)) {
        const source = getSource();
        const record = {
          ts: new Date().toISOString(),
          source,
          channel: "proxyWebsocketHost",
          url: parsed.url,
          action: "blocked",
          data: parsed && parsed.data !== undefined ? parsed.data : null,
          _logType: "powerOff",
        };
        writeAudit(record);
        pushAuditEvent(record);
        pushPowerOffNotify(record);
        // 兜底: 注入窗口全部不可见时弹独立置顶小窗, 否则提醒会静默丢失
        alertWindow.showAlertWindow(electron, record);

        console.log(
          `[HugoAura / PowerOff] Blocked remote power-off from ${source}`
        );
        return; // 吞掉指令, 设备不会被关机
      }

      // 其余指令 (绑定 / 二维码 / 认证方式等) 原样透传
      return originalOnMessage(e);
    };

    console.log("[HugoAura / PowerOff] Source interception installed (handler module).");
    return true;
  };

  // 懒加载容错: 模块未就绪时延迟重试
  withRetry(tryInstall, { label: "PowerOff" })();
};

module.exports = { hookFunc: hookFn };
