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
 *   1. 捕获: 记录每条云端指令的 内容 / 发送时间 / 来源地址 (WS Host) / 通道。
 *   2. 拦截: 命中更新指令规则 (url 匹配) 时直接吞掉, 不再向下分发,
 *      确保更新指令不会到达执行模块。
 *   3. 日志: 每次捕获/拦截事件写入独立审计日志
 *      <auraDir>/logs/cloudCommandAudit.log (JSON Lines 格式)。
 *
 * 记录条件 (2026-10 修正): 旧实现要求 url 必须是非空字符串, 导致 **messageType
 * 类指令全部漏记** —— 窥屏 /liveclient、设备信息 1001、锁屏 1211、病毒 1002/1003、
 * 语音 1213-1215、绑定 1315/1317/1318 等统统看不到, 这正是"审计里看不到云端到底
 * 发了什么"的直接原因。现在改为:
 *   - 有 url                      -> key = url
 *   - 无 url 但有 messageType     -> key = "messageType:<值>"
 *   - 两者都无但带 data/traceId   -> key = "(unidentified)" (便于事后排查陌生指令)
 *   - 什么都没有 (心跳/空消息)    -> 不记录
 * 每条指令只写一条记录 (旧实现 mode=log 时会同时写 logged + captured 两条)。
 * 新增字段: messageType / key / traceId / channelId / intercepted / blocked,
 * 均为"只加不改", 旧日志文件仍可正常解析。
 *
 * 拦截机制说明: WS 基类 (模块 18) 的 create() 会把 onMessage 一次性解构
 * 进事件闭包, 事后包装实例属性无效 — 因此必须使用共享蹦床 + 断线重连
 * 激活, 详见 retryHook.js installWsInterceptor。
 *
 * 版本容错: 两个入口各自独立 try-catch + 自检, 失败仅跳过该入口。
 */

const { withRetry, installWsInterceptor } = require("./retryHook");
const auditWriter = require("./auditWriter");
const { performance } = require("perf_hooks");

// 更新指令默认拦截规则 (url 关键字/前缀匹配)
const DEFAULT_BLOCK_RULES = [
  "/serviceUpgrade/", // 集控升级状态/反馈/触发
  "/firmwareUpgrade", // 固件升级
];

// 备选判别字段: 部分 WS 通道不用 url / messageType, 而用这些字段标识指令类型。
// 不认它们就会"消息明明收到了, 审计里却是空白"。
const ALT_DISCRIMINATOR_FIELDS = [
  "type",
  "cmd",
  "command",
  "method",
  "event",
  "action",
];

/**
 * 清理过期审计条目 (纯函数, 便于单测):
 * 解析 JSON Lines 内容, 保留 ts >= cutoff 的行, 返回保留下来的行数组。
 *
 * 实现已收敛到共享写入器 auditWriter.filterExpired —— 保留天数清理不再只
 * 依赖本 hook 的写入路径 (否则"更新拦截关闭 + 主连接无指令"时永不清理)。
 *
 * @param {string} content 日志文件完整内容
 * @param {number} cutoffTs 时间戳下限 (早于该时间的条目视为过期)
 * @returns {{ kept: string[], removed: number }} 保留的行与删除数量
 */
const cleanExpiredEntries = (content, cutoffTs) =>
  auditWriter.filterExpired(content, cutoffTs);

/**
 * 心跳/保活消息的字段白名单。
 *
 * 引入"备选判别字段"(见 commandKeyOf) 后, 判定会变宽, 必须把纯心跳挡掉 ——
 * 十几个 WS 通道各自定时心跳, 若都记进审计日志会把真正的指令淹没。
 * 只含这些字段的消息一律不记录。
 */
const HEARTBEAT_FIELDS = new Set([
  "ping",
  "pong",
  "heartbeat",
  "keepAlive",
  "keepalive",
  "ts",
  "time",
  "timestamp",
]);

/** 是否为空对象或仅含心跳字段 */
const isHeartbeatOnly = (parsed) => {
  const keys = Object.keys(parsed);
  if (keys.length === 0) return true;
  return keys.every((key) => HEARTBEAT_FIELDS.has(key));
};

/**
 * 计算云端指令的统一检索键 (纯函数, 便于单测)。
 *
 * 审计页与排查都靠这个键定位"这是哪条指令":
 *   - 有 url                     -> 用 url
 *   - 无 url 但有 messageType    -> "messageType:<值>" (窥屏/设备信息/锁屏等走这条)
 *   - 无以上两者但有备选判别字段 -> "<字段>:<值>" (type / cmd / command / method /
 *     event / action; 部分通道不用 messageType 而用这些字段, 旧实现会静默漏记)
 *   - 仍无判别字段但带 data/traceId -> "(unidentified)" (陌生指令也要留痕)
 *   - 纯心跳 / 空消息             -> null (不记录)
 *
 * @param {any} parsed 已解析的云端消息
 * @returns {string | null}
 */
const commandKeyOf = (parsed) => {
  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.url === "string" && parsed.url.length > 0) return parsed.url;
  if (parsed.messageType !== undefined && parsed.messageType !== null) {
    return `messageType:${parsed.messageType}`;
  }
  if (isHeartbeatOnly(parsed)) return null;

  // 备选判别字段: 逐个尝试, 命中即用
  for (const field of ALT_DISCRIMINATOR_FIELDS) {
    const value = parsed[field];
    if (typeof value === "string" && value.length > 0) return `${field}:${value}`;
    if (typeof value === "number" && Number.isFinite(value)) {
      return `${field}:${value}`;
    }
  }

  const hasPayload = parsed.data !== undefined && parsed.data !== null;
  const hasTrace =
    typeof parsed.traceId === "string" && parsed.traceId.length > 0;
  return hasPayload || hasTrace ? "(unidentified)" : null;
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

  // 审计日志: <auraDir>/logs/cloudCommandAudit.log
  // 写入与轮转统一交给共享写入器 (cloudCommandAudit.log 同时被
  // powerOffInterceptor / lockScreenInterceptor 写入, 各自持句柄会互相打架)
  const AUDIT_FILE = "cloudCommandAudit.log";

  // 按天清理: 交给共享写入器 (auditWriter.cleanupExpired, 节流 1 小时)。
  // 旧实现在本 hook 内自带 lastCleanupAt + read/rewrite, 导致保留天数只在
  // "本 hook 有写入"时才生效; 现在任何带 retentionDays 的写入都会触发清理。
  const writeAudit = (record, retentionDays = 7) => {
    try {
      auditWriter.writeAudit(AUDIT_FILE, record, { retentionDays });
    } catch (err) {
      console.error("[HugoAura / CloudInterceptor / Audit / Write Error]", err);
    }
  };

  /**
   * 组装审计记录的公共字段 (只加不改, 旧日志仍可解析)。
   * @param {any} parsed 已解析的云端消息
   * @param {string} label 通道名 (WS 配置键)
   * @param {string} source WS host
   * @param {string} ts ISO 时间
   * @param {number | null} channelId 客户端模块号
   */
  const baseRecord = (parsed, label, source, ts, channelId) => ({
    ts,
    source,
    channel: label,
    channelId: channelId === undefined ? null : channelId,
    url: typeof parsed.url === "string" ? parsed.url : null,
    messageType: parsed.messageType === undefined ? null : parsed.messageType,
    key: commandKeyOf(parsed),
    traceId: typeof parsed.traceId === "string" ? parsed.traceId : null,
    data: parsed.data !== undefined ? parsed.data : null,
  });

  // 拦截处理函数工厂: 按入口绑定渠道与来源标识
  // 返回 true=已拦截 (吞掉指令) / false=放行
  const makeHandler = (label, getSource, channelId) => (parsed) => {
    // 处理耗时: 拦截链自身开销 (亚毫秒级), 顺带证明拦截几乎零成本
    const startedAt = performance.now();
    const cfg = getInterceptConfig();
    const source = getSource();
    const ts = new Date().toISOString();
    const key = commandKeyOf(parsed);
    // 只有 block 模式才会真正吞掉指令; log 模式仅记录 (命中规则也不算 blocked)
    const blocked = Boolean(
      cfg && cfg.mode === "block" && isBlockedUrl(parsed && parsed.url, cfg.blockRules)
    );

    // 一条指令只写一条记录 (旧实现 mode=log 时会写 logged + captured 两条)。
    // 动作取值与审计页既有语义对齐:
    //   blocked  -> "blocked"   (UI 的"已拦截"统计依赖它)
    //   log 模式 -> "captured"
    //   其余     -> "logged"    (全量记录)
    const auditCfg = getAuditConfig();
    let action = null;
    if (blocked) action = "blocked";
    else if (cfg && cfg.mode === "log") action = "captured";
    else if (auditCfg.enabled) action = "logged";

    if (action && key) {
      const record = {
        ...baseRecord(parsed, label, source, ts, channelId),
        action,
        // 只覆盖拦截链自身, 不含后续指令分发 (那是管家自己的工作)
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        intercepted: blocked,
        blocked,
        _logType: "cloud",
      };
      writeAudit(record, auditCfg.retentionDays);
      pushAuditEvent(record);
    }

    // 功能未启用: 完全透传
    if (!cfg) return false;

    // block 模式: 拦截更新指令
    if (blocked) {
      console.log(
        `[HugoAura / CloudInterceptor] Blocked cloud command: ${key} from ${source}`
      );
      return true; // 吞掉指令, 不向下分发
    }

    // 非更新指令: 直接放行
    return false;
  };

  /**
   * 标记处理函数"已覆盖该通道的审计"。
   * 全局 WS 探针 (wsAuditTap) 会跳过带此标记的通道, 避免同一通道记录两次。
   */
  const markAudited = (handler) => {
    handler.__auraAuditCovered = true;
    return handler;
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
        markAudited(
          makeHandler(
            "hugoServiceWebsocket",
            () => getWsSource("hugoServiceWebsocket"),
            399
          )
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
        markAudited(
          makeHandler(
            "proxyWebsocketHost",
            () => getWsSource("proxyWebsocketHost"),
            390
          )
        )
      ),
    { label: "CloudInterceptor(390)" }
  )();
};

module.exports = { hookFunc: hookFn, cleanExpiredEntries, commandKeyOf };
