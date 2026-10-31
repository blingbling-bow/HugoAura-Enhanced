// @ts-check

/**
 * 插件沙箱预热脚本 (在 vm 沙箱 realm 内执行, 不是宿主代码)。
 *
 * 职责: 从 __host / __grant / __manifestJson / __auraVersion / __storageDir
 * 构建插件可见的 ctx (console / timers / settings / eventBus / net),
 * 全部包装函数在本 realm 构建 (关闭宿主 Function 逃逸), 完成后删除全部
 * 宿主入口引用, 并把 ctx 挂到 this.__ctx 供宿主读取。
 *
 * 跨界规则: 与宿主的全部数据交换使用 JSON 字符串; 回调函数由宿主持有并
 * 喂 JSON 字符串; 宿主对象永不进入沙箱。
 */

/* eslint-disable */
var __prelude = (function () {
  var host = __host;
  var grant = function (key) {
    return __grant(key) === true;
  };

  var jsonOr = function (v) {
    return v === undefined ? null : v;
  };

  // ---- console / logger (限长由宿主侧保证) ----
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

  // ---- 定时器 (上限/回收由宿主侧保证) ----
  var mkTimer = function (kind) {
    return function (cb, ms) {
      if (typeof cb !== "function") return null;
      return host.invoke("timerSet", [kind, Number(ms) || 0, cb]);
    };
  };
  var clearLike = function (id) {
    host.invoke("timerClear", [Number(id)]);
  };

  // ---- ctx 组装 (权限门控: 未授予的能力不创建对应属性) ----
  var ctx = {
    manifest: Object.freeze(JSON.parse(__manifestJson)),
    auraVersion: String(__auraVersion),
    config: {
      get: function () {
        return JSON.parse(host.invoke("configGet", []));
      },
    },
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

  if (grant("storage")) {
    ctx.storageDir = String(__storageDir || "");
    ctx.settings = {
      get: function (key) {
        var all = JSON.parse(host.invoke("settingsGet", []));
        return key === undefined ? all : all[key];
      },
      set: function (values) {
        return JSON.parse(host.invoke("settingsSet", [JSON.stringify(values)]));
      },
    };
  }

  if (grant("events")) {
    ctx.eventBus = {
      on: function (event, cb) {
        return host.invoke("busOn", [String(event), cb]);
      },
      off: function (event, cb) {
        return host.invoke("busOff", [String(event), cb]);
      },
      emit: function (event, payload) {
        return host.invoke("busEmit", [String(event), JSON.stringify(jsonOr(payload))]);
      },
    };
  }

  if (grant("network")) {
    ctx.net = {
      fetchText: function (url) {
        return new Promise(function (resolve, reject) {
          host.invokeAsync("netFetch", [String(url)]).then(
            function (jsonStr) {
              try {
                resolve(JSON.parse(jsonStr));
              } catch (e) {
                reject(String(e && e.message ? e.message : e));
              }
            },
            function (e) {
              reject(String(e && e.message ? e.message : e));
            }
          );
        });
      },
    };
  }

  // ---- 删除宿主入口, 关闭 .constructor 逃逸路径 ----
  delete __host;
  delete __grant;
  delete __manifestJson;
  delete __auraVersion;
  delete __storageDir;

  this.__ctx = ctx;
  this.ctx = ctx;
  return ctx;
})();
