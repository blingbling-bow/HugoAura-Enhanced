// @ts-check

/**
 * 带延迟重试的安装工具 (Retry Hook Installer)
 *
 * 背景: 希沃管家 main.js 的部分模块 (如 WS 客户端 399/390、屏保管理器 121、
 * 升级分发器 394) 为懒加载, 在窗口进程启动早期 `central(id)` 可能拿不到
 * 实例, 导致 hook 自检失败即被跳过, 功能在部分窗口失效。
 *
 * 本工具将"安装函数"包装为可重试版本: 安装返回 false (或抛错) 时,
 * 按指数退避延迟重试, 直到成功或达到上限后优雅放弃。
 *
 * 用法:
 *   const { withRetry } = require("./retryHook");
 *   const install = () => { ... return true; };
 *   withRetry(install, { label: "MyHook" })();
 */

/**
 * @typedef {Object} RetryOptions
 * @property {string} [label] 日志标识 (用于区分重试日志来源)
 * @property {number} [maxAttempts] 最大尝试次数 (默认 30)
 * @property {number} [baseDelay] 首次重试延迟 ms (默认 800, 之后递增)
 * @property {number} [maxDelay] 重试延迟上限 ms (默认 30000)
 */

/**
 * 取实例方法在原型链上的"未绑定"版本。
 *
 * 背景: 希沃管家部分类在构造器中 bind 实例方法 (如 WebSocketManager 的
 * `this.onMessage = this.onMessage.bind(this)`)。绑定函数的
 * `String(fn)` 恒为 "function () { [native code] }", 无法做源码特征匹配;
 * 必须取原型链上的原始方法才能拿到真实源码。
 *
 * @param {any} instance 实例对象
 * @param {string} name 方法名
 * @returns {Function | null} 原型链上找到的方法, 未找到返回 null
 */
const getPrototypeMethod = (instance, name) => {
  if (!instance || (typeof instance !== "object" && typeof instance !== "function")) {
    return null;
  }
  let proto = Object.getPrototypeOf(instance);
  while (proto && proto !== Object.prototype) {
    if (typeof proto[name] === "function") return proto[name];
    proto = Object.getPrototypeOf(proto);
  }
  return null;
};

/**
 * 尝试获取模块的运行时导出 (带"工厂兜底")。
 *
 * 正常情况下 central(id) 即 webpack require, 直接返回模块实例。
 * 兜底场景: 个别注入环境下, central 对"尚未被应用执行过"的懒加载模块
 * 只返回模块工厂函数 (function(e,t,n)), 而非实例。此时若 central 暴露了
 * webpack 模块表 (central.m / central.c), 可手动执行工厂得到实例,
 * 并写入模块缓存, 保证应用后续真正加载该模块时复用同一个实例。
 *
 * @param {(id: number) => any} central 模块加载器
 * @param {number} id 模块 ID
 * @returns {any} 模块导出 (可能是实例)
 */
const resolveModule = (central, id) => {
  let mod = central(id);
  const isFactory =
    mod &&
    typeof mod === "function" &&
    central.m &&
    central.c &&
    central.m[id] === mod;
  if (isFactory) {
    try {
      const moduleObj = { i: id, l: false, exports: {} };
      mod(moduleObj, moduleObj.exports, central);
      mod = moduleObj.exports;
      central.c[id] = moduleObj;
      console.warn(
        `[HugoAura / Retry] Module ${id} was a factory; executed manually and cached (fallback path).`
      );
    } catch (err) {
      console.error(
        `[HugoAura / Retry] Failed to execute module ${id} factory:`,
        err
      );
      mod = central(id); // 还原原始返回, 下次重试再试
    }
  }
  return mod;
};

/**
 * @param {() => boolean} fn 安装函数, 返回 true=成功 / false=失败需重试
 * @param {RetryOptions} [options]
 * @returns {() => void} 启动重试流程的函数 (同步执行第一次尝试)
 */
const withRetry = (fn, options = {}) => {
  const {
    label = "Hook",
    maxAttempts = 30,
    baseDelay = 800,
    maxDelay = 30000,
  } = options;

  let attempts = 0;

  const attempt = () => {
    attempts++;
    let success = false;
    try {
      success = fn() === true;
    } catch (err) {
      console.error(`[HugoAura / Retry / ${label}] Attempt ${attempts} error:`, err);
      success = false;
    }

    if (success) {
      console.log(`[HugoAura / Retry / ${label}] Installed (attempt ${attempts}).`);
      return;
    }

    if (attempts >= maxAttempts) {
      console.warn(
        `[HugoAura / Retry / ${label}] Gave up after ${attempts} attempts, hook skipped (graceful degradation).`
      );
      return;
    }

    const delay = Math.min(baseDelay * attempts, maxDelay);
    console.debug(
      `[HugoAura / Retry / ${label}] Module not ready (attempt ${attempts}), retrying in ${delay}ms...`
    );
    setTimeout(attempt, delay);
  };

  return attempt;
};

module.exports = { withRetry, getPrototypeMethod, resolveModule };
