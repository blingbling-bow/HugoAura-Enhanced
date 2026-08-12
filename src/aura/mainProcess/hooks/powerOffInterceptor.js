// @ts-check

/**
 * 远程关机指令拦截 (Power-Off Interceptor)
 *
 * 原理: 希沃管家通过 WS 连接接收云端下发的关机/重启指令:
 *   /powerOff/confirm — 远程关机确认
 *
 * 本钩子在 WS 客户端 (模块 399/390) 的 onMessage 处包装,
 * 在指令分发到执行模块前拦截:
 *   1. block 模式: 直接吞掉关机指令, 设备不会被远程关机。
 *   2. notify 模式: 放行指令但弹窗提醒用户。
 *   3. 审计日志写入 cloudCommandAudit.log (复用云端指令审计通道)。
 *
 * 与 cloudUpdateInterceptor 共存: 各自独立包装 onMessage, 互不影响。
 */

const path = require("path");
const fs = require("fs");

const { withRetry, getPrototypeMethod, resolveModule } = require("./retryHook");

// 关机指令匹配规则
const POWER_OFF_RULES = ["/powerOff/confirm"];

const hookFn = (central) => {
  const electron = central(1);

  const diagLogged = {};

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

  // 审计日志: 复用 cloudCommandAudit.log
  const AUDIT_MAX_SIZE = 5 * 1024 * 1024;
  const auditFilePath = (() => {
    try {
      const auraDir = global.__HUGO_AURA__ && global.__HUGO_AURA__.auraDir;
      if (!auraDir) return null;
      const logDir = path.join(auraDir, "logs");
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      return path.join(logDir, "cloudCommandAudit.log");
    } catch (err) {
      console.error("[HugoAura / PowerOff / Audit / Error]", err);
      return null;
    }
  })();

  let auditStream = auditFilePath
    ? fs.createWriteStream(auditFilePath, { flags: "a" })
    : null;

  const rotateAuditLog = () => {
    try {
      if (!auditFilePath || !auditStream) return;
      auditStream.end();
      const oldFile = auditFilePath + ".old";
      if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
      fs.renameSync(auditFilePath, oldFile);
      auditStream = fs.createWriteStream(auditFilePath, { flags: "a" });
    } catch (err) {
      console.error("[HugoAura / PowerOff / Audit / Rotate Error]", err);
    }
  };

  const writeAudit = (record) => {
    try {
      if (!auditStream || !auditFilePath) return;
      try {
        const stats = fs.statSync(auditFilePath);
        if (stats.size > AUDIT_MAX_SIZE) rotateAuditLog();
      } catch {}
      auditStream.write(JSON.stringify(record) + "\n");
    } catch (err) {
      console.error("[HugoAura / PowerOff / Audit / Write Error]", err);
    }
  };

  const wrapWsClient = (moduleId, label, getSource) => {
    try {
      const client = resolveModule(central, moduleId);

      const unboundOnMessage = getPrototypeMethod(client, "onMessage");
      const isWsClient =
        client &&
        typeof client.onMessage === "function" &&
        typeof client.setHost === "function" &&
        typeof client.sendMessage === "function" &&
        typeof unboundOnMessage === "function" &&
        String(unboundOnMessage).includes("JSON.parse");

      if (!isWsClient) {
        if (!diagLogged[moduleId]) {
          diagLogged[moduleId] = true;
          console.warn(
            `[HugoAura / PowerOff] Module ${moduleId} self-check failed.`
          );
        }
        console.debug(
          `[HugoAura / PowerOff] Module ${moduleId} not ready, retrying...`
        );
        return false;
      }

      // 防止重复包装
      if (client.__auraPowerOffWrapped) return true;

      const originalOnMessage = client.onMessage.bind(client);
      client.onMessage = (rawMsg) => {
        let parsed = null;
        try {
          parsed = JSON.parse(rawMsg);
        } catch (err) {
          return originalOnMessage(rawMsg);
        }

        const cfg = getInterceptConfig();
        if (!cfg) return originalOnMessage(rawMsg);

        const url = parsed && parsed.url;
        const source = getSource();
        const ts = new Date().toISOString();

        if (isPowerOffUrl(url)) {
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
            return; // 吞掉指令, 设备不会被关机
          }

          // notify 模式: 延迟 10 秒后放行, 给用户保存工作的时间
          console.log(
            `[HugoAura / PowerOff] Remote power-off detected, delaying 10s before dispatch (notify mode)`
          );
          setTimeout(() => {
            try {
              originalOnMessage(rawMsg);
            } catch (err) {
              console.error("[HugoAura / PowerOff] Delayed dispatch error:", err);
            }
          }, 10000);
          return; // 不立即放行, 等延迟结束后再分发
        }

        return originalOnMessage(rawMsg);
      };

      client.__auraPowerOffWrapped = true;
      console.log(
        `[HugoAura / PowerOff] Installed on ${label} (module ${moduleId}).`
      );
      return true;
    } catch (err) {
      console.error(`[HugoAura / PowerOff] Failed to wrap ${label}:`, err);
      return false;
    }
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

  withRetry(
    () => wrapWsClient(399, "hugoServiceWebsocket", () =>
      getWsSource("hugoServiceWebsocket")
    ),
    { label: "PowerOff(399)" }
  )();

  withRetry(
    () => wrapWsClient(390, "proxyWebsocketHost", () =>
      getWsSource("proxyWebsocketHost")
    ),
    { label: "PowerOff(390)" }
  )();
};

module.exports = { hookFunc: hookFn };
