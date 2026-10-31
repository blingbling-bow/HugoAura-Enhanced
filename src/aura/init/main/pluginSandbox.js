// @ts-check

/**
 * 插件沙箱 (main 类型插件) —— vm 能力沙箱宿主侧。
 *
 * 边界规则 (详见 pluginSandboxPrelude.js 头注释):
 * 1. 沙箱内无 require / process / Buffer / fs / electron / central;
 * 2. 跨边界数据一律 JSON 字符串; 沙箱回调由宿主持有并喂 JSON 字符串;
 * 3. 插件可见函数全部在沙箱 realm 构建 (宿主能力经 __invoke 单入口分发,
 *    预热后删除宿主入口, 关闭 .constructor 逃逸);
 * 4. 权限门控: storage / network / events 未声明即不暴露, 分发时二次校验;
 * 5. 资源限制: 定时器 ≤16、日志限长、网络响应 ≤1MB/10s、加载限时。
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const http = require("http");
const https = require("https");
const { validateUrlResolved } = require("../../utils/urlSafety");

const MAX_TIMERS = 16;
const MAX_LOG_CHARS = 2000;
const NET_MAX_BYTES = 1024 * 1024;
const NET_TIMEOUT_MS = 10000;
const SETTINGS_MAX_BYTES = 256 * 1024;
const SUPPORTED_PERMISSIONS = ["storage", "network", "events"];

const PRELUDE_PATH = path.join(__dirname, "pluginSandboxPrelude.js");

/** manifest 声明的权限里, 本沙箱支持且被授予的 (去重) */
const resolveGrantedPermissions = (manifest) => {
  const declared = Array.isArray(manifest && manifest.permissions)
    ? manifest.permissions
    : [];
  const keys = declared
    .map((p) => (p && typeof p.key === "string" ? p.key : ""))
    .filter((key) => SUPPORTED_PERMISSIONS.includes(key));
  return Array.from(new Set(keys));
};

/**
 * 运行 main 插件源码于 vm 能力沙箱。
 * @param {{
 *   source: string,
 *   manifest: any,
 *   auraVersion?: string,
 *   permissionsGranted?: string[],
 *   evalTimeoutMs?: number,
 *   settingsApi?: { get: () => any, set: (values: any) => any },
 *   busApi?: { on: Function, off: Function, emit: Function },
 *   log?: (level: string, line: string) => void,
 * }} options
 * @returns {{ instance: any, ctx: any, dispose: () => void, grantedPermissions: string[] }}
 */
const runMainPlugin = (options) => {
  const {
    source,
    manifest,
    auraVersion = "",
    permissionsGranted = [],
    evalTimeoutMs = 3000,
    settingsApi,
    busApi,
    log = () => {},
  } = options || {};

  const pluginId = String((manifest && manifest.id) || "unknown-plugin");
  const granted = permissionsGranted.length
    ? permissionsGranted.filter((k) => SUPPORTED_PERMISSIONS.includes(k))
    : resolveGrantedPermissions(manifest);

  // ---- 宿主能力: 定时器 (上限 + dispose 全量回收) ----
  const timers = new Map();
  let timerSeq = 0;
  const safeCall = (cb) => {
    try {
      cb();
    } catch (err) {
      log("error", `定时器回调异常: ${err && err.message ? err.message : err}`);
    }
  };
  const timerSet = (kind, ms, cb) => {
    if (timers.size >= MAX_TIMERS) {
      log("warn", `定时器已达上限 (${MAX_TIMERS}), 新定时器被拒绝`);
      return null;
    }
    const delay = Number(ms);
    if (!Number.isFinite(delay) || delay < 0) return null;
    const id = ++timerSeq;
    const timer =
      kind === "interval"
        ? setInterval(() => safeCall(cb), Math.min(delay, 60000))
        : setTimeout(() => {
            timers.delete(id);
            safeCall(cb);
          }, Math.min(delay, 600000));
    timers.set(id, timer);
    return id;
  };
  const timerClear = (id) => {
    const t = timers.get(Number(id));
    if (!t) return;
    timers.delete(Number(id));
    clearInterval(t);
    clearTimeout(t);
  };

  // ---- 宿主能力: 日志限长 ----
  const logLine = (level, line) => {
    const text = String(line);
    const capped =
      text.length > MAX_LOG_CHARS ? text.slice(0, MAX_LOG_CHARS) + "…" : text;
    log(level, capped);
  };

  // ---- 宿主能力: 事件命名空间 ($aura.plugin.<id> 与其子通道) ----
  const eventPrefix = `$aura.plugin.${pluginId}`;
  const isOwnEvent = (event) =>
    typeof event === "string" &&
    (event === eventPrefix || event.startsWith(eventPrefix + "."));

  // ---- 宿主能力: 网络 GET (urlSafety + 1MB/10s 上限) ----
  const netFetch = (url) =>
    new Promise((resolve) => {
      validateUrlResolved(url)
        .then((safety) => {
          if (!safety.ok) {
            resolve(
              JSON.stringify({ status: 0, error: `UNSAFE_URL: ${safety.reason}` })
            );
            return;
          }
          const transport = safety.url.protocol === "https:" ? https : http;
          const req = transport.get(safety.url, (res) => {
            const status = res.statusCode || 0;
            if (status !== 200) {
              res.resume();
              resolve(JSON.stringify({ status, body: "" }));
              return;
            }
            let size = 0;
            const chunks = [];
            res.on("data", (chunk) => {
              size += chunk.length;
              if (size > NET_MAX_BYTES) {
                res.destroy();
                resolve(JSON.stringify({ status, error: "RESPONSE_TOO_LARGE" }));
                return;
              }
              chunks.push(chunk);
            });
            res.on("end", () => {
              resolve(
                JSON.stringify({
                  status,
                  body: Buffer.concat(chunks).toString("utf8"),
                })
              );
            });
            res.on("error", () =>
              resolve(JSON.stringify({ status, error: "NETWORK_ERROR" }))
            );
          });
          req.setTimeout(NET_TIMEOUT_MS, () => {
            req.destroy();
            resolve(JSON.stringify({ status: 0, error: "TIMEOUT" }));
          });
          req.on("error", () =>
            resolve(JSON.stringify({ status, error: "NETWORK_ERROR" }))
          );
        })
        .catch(() =>
          resolve(JSON.stringify({ status: 0, error: "NETWORK_ERROR" }))
        );
    });

  // ---- 配置快照 (只读; settingsPassword* 脱敏) ----
  const configSnapshotJson = () => {
    try {
      const clone = JSON.parse(
        JSON.stringify(
          (global.__HUGO_AURA_CONFIG__ && global.__HUGO_AURA_CONFIG__) || {}
        )
      );
      const au = clone.auraSettings;
      if (au) {
        au.settingsPasswordEnabled = undefined;
        au.settingsPasswordWithSalt = undefined;
      }
      return JSON.stringify(clone);
    } catch {
      return "{}";
    }
  };

  // ---- 事件回调包装注册表 (busOn/busOff 用同一 wrapped 配对) ----
  const busWrappers = [];

  // ---- 单入口分发 (宿主函数; 权限二次校验) ----
  const invoke = (method, args) => {
    switch (method) {
      case "log":
        logLine(String(args[0] || "log"), args[1]);
        return undefined;
      case "timerSet":
        return timerSet(String(args[0]), args[1], args[2]);
      case "timerClear":
        timerClear(args[0]);
        return undefined;
      case "settingsGet":
        if (!granted.includes("storage")) throw new Error("PERMISSION_DENIED: storage");
        return JSON.stringify(settingsApi ? settingsApi.get() : {});
      case "settingsSet": {
        if (!granted.includes("storage")) throw new Error("PERMISSION_DENIED: storage");
        if (typeof args[0] !== "string" || args[0].length > SETTINGS_MAX_BYTES) {
          throw new Error("INVALID_SETTINGS");
        }
        // 回显写入值 (底层 writePluginSettings 可能不返回值, JSON.stringify
        // 会得到 undefined 导致沙箱侧 JSON.parse 抛错)
        const parsed = JSON.parse(args[0]);
        settingsApi.set(parsed);
        return JSON.stringify(parsed === undefined ? {} : parsed);
      }
      case "busOn": {
        if (!granted.includes("events")) throw new Error("PERMISSION_DENIED: events");
        if (!isOwnEvent(args[0])) throw new Error(`EVENT_NAMESPACE_DENIED: ${args[0]}`);
        if (typeof args[1] !== "function") throw new Error("CALLBACK_REQUIRED");
        const wrapped = (payload) => {
          try {
            args[1](JSON.stringify(payload === undefined ? null : payload));
          } catch (err) {
            log("error", `事件回调异常: ${err && err.message ? err.message : err}`);
          }
        };
        busApi.on(args[0], wrapped);
        busWrappers.push({ event: args[0], raw: args[1], wrapped });
        return true;
      }
      case "busOff": {
        if (!granted.includes("events")) throw new Error("PERMISSION_DENIED: events");
        if (!isOwnEvent(args[0])) throw new Error(`EVENT_NAMESPACE_DENIED: ${args[0]}`);
        if (typeof args[1] !== "function") throw new Error("CALLBACK_REQUIRED");
        for (let i = busWrappers.length - 1; i >= 0; i--) {
          const e = busWrappers[i];
          if (e.event === args[0] && e.raw === args[1]) {
            busApi.off(args[0], e.wrapped);
            busWrappers.splice(i, 1);
            return true;
          }
        }
        return false;
      }
      case "busEmit":
        if (!granted.includes("events")) throw new Error("PERMISSION_DENIED: events");
        if (!isOwnEvent(args[0])) throw new Error(`EVENT_NAMESPACE_DENIED: ${args[0]}`);
        busApi.emit(args[0], JSON.parse(args[1] || "null"));
        return true;
      case "configGet":
        return configSnapshotJson();
      case "netFetch":
        if (!granted.includes("network")) throw new Error("PERMISSION_DENIED: network");
        return netFetch(String(args[0]));
      default:
        throw new Error(`UNKNOWN_HOST_METHOD: ${method}`);
    }
  };

  // ---- 沙箱上下文 (仅宿主入口 + 数据; 预热后宿主入口被删除) ----
  const sandbox = {
    module: { exports: {} },
    __host: {
      invoke: (method, args) => invoke(method, args || []),
      invokeAsync: (method, args) => {
        try {
          return Promise.resolve(invoke(method, args || []));
        } catch (err) {
          return Promise.reject(err);
        }
      },
    },
    __manifestJson: JSON.stringify(manifest || {}),
    __auraVersion: String(auraVersion || ""),
    __grant: (key) => granted.includes(key),
    __storageDir: "",
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(PRELUDE_PATH, "utf8"),
    context,
    { timeout: evalTimeoutMs }
  );

  // 运行插件源码 (module.exports 形态), 限时防加载期死循环
  const src = `${String(source || "")}\n;module.exports;`;
  vm.runInContext(src, context, { timeout: evalTimeoutMs });

  const instance = sandbox.module.exports;
  const ctx = sandbox.__ctx;

  const dispose = () => {
    for (const t of timers.values()) {
      clearInterval(t);
      clearTimeout(t);
    }
    timers.clear();
  };

  return { instance, ctx, dispose, grantedPermissions: granted };
};

module.exports = { runMainPlugin, resolveGrantedPermissions, SUPPORTED_PERMISSIONS };
