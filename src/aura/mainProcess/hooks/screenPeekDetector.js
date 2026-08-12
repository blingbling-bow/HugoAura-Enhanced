// @ts-check

/**
 * 窥屏提醒 (Screen Peek Detector)
 *
 * 原理: 希沃管家通过模块 399/390 的 WS 连接接收云端 /liveclient 指令,
 * 分发到模块 401 启动/停止直播 (即远程屏幕查看)。
 * 本钩子在这两个 WS 入口的 onMessage 处包装:
 *   1. 检测 messageType === "/liveclient" 的指令
 *   2. state === true: 有人发起远程查看屏幕 → IPC 通知渲染层弹窗提醒
 *   3. state === false: 远程查看结束 → IPC 通知渲染层关闭提醒
 *   4. block 模式: 吞掉 state=true 指令, 阻止窥屏
 *   5. 审计日志: 记录窥屏事件到 logs/screenPeekAudit.log
 *
 * 链式兼容: 本钩子与 cloudUpdateInterceptor 可共存, onMessage 包装为
 * 后进先出链式调用, 互不干扰。
 */

const path = require("path");
const fs = require("fs");

const { withRetry, getPrototypeMethod, resolveModule } = require("./retryHook");

const hookFn = (central) => {
  const electron = central(1);

  // 自检失败诊断日志: 每个模块只记录一次 (避免 30 次重试刷屏)
  const diagLogged = {};

  const readConfig = () => {
    try {
      const mgr = global.__HUGO_AURA_CONFIG_MGR__;
      if (!mgr) return null;
      return mgr.loadConfig();
    } catch (err) {
      console.error(
        "[HugoAura / ScreenPeek / Error] Failed to read config:",
        err
      );
      return null;
    }
  };

  const getDetectorConfig = () => {
    const config = readConfig();
    const cfg =
      config && config.auraSettings && config.auraSettings.screenPeekDetector;
    if (!cfg || !cfg.enabled) return null;
    return {
      mode: cfg.mode === "block" ? "block" : "notify",
      logPeekEvents: cfg.logPeekEvents !== false,
    };
  };

  // 审计日志: <auraDir>/logs/screenPeekAudit.log (带轮转, 上限 5MB)
  const AUDIT_MAX_SIZE = 5 * 1024 * 1024;
  const auditFilePath = (() => {
    try {
      const auraDir = global.__HUGO_AURA__ && global.__HUGO_AURA__.auraDir;
      if (!auraDir) return null;
      const logDir = path.join(auraDir, "logs");
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      return path.join(logDir, "screenPeekAudit.log");
    } catch (err) {
      console.error("[HugoAura / ScreenPeek / Audit / Error]", err);
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
      console.log("[HugoAura / ScreenPeek / Audit] Log rotated.");
    } catch (err) {
      console.error("[HugoAura / ScreenPeek / Audit / Rotate Error]", err);
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
      console.error("[HugoAura / ScreenPeek / Audit / Write Error]", err);
    }
  };

  const notifyRenderer = (data) => {
    try {
      if (
        electron &&
        electron.ipcMain &&
        typeof electron.ipcMain.send === "function"
      ) {
        electron.ipcMain.send("*", "$aura.screenPeek.onPeekDetected", data);
      }
    } catch (err) {
      console.error("[HugoAura / ScreenPeek / IPC / Error]", err);
    }
  };

  // 实时推送审计事件到渲染层 (指令审计可视化页面监听)
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
      console.error("[HugoAura / ScreenPeek / Audit / Push Error]", err);
    }
  };

  const wrapWsClient = (moduleId, label, getSource) => {
    try {
      // 先取模块导出; 若 central 返回的是未执行工厂, resolveModule 会兜底执行
      const client = resolveModule(central, moduleId);

      // 运行时自检: 是否为 WS 客户端 (WebSocketManager 派生实例)
      // 注意: onMessage 在构造器中被 bind, String(实例.onMessage) 恒为
      // "[native code]", 必须取原型链上的未绑定方法做源码特征匹配;
      // setHost/sendMessage 为基类方法, 用于确认 WS 客户端身份。
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
          const proto = Object.getPrototypeOf(client);
          console.warn(
            `[HugoAura / ScreenPeek] Module ${moduleId} self-check failed. ` +
              `typeof(client)=${typeof client}, ` +
              `onMessage=${client && typeof client.onMessage}, ` +
              `setHost=${client && typeof client.setHost}, ` +
              `sendMessage=${client && typeof client.sendMessage}, ` +
              `proto.onMessage=${proto && typeof proto.onMessage}, ` +
              `moduleTable=${!!(central.m && central.c)}`
          );
        }
        console.debug(
          `[HugoAura / ScreenPeek] Module ${moduleId} not ready, retrying...`
        );
        return false;
      }

      // 防止重试时重复包装 (onMessage 已存在我们的包裹标记)
      if (client.__auraScreenPeekWrapped) return true;

      const originalOnMessage = client.onMessage.bind(client);
      client.onMessage = (rawMsg) => {
        let parsed = null;
        try {
          parsed = JSON.parse(rawMsg);
        } catch (err) {
          return originalOnMessage(rawMsg);
        }

        const cfg = getDetectorConfig();
        if (!cfg) return originalOnMessage(rawMsg);

        // 检测 /liveclient 指令
        if (parsed && parsed.messageType === "/liveclient") {
          const state = !!(parsed.data && parsed.data.state);
          const source = getSource();
          const ts = new Date().toISOString();
          const blocked = cfg.mode === "block" && state;

          if (cfg.logPeekEvents) {
            const record = {
              ts,
              source,
              channel: label,
              action: state ? "peek_start" : "peek_stop",
              blocked,
              data: parsed.data || null,
            };
            writeAudit(record);
            pushAuditEvent(record);
          }

          notifyRenderer({ state, source, ts, blocked });

          console.log(
            `[HugoAura / ScreenPeek] ${
              state ? "Peek STARTED" : "Peek stopped"
            } from ${source}${blocked ? " (BLOCKED)" : ""}`
          );

          // block 模式 + 窥屏开始: 吞掉指令, 不向下分发
          if (blocked) return;
        }

        return originalOnMessage(rawMsg);
      };

      // 标记已包装, 防止重试重复安装
      client.__auraScreenPeekWrapped = true;

      console.log(
        `[HugoAura / ScreenPeek] Installed on ${label} (module ${moduleId}).`
      );
      return true;
    } catch (err) {
      console.error(
        `[HugoAura / ScreenPeek] Failed to wrap ${label}:`,
        err
      );
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

  // 懒加载容错: 模块未就绪时延迟重试
  withRetry(
    () => wrapWsClient(399, "hugoServiceWebsocket", () =>
      getWsSource("hugoServiceWebsocket")
    ),
    { label: "ScreenPeek(399)" }
  )();

  withRetry(
    () => wrapWsClient(390, "proxyWebsocketHost", () =>
      getWsSource("proxyWebsocketHost")
    ),
    { label: "ScreenPeek(390)" }
  )();
};

module.exports = { hookFunc: hookFn };
