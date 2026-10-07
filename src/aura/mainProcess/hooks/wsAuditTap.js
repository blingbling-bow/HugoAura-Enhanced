// @ts-check

/**
 * 全局 WebSocket 审计探针 (All-Channel WS Audit Tap)
 *
 * 背景: cloudUpdateInterceptor 只覆盖两条"云端主连接" (399 hugoServiceWebsocket /
 * 390 proxyWebsocketHost)。但管家的 WS 通道有十几个 (模块 174 配置表):
 *   proxyWebsocketHost / hugoServiceWebsocket / smartPenWebsocketHost /
 *   ADBlockWebSocket / adminWebsocket / SeewoVoiceService / processAcceleration /
 *   virusService / remoteControlWebsocket / remoteControlStatusWebsocket /
 *   edgeServerWebsocket / wisdomPlatformWebsocket / audioWebsocket /
 *   webrtcWebsocket (/RemoteControl) / lightIot / SeewoDesktop
 * 其中不少通道的客户端模块号无从硬编码 (部分通道甚至没有独立客户端模块)。
 * 这些通道上的指令此前完全不可见 —— 正是"审计里看不到云端到底发了什么"的另一半原因。
 *
 * 做法: 不依赖任何硬编码模块号, 而是从 webpack 模块缓存 (central.c) 里按运行时特征
 * 找出**所有** WS 客户端实例 (isWsClientInstance), 复用 retryHook 的共享蹦床
 * (ensureWsTrampoline) 挂上"只观察、不消费"的审计处理函数:
 *   - 处理函数恒返回 undefined, 绝不影响原有指令分发 (纯观察者);
 *   - 已由 cloudUpdateInterceptor 覆盖的通道 (处理函数带 __auraAuditCovered 标记)
 *     自动跳过, 避免同一通道被记录两次;
 *   - 通道名取客户端自身标识 (label/name/channel/key -> host -> ws-<模块号>);
 *   - 蹦床必须在连接建立后重连一次才生效 (基类 create() 把 onMessage 解构进闭包),
 *     因此首次安装会对每个客户端触发一次重连, 并按 REFRESH_STAGGER_MS 错峰,
 *     避免十几条连接同时断开重连。
 *
 * 兼容与降级: 任何一步失败都只跳过该客户端 / 该次扫描, 不影响管家运行。
 * 客户端可能在启动后才创建, 因此首次安装成功后会周期性重扫 (unref 定时器)。
 */

const {
  withRetry,
  isWsClientLike,
  ensureWsTrampoline,
  refreshWsClient,
} = require("./retryHook");
const { commandKeyOf } = require("./cloudUpdateInterceptor");
const auditWriter = require("./auditWriter");
const { performance } = require("perf_hooks");

// 与 cloudUpdateInterceptor / powerOffInterceptor 共用同一份审计日志
const AUDIT_FILE = "cloudCommandAudit.log";

// 客户端上的标记: 已挂载审计探针 (含"已确认被其他 hook 覆盖, 无需挂载")
const AUDIT_TAP_FLAG = "__auraWsAuditTap";
// cloudUpdateInterceptor 给处理函数打的标记: 该通道已被它审计
const COVERED_FLAG = "__auraAuditCovered";

// 单次扫描最多处理的客户端数 (防御性上限, 正常只有十几个)
const MAX_CLIENTS = 64;
// 已由 cloudUpdateInterceptor 按固定模块号覆盖的通道: 直接跳过。
// 不能只依赖 __auraAuditCovered 标记 —— 若本探针先于 CloudUpdateInterceptor
// 安装完成 (它要等模块就绪重试), 那两条连接会被记录两次。
const SKIP_MODULE_IDS = new Set([390, 399]);
// 重扫间隔: 捕获启动后才创建的 WS 客户端
const RESCAN_INTERVAL_MS = 15000;
// 重连错峰间隔: 十几个客户端同时断线重连会打爆对端
const REFRESH_STAGGER_MS = 250;

// 模块级: 重扫定时器只启动一次
let rescanStarted = false;

/**
 * 取客户端来源标识 (WS host / URL), 写入审计记录的 source 字段。
 * @param {any} client
 * @returns {string}
 */
const sourceOf = (client) => {
  if (!client) return "unknown";
  for (const field of ["host", "url", "hostUrl", "address"]) {
    const value = client[field];
    if (typeof value === "string" && value.length > 0) return value;
    if (value && typeof value === "object" && typeof value.url === "string") {
      return `${value.ip || ""}${value.url}`;
    }
  }
  return "unknown";
};

/**
 * 取 URL 的路径部分 (丢掉 scheme://host:port)。
 *
 * 真机上 WS 客户端的 host 形如
 *   wss://127.0.0.1:51270/forward/SeewoHugoHttp/SeewoWindowBlock
 * 而管家配置表里是
 *   wss://127.0.0.1/forward/SeewoHugoHttp/SeewoWindowBlock
 * 两者只差端口, 因此按路径匹配才能对上通道名。
 *
 * @param {string} url
 * @returns {string} 形如 "/forward/..." ; 无路径时返回 ""
 */
const urlPathOf = (url) => {
  const s = String(url || "");
  const schemeAt = s.indexOf("://");
  const rest = schemeAt >= 0 ? s.slice(schemeAt + 3) : s;
  const slash = rest.indexOf("/");
  return slash >= 0 ? rest.slice(slash) : "";
};

/**
 * 由管家 WS 配置表 (模块 0 / 174) 构建「路径 -> 通道名」映射。
 *
 * 配置表形如 { hugoServiceWebsocket: { ip:"wss://127.0.0.1",
 * url:"/forward/SeewoHugoHttp/SeewoHugoService" }, ... }。
 * 有了它, 审计页的「通道」列就能显示 ADBlockWebSocket / audioWebsocket
 * 这样的真名, 而不是一长串 URL。
 *
 * @param {any} config 配置表
 * @returns {Record<string, string>}
 */
const buildChannelMap = (config) => {
  const map = {};
  if (!config || typeof config !== "object") return map;
  for (const [name, value] of Object.entries(config)) {
    if (!value || typeof value !== "object") continue;
    const url = typeof value.url === "string" ? value.url : "";
    if (!url) continue;
    const path = urlPathOf(
      `${typeof value.ip === "string" ? value.ip : ""}${url}`
    );
    if (path) map[path] = name;
  }
  return map;
};

/**
 * 取客户端通道名 (审计页的「通道」列与筛选依据)。
 * 依次尝试: 客户端自带标识 -> 管家通道表 (按路径匹配) -> URL 最后一段 -> 模块号。
 *
 * @param {any} client
 * @param {number | string} moduleId
 * @param {Record<string, string>} [channelMap] 路径 -> 通道名
 * @returns {string}
 */
const clientLabelOf = (client, moduleId, channelMap) => {
  if (client) {
    for (const field of ["label", "name", "channel", "key", "wsName"]) {
      const value = client[field];
      if (typeof value === "string" && value.length > 0) return value;
    }
    const source = sourceOf(client);
    if (source !== "unknown") {
      const path = urlPathOf(source);
      if (channelMap && path && channelMap[path]) return channelMap[path];
      // 退一步取 URL 最后一段: "SeewoWindowBlock" 也比整条 URL 可读
      const segment = path.split("/").filter(Boolean).pop();
      if (segment) return segment;
      return source;
    }
  }
  return `ws-${moduleId}`;
};

/**
 * 判断客户端是否已被其他 hook 覆盖审计 (避免重复记录)。
 * @param {any} client
 * @returns {boolean}
 */
const isCoveredByExistingHook = (client) => {
  const list = client && client.__auraWsInterceptors;
  if (!Array.isArray(list)) return false;
  return list.some((h) => Boolean(h && h[COVERED_FLAG] === true));
};

/**
 * 从 webpack 模块缓存里收集所有 WS 客户端实例。
 *
 * 只读模块缓存 (central.c) —— 已执行过的模块导出就躺在那里, 不需要为探测
 * 触发任何模块执行 (执行 WS 客户端模块会立即建立连接)。
 *
 * @param {(id: number) => any} central 模块加载器
 * @param {(client: any) => boolean} [isWsClient] 判定函数 (便于单测注入)。
 *        默认用宽松判定 isWsClientLike: 只要具备 WS 基类成员就纳入采集 ——
 *        用严格的 isWsClientInstance (要求 onMessage 源码含 JSON.parse) 会让
 *        个别客户端整条通道静默漏采。
 * @returns {{ client: any, moduleId: any }[]}
 */
const collectWsClients = (central, isWsClient = isWsClientLike) => {
  const found = [];
  const seen = new Set();
  const cache = central && central.c;
  if (!cache || typeof cache !== "object") return found;
  for (const entry of Object.values(cache)) {
    const exported = entry && entry.exports;
    if (!exported || seen.has(exported)) continue;
    let ok = false;
    try {
      ok = isWsClient(exported) === true;
    } catch (err) {
      ok = false;
    }
    if (!ok) continue;
    seen.add(exported);
    found.push({ client: exported, moduleId: entry.i });
    if (found.length >= MAX_CLIENTS) break;
  }
  return found;
};

/**
 * 构造"只观察、不消费"的审计处理函数。
 *
 * 恒返回 undefined —— 蹦床据此继续把消息交给下一个处理函数 / 原始 onMessage,
 * 因此探针不会改变任何指令行为 (与拦截类 hook 的关键区别)。
 *
 * @param {any} client WS 客户端实例
 * @param {number | string} moduleId 客户端模块号
 * @param {{
 *   getConfig: () => { enabled: boolean, retentionDays: number },
 *   writeRecord: (record: any, retentionDays: number) => void,
 *   pushEvent: (record: any) => void,
 *   now?: () => string
 * }} deps
 * @returns {(parsed: any) => undefined}
 */
const makeTapHandler = (client, moduleId, deps) => {
  const label = clientLabelOf(client, moduleId, deps.channelMap);
  const source = sourceOf(client);
  const now = deps.now || (() => new Date().toISOString());

  const handler = (parsed) => {
    // 处理耗时: 探针自身开销 (亚毫秒级, 纯观察)
    const startedAt = performance.now();
    try {
      // 运行期再判一次"是否已被 cloudUpdateInterceptor 覆盖":
      // 那个 hook 的固定模块号可能失配并走扫描兜底, 安装时机可能晚于本探针,
      // 此时同一通道会被记录两次。以蹦床上的覆盖标记为准, 动态让位。
      if (isCoveredByExistingHook(client)) return undefined;

      const cfg = deps.getConfig();
      if (!cfg || !cfg.enabled) return undefined;

      // 心跳 / 空消息没有检索键, 不记录 (与 cloudUpdateInterceptor 判定一致)
      const key = commandKeyOf(parsed);
      if (!key) return undefined;

      const record = {
        ts: now(),
        source,
        channel: label,
        channelId: moduleId === undefined ? null : moduleId,
        url: typeof parsed.url === "string" ? parsed.url : null,
        messageType:
          parsed.messageType === undefined ? null : parsed.messageType,
        key,
        traceId: typeof parsed.traceId === "string" ? parsed.traceId : null,
        data: parsed.data !== undefined ? parsed.data : null,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        action: "logged",
        intercepted: false,
        blocked: false,
        _logType: "cloud",
      };
      deps.writeRecord(record, cfg.retentionDays);
      deps.pushEvent(record);
    } catch (err) {
      console.error(`[HugoAura / WsAuditTap / ${label}] Record error:`, err);
    }
    return undefined;
  };

  // 标记本函数是"探针"而非拦截器 (便于诊断与去重)
  handler.__auraWsAuditTap = true;
  return handler;
};

/**
 * 向单个客户端安装审计探针。
 *
 * @param {any} client WS 客户端实例
 * @param {number | string} moduleId 客户端模块号
 * @param {any} deps makeTapHandler 的依赖
 * @param {{ refreshOnInstall?: boolean, refreshDelayMs?: number }} [options]
 * @returns {boolean} true=本次真的挂载了探针
 */
const installTapOnClient = (client, moduleId, deps, options = {}) => {
  if (!client || client[AUDIT_TAP_FLAG]) return false;

  // 固定模块号覆盖的通道 (390/399): 交给 cloudUpdateInterceptor
  if (SKIP_MODULE_IDS.has(Number(moduleId))) {
    client[AUDIT_TAP_FLAG] = true;
    return false;
  }

  // 已被 cloudUpdateInterceptor 覆盖: 打标记后跳过 (幂等, 不重复判定)
  if (isCoveredByExistingHook(client)) {
    client[AUDIT_TAP_FLAG] = true;
    return false;
  }

  try {
    const interceptors = ensureWsTrampoline(client);
    const handler = makeTapHandler(client, moduleId, deps);
    if (!interceptors.includes(handler)) interceptors.push(handler);
    client[AUDIT_TAP_FLAG] = true;
  } catch (err) {
    console.error(
      `[HugoAura / WsAuditTap] Failed to install tap on ${clientLabelOf(
        client,
        moduleId,
        deps.channelMap
      )}:`,
      err
    );
    return false;
  }

  // 蹦床要等连接重建后才生效 (基类 create() 已在闭包里固化了旧的 onMessage)
  if (options.refreshOnInstall !== false) {
    const delay = Number(options.refreshDelayMs) || 0;
    const label = clientLabelOf(client, moduleId, deps.channelMap);
    if (delay > 0) {
      const timer = setTimeout(() => refreshWsClient(client, label), delay);
      if (timer && typeof timer.unref === "function") timer.unref();
    } else {
      refreshWsClient(client, label);
    }
  }

  console.log(
    `[HugoAura / WsAuditTap] Audit tap installed on ${clientLabelOf(
      client,
      moduleId,
      deps.channelMap
    )} (module ${moduleId}).`
  );
  return true;
};

/**
 * 扫描并给所有尚未覆盖的 WS 客户端挂上审计探针。
 *
 * @param {(id: number) => any} central 模块加载器
 * @param {any} deps makeTapHandler 的依赖
 * @param {{ refreshOnInstall?: boolean }} [options]
 * @returns {{ total: number, installed: number }}
 */
const installAll = (central, deps, options = {}) => {
  const clients = collectWsClients(central);
  let installed = 0;
  let refreshIndex = 0;

  for (const { client, moduleId } of clients) {
    const ok = installTapOnClient(client, moduleId, deps, {
      refreshOnInstall: options.refreshOnInstall,
      // 错峰重连: 只在真正要刷新连接时递增
      refreshDelayMs: refreshIndex * REFRESH_STAGGER_MS,
    });
    if (ok) {
      installed++;
      refreshIndex++;
    }
  }

  return { total: clients.length, installed };
};

/**
 * 启动周期性重扫 (幂等)。客户端可能在管家启动后才懒加载创建。
 * @param {(id: number) => any} central
 * @param {() => any} depsFactory 每次重扫重新构造依赖 (保证读取最新配置)
 */
const startRescan = (central, depsFactory) => {
  if (rescanStarted) return;
  rescanStarted = true;

  const timer = setInterval(() => {
    try {
      const cfg = depsFactory().getConfig();
      if (!cfg || !cfg.enabled) return;
      installAll(central, depsFactory(), { refreshOnInstall: cfg.refreshOnInstall });
    } catch (err) {
      console.error("[HugoAura / WsAuditTap / Rescan Error]", err);
    }
  }, RESCAN_INTERVAL_MS);

  // 不要让定时器拖住进程退出 (Electron 主进程常驻, 但测试/退出路径需要)
  if (timer && typeof timer.unref === "function") timer.unref();
};

/**
 * @param {(id: number) => any} central 模块加载器
 */
const hookFunc = (central) => {
  // 模块缓存不可用 -> 无法枚举 WS 客户端。一次性告警并放弃, 而不是让 withRetry
  // 空转 30 次后只留一句 "not ready" (真机排查时看不出根因)。
  if (!central || !central.c || typeof central.c !== "object") {
    console.warn(
      "[HugoAura / WsAuditTap] central.c (webpack module cache) unavailable; " +
        "cannot enumerate WS clients. All-channel audit disabled " +
        "(hugoServiceWebsocket 399 / proxyWebsocketHost 390 are still audited by CloudUpdateInterceptor)."
    );
    return;
  }

  const electron = central(1);

  const readConfig = () => {
    try {
      const mgr = global.__HUGO_AURA_CONFIG_MGR__;
      if (!mgr) return null;
      return mgr.loadConfig();
    } catch (err) {
      console.error("[HugoAura / WsAuditTap / Error] Failed to read config:", err);
      return null;
    }
  };

  const getAuditConfig = () => {
    const config = readConfig();
    const cfg =
      config && config.auraSettings && config.auraSettings.cloudCommandAudit;
    return {
      enabled: !!(cfg && cfg.enabled),
      // 是否扫描"非云端主连接"的其他通道 (默认开启)
      tapAllChannels: !(cfg && cfg.tapAllChannels === false),
      // 首次安装是否主动重连以激活探针 (默认开启)
      refreshOnInstall: !(cfg && cfg.refreshOnInstall === false),
      retentionDays:
        cfg && Number.isFinite(cfg.retentionDays) && cfg.retentionDays > 0
          ? cfg.retentionDays
          : 7,
    };
  };

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
      console.error("[HugoAura / WsAuditTap / Audit / Push Error]", err);
    }
  };

  const writeRecord = (record, retentionDays) => {
    try {
      // retentionDays 交给共享写入器: 任何写入都会顺带触发按天清理
      auditWriter.writeAudit(AUDIT_FILE, record, { retentionDays });
    } catch (err) {
      console.error("[HugoAura / WsAuditTap / Audit / Write Error]", err);
    }
  };

  // 通道名映射: 管家 WS 配置表 (模块 0 是应用读取的那份, 174 是定义处)。
  // 拿不到就退化为 URL 最后一段, 不影响采集本身。
  let channelMapCache = null;
  const getChannelMap = () => {
    if (channelMapCache) return channelMapCache;
    const map = {};
    for (const id of [0, 174]) {
      try {
        const table = resolveModule(central, id);
        Object.assign(map, buildChannelMap(table));
      } catch {
        // 单个模块取不到不影响另一个
      }
    }
    if (Object.keys(map).length > 0) channelMapCache = map;
    return map;
  };

  const depsFactory = () => ({
    getConfig: getAuditConfig,
    writeRecord,
    pushEvent: pushAuditEvent,
    channelMap: getChannelMap(),
  });

  withRetry(
    () => {
      const cfg = getAuditConfig();
      // 未启用审计: 无需等待, 也无需重试
      if (!cfg.enabled || !cfg.tapAllChannels) return true;

      const { total } = installAll(central, depsFactory(), {
        refreshOnInstall: cfg.refreshOnInstall,
      });

      // 一个 WS 客户端都还没创建 -> 继续重试 (模块懒加载)
      if (total === 0) return false;

      startRescan(central, depsFactory);
      return true;
    },
    { label: "WsAuditTap" }
  )();
};

module.exports = {
  hookFunc,
  clientLabelOf,
  sourceOf,
  urlPathOf,
  buildChannelMap,
  collectWsClients,
  isCoveredByExistingHook,
  makeTapHandler,
  installTapOnClient,
  installAll,
  AUDIT_TAP_FLAG,
  RESCAN_INTERVAL_MS,
  REFRESH_STAGGER_MS,
};
