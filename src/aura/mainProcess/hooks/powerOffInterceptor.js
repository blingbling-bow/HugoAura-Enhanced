// @ts-check

/**
 * 远程关机指令拦截 (Power-Off Interceptor)
 *
 * 原理: 希沃管家通过 WS 连接接收云端下发的关机指令:
 *   模块 390 (proxyWebsocketHost) 的 onMessage → 分发到模块 128,
 *   命中 e.url === "/powerOff/confirm" 后弹倒计时并执行关机。
 *
 * 本钩子通过共享蹦床 (installWsInterceptor) 在模块 390/399 的 onMessage
 * 入口处拦截, 在指令分发到执行模块前处理:
 *   1. block 模式: 直接吞掉关机指令, 设备不会被远程关机。
 *   2. notify 模式: 延迟 10 秒放行指令, 弹窗提醒用户。
 *   3. 审计日志写入 cloudCommandAudit.log (复用云端指令审计通道)。
 *
 * 拦截机制说明: WS 基类 (模块 18) 的 create() 会把 onMessage 一次性解构
 * 进事件闭包, 事后包装实例属性无效 — 因此必须使用共享蹦床 + 断线重连
 * 激活 (详见 retryHook.js installWsInterceptor)。
 */

const { withRetry, installWsInterceptor } = require("./retryHook");
const auditWriter = require("./auditWriter");

// 关机指令匹配规则
const POWER_OFF_RULES = ["/powerOff/confirm"];

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
    return {
      mode: cfg.mode === "notify" ? "notify" : "block",
    };
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

  // 拦截处理函数工厂: 按入口绑定渠道与来源标识
  const makeHandler = (label, getSource) => (parsed) => {
    const cfg = getInterceptConfig();
    if (!cfg) return false;

    const url = parsed && parsed.url;
    if (!isPowerOffUrl(url)) return false;

    const source = getSource();
    const ts = new Date().toISOString();
    const record = {
      ts,
      source,
      channel: label,
      url,
      action: cfg.mode === "block" ? "blocked" : "captured",
      data: parsed && parsed.data !== undefined ? parsed.data : null,
      _logType: "powerOff",
    };
    writeAudit(record);
    pushAuditEvent(record);
    pushPowerOffNotify(record);

    if (cfg.mode === "block") {
      console.log(
        `[HugoAura / PowerOff] Blocked remote power-off from ${source}`
      );
      return true; // 吞掉指令, 设备不会被关机
    }

    // notify 模式: 延迟 10 秒后放行, 给用户保存工作的时间
    console.log(
      `[HugoAura / PowerOff] Remote power-off detected, delaying 10s before dispatch (notify mode)`
    );
    return { delay: 10000 };
  };

  const getWsSource = (key) => {
    try {
      const cfg = central(0);
      const host = cfg && cfg[key];
      return host && host.ip ? `${host.ip}${host.url || ""}` : "unknown";
    } catch (err) {
      return "unknown";
    }
  };

  // 入口 1: hugoServiceWebsocket WS (模块 399, 兜底覆盖)
  withRetry(
    () =>
      installWsInterceptor(
        central,
        399,
        "hugoServiceWebsocket",
        makeHandler(
          "hugoServiceWebsocket",
          () => getWsSource("hugoServiceWebsocket")
        )
      ),
    { label: "PowerOff(399)" }
  )();

  // 入口 2: proxyWebsocketHost WS (模块 390, /powerOff/confirm 实际入口)
  withRetry(
    () =>
      installWsInterceptor(
        central,
        390,
        "proxyWebsocketHost",
        makeHandler(
          "proxyWebsocketHost",
          () => getWsSource("proxyWebsocketHost")
        )
      ),
    { label: "PowerOff(390)" }
  )();
};

module.exports = { hookFunc: hookFn };
