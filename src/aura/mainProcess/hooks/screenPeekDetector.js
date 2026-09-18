// @ts-check

/**
 * 窥屏提醒 (Screen Peek Detector)
 *
 * 原理: 希沃管家通过模块 399 (hugoServiceWebsocket) 的 WS 连接接收云端
 * /liveclient 指令, 分发到模块 401 启动/停止直播 (即远程屏幕查看)。
 * 本钩子通过共享蹦床 (installWsInterceptor) 在 WS 入口的 onMessage 处
 * 监测该指令:
 *   1. 检测 messageType === "/liveclient"
 *   2. state === true: 有人发起远程查看屏幕 → IPC 通知渲染层弹窗提醒
 *   3. state === false: 远程查看结束 → IPC 通知渲染层关闭提醒
 *   4. 审计日志: 记录窥屏事件到 logs/screenPeekAudit.log
 *
 * 注意: 仅提醒, 不阻止。实际的屏幕采集由独立进程 (Zego 远程桌面组件)
 * 完成, 指令不经过管家进程, 管家侧的 /liveclient 只是任务状态登记
 * (模块 401 的 startTask 仅打日志), 拦截它无法阻止实际采集。
 *
 * 拦截机制说明: WS 基类 (模块 18) 的 create() 会把 onMessage 一次性解构
 * 进事件闭包, 事后包装实例属性无效 — 因此必须使用共享蹦床 + 断线重连
 * 激活 (详见 retryHook.js installWsInterceptor)。
 */

const path = require("path");
const fs = require("fs");

const { withRetry, installWsInterceptor } = require("./retryHook");

const hookFn = (central) => {
  const electron = central(1);

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

  // 监测处理函数工厂: 按入口绑定渠道与来源标识
  const makeHandler = (label, getSource) => (parsed) => {
    const cfg = getDetectorConfig();
    if (!cfg) return false;

    // 检测 /liveclient 指令
    if (parsed && parsed.messageType === "/liveclient") {
      const state = !!(parsed.data && parsed.data.state);
      const source = getSource();
      const ts = new Date().toISOString();

      if (cfg.logPeekEvents) {
        const record = {
          ts,
          source,
          channel: label,
          action: state ? "peek_start" : "peek_stop",
          data: parsed.data || null,
          _logType: "peek",
        };
        writeAudit(record);
        pushAuditEvent(record);
      }

      notifyRenderer({ state, source, ts });

      console.log(
        `[HugoAura / ScreenPeek] ${
          state ? "Peek STARTED" : "Peek stopped"
        } from ${source}`
      );
    }

    // 仅监测: 永远放行
    return false;
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

  // 入口: hugoServiceWebsocket WS (模块 399, /liveclient 实际入口)
  // 懒加载容错: 模块未就绪时延迟重试
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
    { label: "ScreenPeek(399)" }
  )();

  // 入口: proxyWebsocketHost WS (模块 390, 兜底覆盖)
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
    { label: "ScreenPeek(390)" }
  )();
};

module.exports = { hookFunc: hookFn };
