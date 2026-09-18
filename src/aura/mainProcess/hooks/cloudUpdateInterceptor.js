// @ts-check

/**
 * 云端更新指令全面拦截 + 审计日志 (Cloud Update Command Interceptor)
 *
 * 原理: 希沃管家通过两条 WebSocket 连接接收云端下发指令:
 *   - 模块 399 (SeewoProxyHTTP WS 客户端): 收到原始 JSON 后解析,
 *     分发到 20 个子执行模块 (屏保/密码/远程控制/冻结/升级状态等)。
 *   - 模块 390 (proxyWebsocketHost WS 客户端): 解析后分发到
 *     6 个子模块 (含模块 394 的升级状态分发器)。
 *
 * 本钩子通过共享蹦床 (installWsInterceptor, 见 retryHook.js) 在这两个
 * "总入口"的 onMessage 处拦截: 在 JSON.parse 之后、指令分发到目标执行
 * 模块之前完成:
 *   1. 捕获: 记录每条云端指令的 内容 / 发送时间 / 来源地址 (WS Host)。
 *   2. 拦截: 命中更新指令规则 (url 匹配) 时直接吞掉, 不再向下分发,
 *      确保更新指令不会到达执行模块。
 *   3. 日志: 每次捕获/拦截事件写入独立审计日志
 *      <auraDir>/logs/cloudCommandAudit.log (JSON Lines 格式)。
 *
 * 拦截机制说明: WS 基类 (模块 18) 的 create() 会把 onMessage 一次性解构
 * 进事件闭包, 事后包装实例属性无效 — 因此必须使用共享蹦床 + 断线重连
 * 激活, 详见 retryHook.js installWsInterceptor。
 *
 * 版本容错: 两个入口各自独立 try-catch + 自检, 失败仅跳过该入口。
 */

const path = require("path");
const fs = require("fs");

const { withRetry, installWsInterceptor } = require("./retryHook");

// 更新指令默认拦截规则 (url 关键字/前缀匹配)
const DEFAULT_BLOCK_RULES = [
  "/serviceUpgrade/", // 集控升级状态/反馈/触发
  "/firmwareUpgrade", // 固件升级
];

/**
 * 清理过期审计条目 (纯函数, 便于单测):
 * 解析 JSON Lines 内容, 保留 ts >= cutoff 的行, 返回保留下来的行数组。
 * @param {string} content 日志文件完整内容
 * @param {number} cutoffTs 时间戳下限 (早于该时间的条目视为过期)
 * @returns {{ kept: string[], removed: number }} 保留的行与删除数量
 */
const cleanExpiredEntries = (content, cutoffTs) => {
  const kept = [];
  let removed = 0;
  for (const line of String(content).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed);
      const ts = rec.ts ? new Date(rec.ts).getTime() : NaN;
      if (!isNaN(ts) && ts < cutoffTs) {
        removed++;
        continue;
      }
    } catch {
      // 损坏行保留, 不删除
    }
    kept.push(trimmed);
  }
  return { kept, removed };
};

const hookFn = (central) => {
  const electron = central(1);

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
      console.error("[HugoAura / CloudInterceptor / Audit / Push Error]", err);
    }
  };

  const readConfig = () => {
    try {
      const mgr = global.__HUGO_AURA_CONFIG_MGR__;
      if (!mgr) return null;
      return mgr.loadConfig();
    } catch (err) {
      console.error("[HugoAura / CloudInterceptor / Error] Failed to read config:", err);
      return null;
    }
  };

  const getInterceptConfig = () => {
    const config = readConfig();
    const cfg =
      config && config.auraSettings && config.auraSettings.cloudUpdateIntercept;
    if (!cfg || !cfg.enabled) return null;
    return {
      mode: cfg.mode === "log" ? "log" : "block",
      blockRules: Array.isArray(cfg.extraBlockUrls)
        ? DEFAULT_BLOCK_RULES.concat(cfg.extraBlockUrls.filter((s) => typeof s === "string" && s.length > 0))
        : DEFAULT_BLOCK_RULES,
    };
  };

  // 全量记录云端指令配置: auraSettings.cloudCommandAudit
  const getAuditConfig = () => {
    const config = readConfig();
    const auditCfg =
      config && config.auraSettings && config.auraSettings.cloudCommandAudit;
    return {
      enabled: !!(auditCfg && auditCfg.enabled),
      retentionDays:
        auditCfg && Number.isFinite(auditCfg.retentionDays) && auditCfg.retentionDays > 0
          ? auditCfg.retentionDays
          : 7,
    };
  };

  const isBlockedUrl = (url, rules) => {
    if (typeof url !== "string" || url.length === 0) return false;
    return rules.some((rule) => url.includes(rule));
  };

  // 审计日志: <auraDir>/logs/cloudCommandAudit.log (带轮转, 上限 5MB)
  const AUDIT_MAX_SIZE = 5 * 1024 * 1024; // 5 MB
  const auditFilePath = (() => {
    try {
      const auraDir = global.__HUGO_AURA__ && global.__HUGO_AURA__.auraDir;
      if (!auraDir) return null;
      const logDir = path.join(auraDir, "logs");
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      return path.join(logDir, "cloudCommandAudit.log");
    } catch (err) {
      console.error("[HugoAura / CloudInterceptor / Audit / Error]", err);
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
      console.log("[HugoAura / CloudInterceptor / Audit] Log rotated.");
    } catch (err) {
      console.error("[HugoAura / CloudInterceptor / Audit / Rotate Error]", err);
    }
  };

  // 按天清理: 每次写入前惰性执行, 删除超过保留天数的历史记录
  let lastCleanupAt = 0;
  const cleanupExpiredAudit = (retentionDays) => {
    try {
      if (!auditFilePath || !fs.existsSync(auditFilePath)) return;
      const now = Date.now();
      // 距离上次清理不足 1 小时则跳过, 避免频繁读盘
      if (now - lastCleanupAt < 3600 * 1000) return;
      lastCleanupAt = now;

      const cutoff = now - retentionDays * 24 * 3600 * 1000;
      const content = fs.readFileSync(auditFilePath, "utf8");
      if (!content) return;
      const { kept, removed } = cleanExpiredEntries(content, cutoff);
      if (removed > 0) {
        // 先关闭 append 流, 避免与 writeFileSync 重写文件冲突 (offset 失效)
        if (auditStream) auditStream.end();
        fs.writeFileSync(auditFilePath, kept.length ? kept.join("\n") + "\n" : "", "utf8");
        auditStream = fs.createWriteStream(auditFilePath, { flags: "a" });
        console.log(
          `[HugoAura / CloudInterceptor / Audit] Cleaned ${removed} expired entries (>${retentionDays}d).`
        );
      }
    } catch (err) {
      console.error("[HugoAura / CloudInterceptor / Audit / Cleanup Error]", err);
    }
  };

  const writeAudit = (record, retentionDays = 7) => {
    try {
      if (!auditStream || !auditFilePath) return;
      cleanupExpiredAudit(retentionDays);
      // 轮转检查: 超过上限时滚动
      try {
        const stats = fs.statSync(auditFilePath);
        if (stats.size > AUDIT_MAX_SIZE) rotateAuditLog();
      } catch {}
      auditStream.write(JSON.stringify(record) + "\n");
    } catch (err) {
      console.error("[HugoAura / CloudInterceptor / Audit / Write Error]", err);
    }
  };

  // 拦截处理函数工厂: 按入口绑定渠道与来源标识
  // 返回 true=已拦截 (吞掉指令) / false=放行
  const makeHandler = (label, getSource) => (parsed) => {
    const cfg = getInterceptConfig();

    const url = parsed && parsed.url;
    const source = getSource();
    const ts = new Date().toISOString();

    // 全量记录: 独立于拦截开关, 记录所有云端指令 (含非更新类)
    const auditCfg = getAuditConfig();
    if (auditCfg.enabled && typeof url === "string" && url.length > 0) {
      const logRecord = {
        ts,
        source,
        channel: label,
        url,
        action: "logged",
        data: parsed && parsed.data !== undefined ? parsed.data : null,
        _logType: "cloud",
      };
      writeAudit(logRecord, auditCfg.retentionDays);
      pushAuditEvent(logRecord);
    }

    // 功能未启用: 完全透传
    if (!cfg) return false;

    // 捕获: 记录所有云端指令
    if (cfg.mode === "log") {
      const record = {
        ts,
        source,
        channel: label,
        url,
        action: "captured",
        data: parsed && parsed.data !== undefined ? parsed.data : null,
      };
      writeAudit(record, auditCfg.retentionDays);
      pushAuditEvent(record);
      return false;
    }

    // block 模式: 拦截更新指令
    if (isBlockedUrl(url, cfg.blockRules)) {
      const record = {
        ts,
        source,
        channel: label,
        url,
        action: "blocked",
        data: parsed && parsed.data !== undefined ? parsed.data : null,
      };
      writeAudit(record, auditCfg.retentionDays);
      pushAuditEvent(record);
      console.log(
        `[HugoAura / CloudInterceptor] Blocked cloud command: ${url} from ${source}`
      );
      return true; // 吞掉指令, 不向下分发
    }

    // 非更新指令: 直接放行 (block 模式仅记录拦截事件, 避免日志膨胀)
    return false;
  };

  // 来源地址: 从模块 0 配置读取 WS host
  const getWsSource = (key) => {
    try {
      const cfg = central(0);
      const host = cfg && cfg[key];
      return host && host.ip ? `${host.ip}${host.url || ""}` : "unknown";
    } catch (err) {
      return "unknown";
    }
  };

  // 入口 1: hugoServiceWebsocket WS (模块 399, 集控主连接)
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
    { label: "CloudInterceptor(399)" }
  )();

  // 入口 2: proxyWebsocketHost WS (模块 390, 代理/边缘连接)
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
    { label: "CloudInterceptor(390)" }
  )();
};

module.exports = { hookFunc: hookFn, cleanExpiredEntries };
