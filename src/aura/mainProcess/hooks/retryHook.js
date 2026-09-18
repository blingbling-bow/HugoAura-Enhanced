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

// >>> WS 拦截器共享蹦床 (Trampoline) <<< //
//
// 关键背景: WS 基类 (模块 18) 的 create() 中:
//   const { host, onLinkOk, onClose, onMessage: i } = this;
//   a.on("message", t => { ...; i(t) });
// 消息回调在"连接建立时"一次性解构固化进闭包。若 hook 在连接建立后才
// 包装 client.onMessage 实例属性, 新包装永远不会被调用 (闭包仍持有旧引用),
// 导致拦截/审计/提醒全部失效。
//
// 解决方案: 所有 WS hook 共享一个"蹦床"函数, 首次安装时替换实例 onMessage,
// 后续 hook 只向蹦床的拦截器列表注册处理函数 (支持任意时刻注册, 天然解决
// 多 hook 安装顺序问题)。若安装时连接已建立 (ws 已存在), 主动断开触发
// 基类自动重连 (onClose → relinkFun → create()), 重连后的闭包捕获的就是蹦床。

const WS_TRAMPOLINE_FLAG = "__auraWsTrampoline";
const WS_INTERCEPTORS_FLAG = "__auraWsInterceptors";
const WS_REFRESHED_FLAG = "__auraWsRefreshed";

// 自检失败诊断: 每个 (模块, 入口) 只记录一次
const wsDiagLogged = {};

/**
 * 向 WS 客户端安装共享拦截蹦床并注册处理函数。
 *
 * 处理函数签名: handler(parsed, rawMsg) => true | { delay: ms } | void
 *   - 返回 true          : 消息已消费, 终止链条 (拦截/吞掉指令)
 *   - 返回 { delay: ms } : 终止链条, 并在 ms 毫秒后放行原始消息
 *   - 其他               : 继续传递给下一个处理函数 / 原始 onMessage
 *
 * @param {(id: number) => any} central 模块加载器
 * @param {number} moduleId WS 客户端模块 ID
 * @param {string} label 入口名称 (日志标识)
 * @param {(parsed: any, rawMsg: string) => true | { delay: number } | void} handler
 * @returns {boolean} true=安装成功 / false=模块未就绪需重试
 */
const installWsInterceptor = (central, moduleId, label, handler) => {
  try {
    const client = resolveModule(central, moduleId);

    // 运行时自检: 是否为 WS 客户端 (WebSocketManager 派生实例)。
    // onMessage 在基类构造器中被 bind, 必须取原型链上的未绑定方法做特征匹配;
    // setHost/sendMessage 为基类方法, 用于确认 WS 客户端身份。
    const unboundOnMessage = getPrototypeMethod(client, "onMessage");
    const isWsClient =
      client &&
      typeof client.onMessage === "function" &&
      typeof client.setHost === "function" &&
      typeof client.sendMessage === "function" &&
      typeof unboundOnMessage === "function" &&
      String(unboundOnMessage).includes("JSON.parse");

    if (!isWsClient) {
      if (!wsDiagLogged[label]) {
        wsDiagLogged[label] = true;
        const proto = Object.getPrototypeOf(client);
        console.warn(
          `[HugoAura / WsHook] ${label} (module ${moduleId}) self-check failed. ` +
            `typeof(client)=${typeof client}, ` +
            `onMessage=${client && typeof client.onMessage}, ` +
            `setHost=${client && typeof client.setHost}, ` +
            `sendMessage=${client && typeof client.sendMessage}, ` +
            `proto.onMessage=${proto && typeof proto.onMessage}, ` +
            `moduleTable=${!!(central.m && central.c)}`
        );
      }
      console.debug(
        `[HugoAura / WsHook] ${label} (module ${moduleId}) not ready, retrying...`
      );
      return false;
    }

    // 首次安装: 建立共享蹦床
    if (!client[WS_TRAMPOLINE_FLAG]) {
      const originalOnMessage = client.onMessage.bind(client);
      const interceptors = [];
      client[WS_INTERCEPTORS_FLAG] = interceptors;

      client.onMessage = (rawMsg) => {
        let parsed = null;
        try {
          parsed = JSON.parse(rawMsg);
        } catch (err) {
          // 非 JSON 消息原样透传, 不拦截
          return originalOnMessage(rawMsg);
        }

        for (const h of interceptors) {
          let ret = undefined;
          try {
            ret = h(parsed, rawMsg);
          } catch (err) {
            console.error(
              `[HugoAura / WsHook / ${label}] Interceptor error:`,
              err
            );
          }
          if (ret === true) return; // 已消费 (拦截)
          if (ret && typeof ret === "object" && Number(ret.delay) > 0) {
            const ms = Number(ret.delay);
            setTimeout(() => {
              try {
                originalOnMessage(rawMsg);
              } catch (err) {
                console.error(
                  `[HugoAura / WsHook / ${label}] Delayed dispatch error:`,
                  err
                );
              }
            }, ms);
            return;
          }
        }
        return originalOnMessage(rawMsg);
      };

      client[WS_TRAMPOLINE_FLAG] = true;
    }

    // 注册处理函数 (防重复注册, 重试场景)
    const interceptors = client[WS_INTERCEPTORS_FLAG];
    if (!interceptors.includes(handler)) interceptors.push(handler);

    // 连接已建立: 主动断开触发基类重连, 使 create() 闭包捕获蹦床。
    // 仅需执行一次 — 蹦床稳定存在, 后续注册的处理函数即时生效。
    if (client.ws && !client[WS_REFRESHED_FLAG]) {
      client[WS_REFRESHED_FLAG] = true;
      try {
        client.intervals = 0; // 重连不退避 (基类 relinkFun 会 +2000ms, 约 2s 重连)
        console.log(
          `[HugoAura / WsHook] Refreshing ${label} (module ${moduleId}) connection to activate interceptor...`
        );
        client.ws.close();
      } catch (err) {
        console.error(
          `[HugoAura / WsHook] Failed to refresh ${label} connection:`,
          err
        );
        client[WS_REFRESHED_FLAG] = false;
      }
    }

    console.log(
      `[HugoAura / WsHook] Interceptor installed on ${label} (module ${moduleId}).`
    );
    return true;
  } catch (err) {
    console.error(`[HugoAura / WsHook] Failed to install ${label}:`, err);
    return false;
  }
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

module.exports = {
  withRetry,
  getPrototypeMethod,
  resolveModule,
  installWsInterceptor,
};
