// @ts-check

/**
 * 远程锁屏指令拦截 (Lock-Screen Interceptor)
 *
 * 原理: 希沃管家通过 hugoServiceWebsocket (模块 399) 接收云端集控下发的
 * 锁屏指令:
 *   模块 399 的 onMessage → 分发到模块 33 (锁屏任务控制器),
 *   命中 messageType === 1211 且 data.screenLockStatus === 1 后,
 *   创建全屏 screenLock_<display> 窗口并挂钩键盘。
 *
 * 本钩子通过共享蹦床 (installWsInterceptor) 在模块 399/390 的 onMessage
 * 入口处拦截, 在指令分发到模块 33 前处理:
 *   1. block 模式: 直接吞掉锁屏指令, 设备不会被远程锁屏。
 *   2. notify 模式: 延迟 10 秒放行指令, 弹窗提醒用户。
 *   3. 审计日志写入 cloudCommandAudit.log (复用云端指令审计通道)。
 *
 * 注意:
 *   - 本地 "锁屏" 按钮走 IPC 通道 (windowMessage → startLockScreen,
 *     模块 375), 不经过本拦截点, 因此不受影响。
 *   - messageType 1211 / screenLockStatus 0 为解锁指令, 同样放行,
 *     以免设备被锁后无法解锁。
 *
 * 拦截机制说明: WS 基类 (模块 18) 的 create() 会把 onMessage 一次性解构
 * 进事件闭包, 事后包装实例属性无效 — 因此必须使用共享蹦床 + 断线重连
 * 激活 (详见 retryHook.js installWsInterceptor)。
 */

const path = require("path");
const fs = require("fs");

const { withRetry, installWsInterceptor } = require("./retryHook");

// 锁屏指令特征: messageType 1211, data.screenLockStatus === 1 (1=锁屏, 0=解锁)
const LOCK_MESSAGE_TYPE = 1211;
const LOCK_STATUS_LOCKED = 1;

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
      console.error("[HugoAura / LockScreen / Audit / Push Error]", err);
    }
  };

  // 锁屏拦截弹窗通知: 推送到渲染层
  const pushLockNotify = (record) => {
    try {
      if (
        electron &&
        electron.ipcMain &&
        typeof electron.ipcMain.send === "function"
      ) {
        electron.ipcMain.send("*", "$aura.lockScreen.onBlocked", { record });
      }
    } catch (err) {
      console.error("[HugoAura / LockScreen / Notify Error]", err);
    }
  };

  const readConfig = () => {
    try {
      const mgr = global.__HUGO_AURA_CONFIG_MGR__;
      if (!mgr) return null;
      return mgr.loadConfig();
    } catch (err) {
      console.error(
        "[HugoAura / LockScreen / Error] Failed to read config:",
        err
      );
      return null;
    }
  };

  const getInterceptConfig = () => {
    const config = readConfig();
    const cfg =
      config && config.auraSettings && config.auraSettings.lockScreenIntercept;
    if (!cfg || !cfg.enabled) return null;
    return {
      mode: cfg.mode === "notify" ? "notify" : "block",
    };
  };

  // 仅拦截锁屏指令 (screenLockStatus === 1); 解锁指令 (0) 放行
  const isRemoteLock = (parsed) =>
    !!parsed &&
    parsed.messageType === LOCK_MESSAGE_TYPE &&
    !!parsed.data &&
    parsed.data.screenLockStatus === LOCK_STATUS_LOCKED;

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
      console.error("[HugoAura / LockScreen / Audit / Error]", err);
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
      console.error("[HugoAura / LockScreen / Audit / Rotate Error]", err);
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
      console.error("[HugoAura / LockScreen / Audit / Write Error]", err);
    }
  };

  // 拦截处理函数工厂: 按入口绑定渠道与来源标识
  const makeHandler = (label, getSource) => (parsed) => {
    const cfg = getInterceptConfig();
    if (!cfg) return false;

    if (!isRemoteLock(parsed)) return false;

    const source = getSource();
    const ts = new Date().toISOString();
    const record = {
      ts,
      source,
      channel: label,
      url: `messageType:${LOCK_MESSAGE_TYPE}`,
      action: cfg.mode === "block" ? "blocked" : "captured",
      data: parsed.data !== undefined ? parsed.data : null,
      _logType: "lockScreen",
    };
    writeAudit(record);
    pushAuditEvent(record);
    pushLockNotify(record);

    if (cfg.mode === "block") {
      console.log(
        `[HugoAura / LockScreen] Blocked remote lock-screen from ${source}`
      );
      return true; // 吞掉指令, 设备不会被锁屏
    }

    // notify 模式: 延迟 10 秒后放行, 给用户保存工作的时间
    console.log(
      `[HugoAura / LockScreen] Remote lock-screen detected, delaying 10s before dispatch (notify mode)`
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

  // 入口 1: hugoServiceWebsocket WS (模块 399, 锁屏指令实际入口)
  withRetry(
    () =>
      installWsInterceptor(
        central,
        399,
        "hugoServiceWebsocket",
        makeHandler("hugoServiceWebsocket", () =>
          getWsSource("hugoServiceWebsocket")
        )
      ),
    { label: "LockScreen(399)" }
  )();

  // 入口 2: proxyWebsocketHost WS (模块 390, 兜底覆盖)
  withRetry(
    () =>
      installWsInterceptor(
        central,
        390,
        "proxyWebsocketHost",
        makeHandler("proxyWebsocketHost", () =>
          getWsSource("proxyWebsocketHost")
        )
      ),
    { label: "LockScreen(390)" }
  )();
};

module.exports = { hookFunc: hookFn };
