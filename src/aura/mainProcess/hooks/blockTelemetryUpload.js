// @ts-check

/**
 * 阻断管家向原厂上报 (Block Telemetry Upload) 主进程钩子
 *
 * 背景: 本程序是注入式修改版, 管家进程内同时跑着我们的代码, 产生的异常样本 /
 * 埋点数据并不代表原版行为。这类数据若被上传到原厂服务器, 只会让原厂把问题
 * 归因到原版管家身上。
 *
 * 与 jsRewrite 的区别: jsRewrite 全部基于 Electron session.webRequest, 只能看到
 * 渲染层 (Chromium 网络栈) 的请求。管家的 Friday 埋点模块在 main.js 里用
 * require("http").request(name.js 里是 n(50)) 直连上报, 走的是主进程 Node 网络栈,
 * webRequest 规则结构上拦不到, 只能在 Node 模块层兜。
 *
 * 拦截方式: 包裹 require("http") / require("https") 的 request 与 get。
 * 本钩子与管家 main.js 处于同一个 Node 运行时、同一个模块缓存, main.js 里的
 * 外部依赖写成 `e.exports=require("http")`, 取到的正是我们包裹过的同一个对象,
 * 所以包裹必然生效, 且不依赖模块号 (版本漂移安全)。
 *
 * 每条规则绑定设置页里对应的开关 (均需重启生效), 命中 host+path 后才会去读配置,
 * 普通请求零开销:
 *   /bugly/         <- 「禁用 Bugly 崩溃上报」 networkRewrite.disableBuglyReport
 *   /friday/agent/  <- 「禁用 Friday 错误统计」 networkRewrite.disableFriday
 *
 * 规则刻意收窄到"上报路径", 不整站封禁 —— myou.cvte.com 同时是 cStore 内容下载
 * 域 (机型人脸库等), 整站封禁会误伤正常功能。
 */

const { EventEmitter } = require("events");

/** 仅拦截上报入口, 其余同域请求照常放行 */
const BLOCK_RULES = [
  { host: "sunday.cvte.com", pathPrefix: "/bugly/", gate: "disableBuglyReport" },
  { host: "myou.cvte.com", pathPrefix: "/friday/agent/", gate: "disableFriday" },
];

const readConfig = () => {
  try {
    const mgr = global.__HUGO_AURA_CONFIG_MGR__;
    if (!mgr) return null;
    return mgr.loadConfig();
  } catch (err) {
    console.error("[HugoAura / TelemetryBlock / Error] Failed to read config:", err);
    return null;
  }
};

/**
 * @param {string} gate networkRewrite 下的开关名
 */
const isGateEnabled = (gate) => {
  const config = readConfig();
  const entry = config && config.networkRewrite && config.networkRewrite[gate];
  return Boolean(entry && entry.enabled);
};

/**
 * 兼容 http.request(url[, options][, cb]) 与 http.request(options[, cb]) 两种形态
 * @param {any[]} args
 * @returns {{ host: string, path: string } | null}
 */
const resolveTarget = (args) => {
  const first = args[0];

  if (typeof first === "string") {
    try {
      const parsed = new URL(first);
      return { host: parsed.hostname.toLowerCase(), path: parsed.pathname };
    } catch (_err) {
      return null;
    }
  }

  if (first && typeof first === "object") {
    const rawHost = String(first.hostname || first.host || "");
    return {
      host: rawHost.toLowerCase().split(":")[0],
      path: String(first.path || "/"),
    };
  }

  return null;
};

/**
 * @param {{ host: string, path: string } | null} target
 */
const matchRule = (target) =>
  target
    ? BLOCK_RULES.find(
        (rule) =>
          target.host === rule.host && target.path.startsWith(rule.pathPrefix)
      ) || null
    : null;

/**
 * 构造一个"永不连接"的 ClientRequest 替身, 保证调用方的
 * `.on("error", ...)` / `.write(...)` / `.end()` 不抛异常
 */
const createDroppedRequest = () => {
  const req = new EventEmitter();
  req.write = () => true;
  req.end = () => req;
  req.abort = () => req;
  req.destroy = () => req;
  req.setTimeout = () => req;
  req.setHeader = () => req;
  req.getHeader = () => undefined;
  req.removeHeader = () => req;
  req.flushHeaders = () => {};

  // 仅在调用方注册了 error 监听时派发, 避免 unhandled "error" 把进程打崩
  setImmediate(() => {
    if (req.listenerCount("error") > 0) {
      req.emit("error", new Error("Blocked by HugoAura (telemetry upload)"));
    }
  });

  return req;
};

const hookFn = () => {
  for (const moduleName of ["http", "https"]) {
    let httpModule;
    try {
      httpModule = require(moduleName);
    } catch (err) {
      console.warn(
        `[HugoAura / TelemetryBlock] Failed to require "${moduleName}":`,
        err
      );
      continue;
    }

    if (!httpModule || httpModule.__auraTelemetryBlockInstalled) continue;

    for (const fnName of ["request", "get"]) {
      const original = httpModule[fnName];
      if (typeof original !== "function") continue;

      httpModule[fnName] = function (...args) {
        const rule = matchRule(resolveTarget(args));
        if (rule && isGateEnabled(rule.gate)) {
          console.log(
            `[HugoAura / TelemetryBlock] Blocked ${moduleName}.${fnName} -> ${rule.host}${rule.pathPrefix} (switch: ${rule.gate})`
          );
          return createDroppedRequest();
        }
        return original.apply(this, args);
      };
    }

    httpModule.__auraTelemetryBlockInstalled = true;
    console.log(
      `[HugoAura / TelemetryBlock] Outbound upload block installed for "${moduleName}".`
    );
  }
};

module.exports = { hookFunc: hookFn };
