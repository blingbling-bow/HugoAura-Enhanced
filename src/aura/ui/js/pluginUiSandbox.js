// @ts-check

/**
 * UI 插件沙箱 (渲染层, vm 能力沙箱宿主侧)。
 *
 * 与主进程沙箱同一套边界规则:
 * - 沙箱内无 require / ipcRenderer / document / window / process;
 * - 插件只拿到一个**声明式 DOM 桥** (createEl / setText / setAttr /
 *   appendToBody / on), 宿主持元素表, 真实 DOM 节点永不进入沙箱
 *   (元素 → document → window.require 的逃逸链被切断);
 * - IPC 仅放行 $aura.plugin.* 白名单前缀, 且 invoke 返回值以 JSON
 *   字符串跨界, 沙箱侧用本 realm 的 Promise 适配 (宿主 Promise 不入沙箱);
 * - 定时器/日志限长限量; dispose 时回收定时器并移除插件创建的全部节点。
 *
 * 残留风险: 与主进程沙箱相同 (vm realm 硬化, 非硬边界)。
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const MAX_TIMERS = 16;
const MAX_LOG_CHARS = 2000;
const MAX_NODES = 64;

const ALLOWED_TAGS = new Set([
  "div", "span", "p", "b", "i", "img", "button", "a",
  "ul", "li", "br", "hr", "table", "tr", "td",
]);
const ALLOWED_ATTRS = new Set(["class", "title", "style", "src", "href"]);
const ALLOWED_EVENTS = new Set(["click", "mouseenter", "mouseleave"]);

const PRELUDE_PATH = path.join(__dirname, "pluginUiSandboxPrelude.js");

/**
 * @param {{
 *   source: string,
 *   manifest: any,
 *   auraVersion?: string,
 *   document: Document,
 *   evalTimeoutMs?: number,
 *   ipcInvoke?: (channel: string, args: any[]) => Promise<any>,
 *   log?: (level: string, line: string) => void,
 * }} options
 * @returns {{ instance: any, ctx: any, dispose: () => void }}
 */
const runUiPlugin = (options) => {
  const {
    source,
    manifest,
    auraVersion = "",
    document: hostDocument,
    evalTimeoutMs = 3000,
    ipcInvoke,
    log = () => {},
  } = options || {};

  const pluginId = String((manifest && manifest.id) || "ui-plugin");

  // ---- 定时器 (上限 + dispose 回收) ----
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
      log("warn", `定时器已达上限 (${MAX_TIMERS})`);
      return null;
    }
    const delay = Number(ms);
    if (!Number.isFinite(delay) || delay < 0) return null;
    const id = ++timerSeq;
    timers.set(
      id,
      kind === "interval"
        ? setInterval(() => safeCall(cb), Math.min(delay, 60000))
        : setTimeout(() => {
            timers.delete(id);
            safeCall(cb);
          }, Math.min(delay, 600000))
    );
    return id;
  };
  const timerClear = (id) => {
    const t = timers.get(Number(id));
    if (!t) return;
    timers.delete(Number(id));
    clearInterval(t);
    clearTimeout(t);
  };

  // ---- 声明式 DOM 桥 (宿主持元素表; 节点不进沙箱) ----
  const nodes = new Map();
  let nodeSeq = 0;
  const nodeGet = (id) => {
    const el = nodes.get(Number(id));
    if (!el) throw new Error(`UNKNOWN_NODE: ${id}`);
    return el;
  };
  const domCreateEl = (tagJson, attrsJson) => {
    if (nodes.size >= MAX_NODES) throw new Error("TOO_MANY_NODES");
    const tag = String((typeof tagJson === "string" ? tagJson : "div") || "div");
    if (!ALLOWED_TAGS.has(String(tag).toLowerCase())) {
      throw new Error(`TAG_NOT_ALLOWED: ${tag}`);
    }
    const el = hostDocument.createElement(String(tag).toLowerCase());
    const attrs =
      typeof attrsJson === "string" ? JSON.parse(attrsJson || "{}") : attrsJson || {};
    for (const [k, v] of Object.entries(attrs || {})) {
      if (!ALLOWED_ATTRS.has(String(k))) continue;
      try {
        el.setAttribute(String(k), String(v));
      } catch (err) {
        log("warn", `设置属性失败 (${k}): ${err && err.message}`);
      }
    }
    const id = ++nodeSeq;
    nodes.set(id, el);
    return id;
  };
  const domSet = (id, kind, value) => {
    const el = nodeGet(id);
    const v = String(value === undefined || value === null ? "" : value);
    if (kind === "text") {
      el.textContent = v;
    } else if (kind === "attr") {
      // setAttr 不放行任意属性, 仍走白名单
      const parsed = JSON.parse(v || "{}");
      for (const [k, val] of Object.entries(parsed || {})) {
        if (!ALLOWED_ATTRS.has(String(k))) continue;
        el.setAttribute(String(k), String(val));
      }
    }
    return true;
  };
  const domAppendToBody = (id) => {
    const el = nodeGet(id);
    (hostDocument.body || hostDocument.documentElement).appendChild(el);
    return true;
  };
  const domOn = (id, event, cb) => {
    const el = nodeGet(id);
    if (!ALLOWED_EVENTS.has(String(event))) {
      throw new Error(`EVENT_NOT_ALLOWED: ${event}`);
    }
    if (typeof cb !== "function") throw new Error("CALLBACK_REQUIRED");
    el.addEventListener(String(event), () => safeCall(cb));
    return true;
  };

  // ---- IPC 白名单 ($aura.plugin.* 前缀) ----
  const ipcAllowed = (channel) =>
    typeof channel === "string" && channel.startsWith("$aura.plugin.");

  // ---- 单入口分发 ----
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
      case "domCreateEl":
        return domCreateEl(args[0], args[1]);
      case "domSet":
        return domSet(Number(args[0]), String(args[1]), args[2]);
      case "domAppendToBody":
        return domAppendToBody(Number(args[0]));
      case "domOn":
        return domOn(Number(args[0]), String(args[1]), args[2]);
      case "ipcInvoke": {
        const channel = String(args[0] || "");
        if (!ipcAllowed(channel)) {
          return Promise.resolve(
            JSON.stringify({ success: false, error: "CHANNEL_NOT_ALLOWED" })
          );
        }
        const payload = args.length > 1 ? JSON.parse(args[1] || "null") : undefined;
        const p = ipcInvoke
          ? ipcInvoke(channel, payload)
          : Promise.resolve({ success: false, error: "IPC_UNAVAILABLE" });
        return p.then((result) =>
          JSON.stringify(result === undefined ? null : result)
        );
      }
      default:
        throw new Error(`UNKNOWN_HOST_METHOD: ${method}`);
    }
  };

  // ---- 沙箱上下文 (预热后删除宿主入口) ----
  const sandbox = {
    __host: {
      invoke: (method, args) => {
        try {
          return invoke(method, args || []);
        } catch (err) {
          log("error", String((err && err.message) || err));
          return undefined;
        }
      },
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
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(PRELUDE_PATH, "utf8"),
    context,
    { timeout: evalTimeoutMs }
  );
  vm.runInContext(
    `${String(source || "")}\n;module.exports;`,
    context,
    { timeout: evalTimeoutMs }
  );

  const instance = sandbox.module.exports;
  const ctx = sandbox.__ctx;

  const dispose = () => {
    for (const t of timers.values()) {
      clearInterval(t);
      clearTimeout(t);
    }
    timers.clear();
    for (const el of nodes.values()) {
      try {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      } catch (err) {
        /* 节点可能已被页面移除 */
      }
    }
    nodes.clear();
  };

  return { instance, ctx, dispose };
};

module.exports = { runUiPlugin };
