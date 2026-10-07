// @ts-check

/**
 * 出站 HTTP 响应审计探针 (Outbound HTTP Response Audit Tap)
 *
 * 背景: 管家的云端下行指令走 WebSocket (已由 cloudUpdateInterceptor + wsAuditTap
 * 全覆盖), 但管家还会**主动**通过 HTTPS 调用本地 SeewoProxyHTTP 代理上报/查询,
 * 例如:
 *   GET  /api/v1/device/id          -> 响应里带回设备号
 *   POST /api/v1/screenlock/lockfeedback
 *   POST /api/v1/uips/feedback
 * 这些调用的**响应体**此前完全不在审计范围内 —— 若云端把指令塞在某个响应里,
 * 审计页是看不到的。本探针补上这一段。
 *
 * 咽喉点取证 (app_unpacked/main.js, 管家 4010):
 *   - 模块 11 是唯一的 HTTP 发送器: `send(host, port, path, method, body, cb)`,
 *     回调约定 `cb(responseObject)` / `cb("", error)`。
 *   - 模块 11 依赖 `n(281)`, 而 281 是 follow-redirects; 它的导出形如
 *     `v({ http: n(50), https: n(104) })`, 其中 `https.request` 是
 *     `Object.defineProperties(..., { value: fn, configurable: true, writable: true })`
 *     —— **可写可重定义**, 且模块 11 只捕获了 `n(281).https` 这个**对象**
 *     (`const o = n(281).https`), 调用时做属性查找 `o.request(...)`。
 *   因此替换 `n(281).https.request` 即可拦下模块 11 的全部 HTTP 调用, 且:
 *     - 不受"模块已执行、函数引用已固化"影响 (不同于替换模块导出);
 *     - 影响面很窄 —— 全 bundle 只有模块 11 引用 n(281)。
 *
 * 行为约定: 只观察, 不改写任何参数/返回值, 不消费响应; 任何异常都只跳过该次记录,
 * 绝不影响原请求。请求体通过包装 `req.write` 采集, 响应体通过 `response` 事件采集。
 */

const { withRetry, resolveModule, shouldScan, resolveByScan } = require("./retryHook");
const auditWriter = require("./auditWriter");
// 管家内置 Node 较老, 全局没有 performance, 必须显式引入 perf_hooks
// (漏了它会每条 https 请求抛一次 ReferenceError, 出站审计完全不生效)
const { performance } = require("perf_hooks");

const AUDIT_FILE = "cloudCommandAudit.log";

// follow-redirects 模块号 (失配时按导出特征扫描兜底)
const HTTP_PROVIDER_MODULE_ID = 281;
// 挂载标记 (幂等: 多窗口 / 重试场景只包一次)
const HTTP_TAP_FLAG = "__auraHttpAuditTap";
// 采集体上限: 审计记录不该把大响应整体吞进日志
const MAX_BODY_BYTES = 64 * 1024;
// 审计页「通道」列显示名
const CHANNEL_LABEL = "SeewoProxyHTTP";

/**
 * 判定"这个模块导出是不是 follow-redirects 风格的 http/https 提供者"。
 * 用于模块号漂移时的扫描兜底 (只读判定, 不执行模块)。
 *
 * @param {any} mod
 * @returns {boolean}
 */
const isHttpProviderLike = (mod) => {
  if (!mod || typeof mod !== "object") return false;
  const https = mod.https;
  const http = mod.http;
  return (
    Boolean(https && typeof https.request === "function") &&
    Boolean(http && typeof http.request === "function")
  );
};

/**
 * 从 options 里取请求描述 (纯函数, 便于单测)。
 * 兼容 `request(options, cb)` 与 `request(url, options, cb)` 两种调用形态 ——
 * 后者由 follow-redirects 在内部归一化, 我们只处理已归一化的 options。
 *
 * @param {any} options
 * @returns {{ path: string, method: string, host: string }}
 */
const describeRequest = (options) => {
  const opts = options && typeof options === "object" ? options : {};
  const path =
    typeof opts.path === "string" && opts.path.length > 0
      ? opts.path
      : typeof opts.href === "string"
        ? opts.href
        : "";
  const method =
    typeof opts.method === "string" && opts.method.length > 0
      ? opts.method.toUpperCase()
      : "GET";
  const hostname =
    opts.hostname || opts.host || opts.href || "";
  const port = opts.port ? `:${opts.port}` : "";
  return { path, method, host: `${hostname}${port}` };
};

/** 安全解析 JSON, 失败返回 null */
const tryParseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * 组装一条出站 HTTP 审计记录 (纯函数, 便于单测)。
 *
 * @param {any} options https.request 的 options
 * @param {{ statusCode?: number, body?: string, requestBody?: string, error?: any }} outcome
 * @param {string} ts ISO 时间
 * @returns {any}
 */
const buildHttpRecord = (options, outcome, ts) => {
  const { path, method, host } = describeRequest(options);
  const responseParsed = outcome.body ? tryParseJson(outcome.body) : null;
  const requestParsed = outcome.requestBody ? tryParseJson(outcome.requestBody) : null;
  const responseMessageType =
    responseParsed && responseParsed.messageType !== undefined
      ? responseParsed.messageType
      : null;

  return {
    ts,
    source: host || "unknown",
    channel: CHANNEL_LABEL,
    channelId: HTTP_PROVIDER_MODULE_ID,
    // 出站请求的"指令"就是它请求的路径 —— 与审计页 KNOWN_COMMANDS 的键一致
    url: path || null,
    key: path || "(unidentified)",
    method,
    direction: "outbound",
    httpStatus:
      outcome.statusCode === undefined ? null : outcome.statusCode,
    messageType: responseMessageType,
    traceId:
      responseParsed && typeof responseParsed.traceId === "string"
        ? responseParsed.traceId
        : null,
    // data 保持"响应体"语义, 与其它记录一致; 请求体单列 requestData
    data: responseParsed !== null ? responseParsed : outcome.body || null,
    requestData: requestParsed !== null ? requestParsed : outcome.requestBody || null,
    error: outcome.error ? String(outcome.error.message || outcome.error) : null,
    // 发起 -> 响应结束的真实耗时 (ms); 仅出站 HTTP 有, 其它记录为 null
    durationMs:
      typeof outcome.durationMs === "number" && Number.isFinite(outcome.durationMs)
        ? Math.round(outcome.durationMs * 100) / 100
        : null,
    action: "logged",
    intercepted: false,
    blocked: false,
    // 与云端指令区分: 出站响应不计入「未识别指令」统计 (那是给未知下行指令用的)
    _logType: "http",
  };
};

/**
 * 观察一个请求: 采集请求体 / 响应体 / 错误, 然后写审计。
 *
 * 全程只读 —— 不改写 options、不消费响应、不改动返回值。
 *
 * @param {any} req https.request 返回的请求对象
 * @param {any} options 原始 options
 * @param {any} deps 依赖注入 (便于单测)
 */
const observeRequest = (req, options, deps) => {
  const chunks = [];
  let size = 0;
  let requestBody = "";
  // 发起 -> 响应结束的真实耗时 (整个探针里唯一有意义的"操作耗时")
  const startedAt = performance.now();

  // 请求体: 模块 11 通过 req.write(JSON.stringify(body)) 写入
  try {
    const originalWrite = req.write;
    if (typeof originalWrite === "function") {
      req.write = function (chunk, ...rest) {
        try {
          if (typeof chunk === "string" && requestBody.length < MAX_BODY_BYTES) {
            requestBody += chunk;
          } else if (Buffer.isBuffer(chunk) && requestBody.length < MAX_BODY_BYTES) {
            requestBody += chunk.toString("utf8");
          }
        } catch {
          // 采集失败不影响请求
        }
        return originalWrite.apply(this, [chunk, ...rest]);
      };
    }
  } catch {
    // 某些实现可能禁止改写 write, 忽略
  }

  const record = (outcome) => {
    try {
      const cfg = deps.getConfig();
      if (!cfg || !cfg.enabled) return;
      const rec = buildHttpRecord(options, outcome, deps.now());
      deps.writeRecord(rec, cfg.retentionDays);
      deps.pushEvent(rec);
    } catch (err) {
      console.error("[HugoAura / HttpAuditTap] Record error:", err);
    }
  };

  try {
    req.on("response", (res) => {
      try {
        res.on("data", (chunk) => {
          try {
            if (size >= MAX_BODY_BYTES) return;
            chunks.push(chunk);
            size += chunk.length;
          } catch {
            // 忽略
          }
        });
        res.on("end", () => {
          let body = "";
          try {
            body = Buffer.concat(chunks).toString("utf8");
          } catch {
            body = "";
          }
          record({
            statusCode: res && res.statusCode,
            body,
            requestBody,
            durationMs: performance.now() - startedAt,
          });
        });
      } catch (err) {
        console.error("[HugoAura / HttpAuditTap] Response observe error:", err);
      }
    });

    req.on("error", (err) => {
      record({
        requestBody,
        error: err,
        durationMs: performance.now() - startedAt,
      });
    });
  } catch (err) {
    console.error("[HugoAura / HttpAuditTap] Request observe error:", err);
  }
};

/**
 * 给 follow-redirects 的 https.request 打补丁 (幂等)。
 *
 * @param {any} provider 模块 281 的导出 ({ http, https })
 * @param {any} deps 依赖注入
 * @returns {boolean} true=已安装 (含此前已安装)
 */
const installHttpAuditTap = (provider, deps) => {
  const https = provider && provider.https;
  if (!https || typeof https.request !== "function") return false;
  if (https[HTTP_TAP_FLAG]) return true;

  const originalRequest = https.request;
  https.request = function (options, ...rest) {
    const req = originalRequest.apply(this, [options, ...rest]);
    try {
      observeRequest(req, options, deps);
    } catch (err) {
      console.error("[HugoAura / HttpAuditTap] Observe install error:", err);
    }
    return req;
  };
  // 标记 + 便于诊断时识别
  https[HTTP_TAP_FLAG] = true;
  console.log(
    `[HugoAura / HttpAuditTap] Outbound HTTP response audit installed (module ${HTTP_PROVIDER_MODULE_ID}).`
  );
  return true;
};

/**
 * @param {(id: number) => any} central 模块加载器
 */
const hookFunc = (central) => {
  const electron = central(1);

  const readConfig = () => {
    try {
      const mgr = global.__HUGO_AURA_CONFIG_MGR__;
      if (!mgr) return null;
      return mgr.loadConfig();
    } catch (err) {
      console.error("[HugoAura / HttpAuditTap / Error] Failed to read config:", err);
      return null;
    }
  };

  const getAuditConfig = () => {
    const config = readConfig();
    const cfg =
      config && config.auraSettings && config.auraSettings.cloudCommandAudit;
    return {
      enabled: !!(cfg && cfg.enabled),
      // 出站 HTTP 响应审计开关 (默认开启)
      auditHttpResponses: !(cfg && cfg.auditHttpResponses === false),
      retentionDays:
        cfg && Number.isFinite(cfg.retentionDays) && cfg.retentionDays > 0
          ? cfg.retentionDays
          : 7,
    };
  };

  const pushAuditEvent = (rec) => {
    try {
      if (
        electron &&
        electron.ipcMain &&
        typeof electron.ipcMain.send === "function"
      ) {
        electron.ipcMain.send("*", "$aura.audit.onLog", { record: rec });
      }
    } catch (err) {
      console.error("[HugoAura / HttpAuditTap / Audit / Push Error]", err);
    }
  };

  const deps = {
    getConfig: () => {
      const cfg = getAuditConfig();
      // 任一开关关闭都不采集
      return cfg.enabled && cfg.auditHttpResponses
        ? cfg
        : { ...cfg, enabled: false };
    },
    writeRecord: (rec, retentionDays) => {
      try {
        auditWriter.writeAudit(AUDIT_FILE, rec, { retentionDays });
      } catch (err) {
        console.error("[HugoAura / HttpAuditTap / Audit / Write Error]", err);
      }
    },
    pushEvent: pushAuditEvent,
    now: () => new Date().toISOString(),
  };

  withRetry(
    () => {
      let provider = null;
      try {
        provider = resolveModule(central, HTTP_PROVIDER_MODULE_ID);
      } catch {
        provider = null;
      }

      // 模块号漂移兜底: 按导出特征扫描 (只读判定)
      if (!isHttpProviderLike(provider) && shouldScan("HttpAuditTap")) {
        const recovered = resolveByScan(
          central,
          ["nativeProtocols", "maxRedirects"],
          isHttpProviderLike
        );
        if (recovered) {
          provider = recovered.mod;
          console.warn(
            `[HugoAura / HttpAuditTap] module ${HTTP_PROVIDER_MODULE_ID} unavailable, ` +
              `recovered via ${recovered.how} (module ${recovered.id}).`
          );
        }
      }

      if (!isHttpProviderLike(provider)) return false;
      return installHttpAuditTap(provider, deps);
    },
    { label: "HttpAuditTap" }
  )();
};

module.exports = {
  hookFunc,
  isHttpProviderLike,
  describeRequest,
  buildHttpRecord,
  observeRequest,
  installHttpAuditTap,
  tryParseJson,
  HTTP_PROVIDER_MODULE_ID,
  HTTP_TAP_FLAG,
  MAX_BODY_BYTES,
  CHANNEL_LABEL,
};
