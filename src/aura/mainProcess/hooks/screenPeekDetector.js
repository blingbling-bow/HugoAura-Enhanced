// @ts-check

/**
 * 窥屏提醒 (Screen Peek Detector)
 *
 * 两个信号源, 进程级为主:
 *
 *   1. 进程级 (主信号): 窥屏由管家之外的独立进程 screenCapture 完成 —— 管家
 *      全包搜不到 screenCapture 字样 (既不启动也不感知它), 所以**管家进程内
 *      没有任何窥屏信号**。唯一可靠的办法是从操作系统层面看这个进程在不在:
 *      周期执行 tasklist 比对进程名, 出现/消失即为窥屏开始/结束。
 *   2. WS 级 (辅助): 模块 399/390 上的 messageType === "/liveclient"。
 *      注意它只是任务状态登记 —— 管家模块 401 收到后仅往任务队列塞一个占位
 *      任务 (startTask 只打日志), 与真正的采集无关; 保留它是因为云端有时会
 *      一并下发, 属于免费的第二信号。
 *
 * 两个信号都只提醒、不阻止: 采集由独立进程完成, 管家侧拦不住。
 * 审计日志: logs/screenPeekAudit.log (_logType: "peek")。
 *
 * 轮询开销与漏检: 默认每 2s 一次 tasklist (配置项 pollIntervalMs 可改),
 * 短于轮询间隔的窥屏可能被漏掉 —— 这是进程级检测的固有代价, 换来的是
 * "不依赖管家内部信号"这一可靠性。
 *
 * WS 拦截机制说明: WS 基类 (模块 18) 的 create() 会把 onMessage 一次性解构
 * 进事件闭包, 事后包装实例属性无效 — 因此必须使用共享蹦床 + 断线重连
 * 激活 (详见 retryHook.js installWsInterceptor)。
 */

const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const { withRetry, installWsInterceptor } = require("./retryHook");

// >>> 进程级检测的默认参数 <<< //
const DEFAULT_PEEK_PROCESS_NAMES = ["screenCapture.exe"];
const DEFAULT_POLL_INTERVAL_MS = 2000;
const MIN_POLL_INTERVAL_MS = 1000;
const MAX_POLL_INTERVAL_MS = 30000;

// >>> 纯函数 (导出以便单测) <<< //

/**
 * 解析 `tasklist /fo csv /nh` 的输出。
 * 每行形如: "screenCapture.exe","12345","Console","1","12,345 K"
 * @param {string} stdout
 * @returns {Array<{ name: string, pid: number }>}
 */
const parseTasklistCsv = (stdout) => {
  const out = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    // 没有匹配进程时 tasklist 会输出一行 INFO: No tasks are running...
    if (!trimmed || trimmed.startsWith("INFO:")) continue;
    const matched = trimmed.match(/^"([^"]+)","(\d+)"/);
    if (!matched) continue;
    out.push({ name: matched[1], pid: Number(matched[2]) });
  }
  return out;
};

/**
 * 在进程列表里找窥屏进程 (进程名大小写不敏感)。
 * @param {Array<{ name: string, pid: number }>} processes
 * @param {string[]} names 目标进程名
 * @returns {{ name: string, pid: number } | null}
 */
const findPeekProcess = (processes, names) => {
  const wanted = (Array.isArray(names) ? names : []).map((n) =>
    String(n).toLowerCase()
  );
  if (wanted.length === 0) return null;
  return (
    (processes || []).find((p) =>
      wanted.includes(String(p.name).toLowerCase())
    ) || null
  );
};

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

  const getRawConfig = () => {
    const config = readConfig();
    return (
      (config && config.auraSettings && config.auraSettings.screenPeekDetector) ||
      null
    );
  };

  const getDetectorConfig = () => {
    const cfg = getRawConfig();
    if (!cfg || !cfg.enabled) return null;
    return {
      logPeekEvents: cfg.logPeekEvents !== false,
    };
  };

  const getPeekProcessNames = () => {
    const cfg = getRawConfig();
    const names = cfg && Array.isArray(cfg.processNames) ? cfg.processNames : [];
    const cleaned = names.filter((n) => typeof n === "string" && n.trim());
    return cleaned.length > 0 ? cleaned : DEFAULT_PEEK_PROCESS_NAMES;
  };

  const getPollIntervalMs = () => {
    const cfg = getRawConfig();
    const raw = cfg && Number(cfg.pollIntervalMs);
    if (!Number.isFinite(raw)) return DEFAULT_POLL_INTERVAL_MS;
    return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, raw));
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

  // >>> 进程级检测 (主信号) <<< //

  let peekProcessRunning = false;
  let peekPollInFlight = false;
  let peekPollTimer = null;

  /**
   * 进程出现/消失时的边沿处理: 只在状态翻转时记录与提醒, 不重复刷。
   * @param {{ name: string, pid: number } | null} found
   */
  const handlePeekTransition = (found) => {
    const running = Boolean(found);
    if (running === peekProcessRunning) return;
    peekProcessRunning = running;

    const cfg = getDetectorConfig();
    const ts = new Date().toISOString();
    const source = found
      ? `${found.name} (pid ${found.pid})`
      : "screenCapture 进程已退出";
    const record = {
      ts,
      source,
      channel: "process-watch",
      action: running ? "peek_start" : "peek_stop",
      data: found ? { name: found.name, pid: found.pid } : null,
      _logType: "peek",
    };

    if (cfg && cfg.logPeekEvents) {
      writeAudit(record);
      pushAuditEvent(record);
    }
    notifyRenderer({ state: running, source, ts });

    console.log(
      `[HugoAura / ScreenPeek] ${
        running ? "Peek STARTED" : "Peek stopped"
      } (${source})`
    );
  };

  const pollPeekProcess = () => {
    if (peekPollInFlight) return;
    // 开关关闭时不执行 tasklist, 避免无谓的进程创建
    if (!getDetectorConfig()) return;

    peekPollInFlight = true;
    const names = getPeekProcessNames();
    execFile(
      "tasklist",
      ["/fo", "csv", "/nh"],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        peekPollInFlight = false;
        if (err) {
          console.debug(
            "[HugoAura / ScreenPeek] tasklist unavailable:",
            err.message
          );
          return;
        }
        handlePeekTransition(
          findPeekProcess(parseTasklistCsv(stdout), names)
        );
      }
    );
  };

  const startPeekProcessWatch = () => {
    if (peekPollTimer) return;
    peekPollTimer = setInterval(pollPeekProcess, getPollIntervalMs());
    // 不阻塞宿主进程退出 (管家退出时不该被这个定时器拖住)
    if (typeof peekPollTimer.unref === "function") peekPollTimer.unref();
    pollPeekProcess();
    console.log(
      `[HugoAura / ScreenPeek] Process watch started (interval ${getPollIntervalMs()}ms, targets: ${getPeekProcessNames().join(", ")}).`
    );
  };

  startPeekProcessWatch();

  // >>> WS 级检测 (辅助信号) <<< //

  // 监测处理函数工厂: 按入口绑定渠道与来源标识
  const makeHandler = (label, getSource) => (parsed) => {
    const cfg = getDetectorConfig();
    if (!cfg) return false;

    // 检测 /liveclient 指令 (任务状态登记, 非采集本身)
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

module.exports = { hookFunc: hookFn, parseTasklistCsv, findPeekProcess };
