// @ts-check

/**
 * UI 插件沙箱预热脚本 (在渲染层 vm 沙箱 realm 内执行)。
 * 构建 ctx (console / timers / dom 桥 / ipc 白名单), 完成后删除宿主入口。
 */

/* eslint-disable */
var __prelude = (function () {
  var host = __host;

  var mkConsole = function (level) {
    return function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var v = arguments[i];
        try {
          parts.push(typeof v === "string" ? v : JSON.stringify(v));
        } catch (e) {
          parts.push(String(v));
        }
      }
      host.invoke("log", [level, parts.join(" ")]);
    };
  };
  var consoleObj = {
    log: mkConsole("log"),
    info: mkConsole("log"),
    warn: mkConsole("warn"),
    error: mkConsole("error"),
  };

  var mkTimer = function (kind) {
    return function (cb, ms) {
      if (typeof cb !== "function") return null;
      return host.invoke("timerSet", [kind, Number(ms) || 0, cb]);
    };
  };
  var clearLike = function (id) {
    host.invoke("timerClear", [Number(id)]);
  };

  var ctx = {
    manifest: Object.freeze(JSON.parse(__manifestJson)),
    auraVersion: String(__auraVersion),
    logger: {
      log: consoleObj.log,
      info: consoleObj.log,
      warn: consoleObj.warn,
      error: consoleObj.error,
    },
    timers: {
      setTimeout: mkTimer("timeout"),
      setInterval: mkTimer("interval"),
      clearTimeout: clearLike,
      clearInterval: clearLike,
    },
  };

  // ---- 声明式 DOM 桥 (节点 id 由宿主管理, 真实节点不进沙箱) ----
  ctx.dom = {
    createEl: function (tag, attrs) {
      return host.invoke("domCreateEl", [tag, JSON.stringify(attrs || {})]);
    },
    setText: function (id, text) {
      return host.invoke("domSet", [Number(id), "text", String(text)]);
    },
    setAttr: function (id, attrs) {
      return host.invoke("domSet", [Number(id), "attr", JSON.stringify(attrs || {})]);
    },
    appendToBody: function (id) {
      return host.invoke("domAppendToBody", [Number(id)]);
    },
    on: function (id, event, cb) {
      return host.invoke("domOn", [Number(id), String(event), cb]);
    },
  };

  // ---- IPC 白名单 ($aura.plugin.* 前缀), JSON 跨界 + 本 realm Promise ----
  ctx.ipc = {
    invoke: function (channel, payload) {
      return new Promise(function (resolve) {
        host.invokeAsync("ipcInvoke", [String(channel), JSON.stringify(payload === undefined ? null : payload)]).then(
          function (jsonStr) {
            try {
              resolve(JSON.parse(jsonStr));
            } catch (e) {
              resolve({ success: false, error: "BAD_JSON" });
            }
          }
        );
      });
    },
  };

  // ---- 删除宿主入口 ----
  delete __host;
  delete __manifestJson;
  delete __auraVersion;

  this.__ctx = ctx;
  return ctx;
})();
