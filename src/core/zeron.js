// Ex-Early Load Pro Plus Max ++

console.debug("[HugoAura / Zeron] Early load script loaded.");

const appendSwitch = () => {
  const { app } = require("electron");
  app.commandLine.appendSwitch("host-rules", "MAP *.hugoaura.local 127.0.0.1");
};

module.exports = function (central) {
  appendSwitch();

  const genHookedWS = require("../aura/init/zeron/hookWS");

  /**
   * 运行时自检: 确认模块 18 确实是 WebSocketManager 类,
   * 且复制类依赖的模块 243(ws 库) / 7(logger) 可解析。
   * 仅在首次 central(18) 调用时惰性执行, 避免过早初始化模块。
   * 任一检查不通过 => 返回原模块, 优雅降级而非崩溃。
   */
  const selfCheck = () => {
    try {
      const originalModule18 = central(18);
      const markerOk =
        typeof originalModule18 === "function" &&
        originalModule18.toString().includes("创建连接");

      const wsLib = central(243);
      const logger = central(7);
      const depsOk =
        typeof wsLib === "function" &&
        typeof logger === "object" &&
        typeof logger.info === "function";

      return markerOk && depsOk;
    } catch (err) {
      console.error(
        "[HugoAura / Zeron / WebSocket Hook] Self-check failed:",
        err
      );
      return false;
    }
  };

  // 惰性求值: 自检结果与 hooked 类均只计算一次(对齐 webpack 模块缓存语义)
  let checked = false;
  let wsHooked = false;
  let hookedClass = null;

  return new Proxy(central, {
    apply(target, thisArg, args) {
      if (args[0] === 18) {
        if (!checked) {
          checked = true;
          wsHooked = selfCheck();
          console.debug(
            `[HugoAura / Zeron / WebSocket Hook] Self-check: ${
              wsHooked ? "OK, using hooked class" : "FAILED, using original module"
            }`
          );
        }
        if (!wsHooked) return Reflect.apply(target, thisArg, args);
        if (!hookedClass) hookedClass = genHookedWS(central);
        return hookedClass;
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
};
