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
 * 定位健壮性 (v0.3.1 加固):
 *   模块 ID 是 webpack 构建产物, 管家每次发版都可能让其漂移; 一旦硬编码的
 *   模块号失配, 单纯重试永远不会成功 (真机日志中的 "Gave up after 30
 *   attempts" 多属此类)。因此本模块在固定 ID 之外提供两级兜底:
 *     1. resolveModule 放宽"工厂函数"判定 —— 即使注入环境未暴露模块表
 *        (central.m), 也能凭函数签名识别并手动执行工厂, 拿到实例。
 *     2. resolveByScan 按特征扫描重新定位 —— 先在模块表里用工厂源码特征
 *        过滤再执行 (避免为探测触发无关模块的副作用), 再退到模块缓存里
 *        直接验证"已被应用执行过"的导出。
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
 * 判断函数是否"形如 webpack 模块工厂"。
 *
 * 模块工厂的签名恒为三参数 (module, exports, require); 而模块自身导出
 * 的业务函数不会长这样 (通常是零/一/二参数的箭头函数或普通函数)。
 * 仅在注入环境没有暴露模块表 (central.m) 时才用它做兜底判定。
 *
 * @param {any} fn 待判定对象
 * @returns {boolean}
 */
const looksLikeModuleFactory = (fn) => {
  if (typeof fn !== "function") return false;
  return /^function\s*\(\s*[\w$]+\s*,\s*[\w$]+\s*,\s*[\w$]+\s*\)/.test(
    String(fn)
  );
};

// 快路径失配提示去重: 每个模块号只提示一次 (重试上限 30 次, 否则刷屏)
const missingModuleLogged = new Set();

/**
 * 尝试获取模块的运行时导出 (带"工厂兜底")。
 *
 * 正常情况下 central(id) 即 webpack require, 直接返回模块实例。
 * 兜底场景: 个别注入环境下, central 对"尚未被应用执行过"的懒加载模块
 * 只返回模块工厂函数 (function(module, exports, require)), 而非实例。
 * 此时手动执行工厂得到实例, 并写入模块缓存, 保证应用后续真正加载该模块
 * 时复用同一个实例 (否则会出现"钩子挂在一个孤立实例上"的隐性失效)。
 *
 * @param {(id: number) => any} central 模块加载器
 * @param {number} id 模块 ID
 * @returns {any} 模块导出 (可能是实例); 模块号不存在时返回 undefined
 */
const resolveModule = (central, id) => {
  let mod;
  try {
    mod = central(id);
  } catch (err) {
    // 模块号漂移时, webpack 对未知 ID 抛 MODULE_NOT_FOUND。这里必须吞掉:
    // 调用方 (各钩子的 tryInstall) 把"拿不到正确模块"当作可重试的软失败,
    // 异常一旦穿透, 后面的特征扫描兜底永远跑不到, 最终 30 次重试后
    // "Gave up" —— 正是本模块要消除的失效模式。
    if (!missingModuleLogged.has(id)) {
      missingModuleLogged.add(id);
      console.warn(
        `[HugoAura / Retry] Module ${id} not found (${
          err && err.message ? err.message : err
        }); fast path miss, scan fallback will be used.`
      );
    }
    return undefined;
  }
  // 判定"返回值是否为未执行的工厂函数":
  //   - 首选模块表比对 (最准确)
  //   - 无模块表时退化为函数签名判断
  const inTable = Boolean(central.m && central.m[id] === mod);
  const isFactory =
    mod &&
    typeof mod === "function" &&
    (inTable || (!central.m && looksLikeModuleFactory(mod)));
  if (isFactory) {
    try {
      const moduleObj = { i: id, l: false, exports: {} };
      mod(moduleObj, moduleObj.exports, central);
      mod = moduleObj.exports;
      if (central.c) central.c[id] = moduleObj;
      console.warn(
        `[HugoAura / Retry] Module ${id} was a factory; executed manually and cached (fallback path).`
      );
    } catch (err) {
      console.error(
        `[HugoAura / Retry] Failed to execute module ${id} factory:`,
        err
      );
      // 还原原始返回 (下次重试再试); 若 central 仍然抛错, 视为未就绪
      try {
        mod = central(id);
      } catch (err2) {
        mod = undefined;
      }
    }
  }
  return mod;
};

/**
 * 按特征扫描重新定位模块 (固定模块号失配时的兜底)。
 *
 * 两条路径:
 *   1. 模块表扫描: 用 hints 过滤工厂源码, 命中后才执行。先过滤后执行是
 *      刻意的 —— 执行模块有副作用 (如立即建立 WS 连接), 不能为了探测把
 *      无关模块挨个跑一遍。
 *   2. 模块缓存扫描: 应用已经执行过的模块, 其导出就躺在 central.c 里,
 *      直接逐个验证即可, 不需要再执行任何东西。
 *
 * @param {(id: number) => any} central 模块加载器
 * @param {string[]} hints 工厂源码中应同时出现的特征片段 (为空则跳过路径 1)
 * @param {(mod: any) => boolean} verify 导出验证函数
 * @returns {{ mod: any, id: any, how: string } | null} 命中结果
 */
const resolveByScan = (central, hints, verify) => {
  const table = central && central.m;
  if (table && typeof table === "object" && Array.isArray(hints) && hints.length > 0) {
    for (const [id, factory] of Object.entries(table)) {
      if (typeof factory !== "function") continue;
      const src = String(factory);
      if (!hints.every((hint) => src.includes(hint))) continue;
      let candidate = null;
      try {
        candidate = resolveModule(central, Number(id));
      } catch (err) {
        continue;
      }
      if (candidate === null || candidate === undefined) continue;
      let ok = false;
      try {
        ok = verify(candidate) === true;
      } catch (err) {
        ok = false;
      }
      if (ok) return { mod: candidate, id: Number(id), how: "module-table" };
    }
  }

  const cache = central && central.c;
  if (cache && typeof cache === "object") {
    for (const entry of Object.values(cache)) {
      const exported = entry && entry.exports;
      if (exported === null || exported === undefined) continue;
      let ok = false;
      try {
        ok = verify(exported) === true;
      } catch (err) {
        ok = false;
      }
      if (ok) return { mod: exported, id: entry.i, how: "module-cache" };
    }
  }

  return null;
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

// 自检失败诊断: 每个 label 只记录一次
const wsDiagLogged = {};

// 扫描节流: 模块表动辄数百项, 逐项 String(factory) 开销不低, 而重试本身
// 有 30 次。同一扫描入口 3 秒内只扫一次, 被节流跳过时等下一次重试即可。
// (WS 蹦床定位与 handler 模块定位共用此工具)
const SCAN_THROTTLE_MS = 3000;
const lastScanAt = {};

/**
 * 判断某个扫描入口是否已过节流窗口 (供各钩子的重试循环共用)。
 * @param {string} key 入口标识
 * @returns {boolean} true=允许本次扫描
 */
const shouldScan = (key) => {
  const now = Date.now();
  if (lastScanAt[key] && now - lastScanAt[key] < SCAN_THROTTLE_MS) return false;
  lastScanAt[key] = now;
  return true;
};

/**
 * 运行时自检: 是否为 WS 客户端 (WebSocketManager 派生实例)。
 *
 * onMessage 在基类构造器中被 bind, 必须取原型链上的未绑定方法做特征匹配;
 * setHost/sendMessage 为基类方法, 用于确认 WS 客户端身份。
 *
 * @param {any} client 待判定对象
 * @returns {boolean}
 */
const isWsClientInstance = (client) => {
  if (!client) return false;
  const unboundOnMessage = getPrototypeMethod(client, "onMessage");
  return Boolean(
    typeof client.onMessage === "function" &&
      typeof client.setHost === "function" &&
      typeof client.sendMessage === "function" &&
      typeof unboundOnMessage === "function" &&
      String(unboundOnMessage).includes("JSON.parse")
  );
};

/**
 * 更宽松的 WS 客户端判定 (供全局审计探针 wsAuditTap 使用)。
 *
 * isWsClientInstance 额外要求原型 onMessage 源码里出现 "JSON.parse" —— 这个
 * 特征对"扫描兜底定位 WS 基类"是必要的 (模块表里有几百个工厂, 特征越独特越好),
 * 但作为"这条通道值不值得挂审计探针"的门槛就太严了: 个别客户端的 onMessage
 * 只做转发 / 把解析交给辅助函数, 就会整条通道漏采, 而且是静默的。
 *
 * 这里只校验基类成员是否齐全 —— setHost / sendMessage / onMessage 三个方法
 * (基类构造器全部 bind 过) 加上基类构造器初始化的状态字段 (ws / ready /
 * relink / intervals) 至少之一。误判概率极低, 而漏挂的代价 (通道完全不可见)
 * 远大于误挂。
 *
 * 安全性: 蹦床始终把**原始报文**透传给原 onMessage, 所以客户端即便自己解析
 * 也不受影响; 探针处理函数恒返回 undefined, 不消费消息。
 *
 * @param {any} client 待判定对象
 * @returns {boolean}
 */
const isWsClientLike = (client) => {
  if (!client || typeof client !== "object") return false;
  if (typeof client.setHost !== "function") return false;
  if (typeof client.sendMessage !== "function") return false;
  if (typeof client.onMessage !== "function") return false;
  return (
    Object.prototype.hasOwnProperty.call(client, "ws") ||
    Object.prototype.hasOwnProperty.call(client, "ready") ||
    Object.prototype.hasOwnProperty.call(client, "relink") ||
    Object.prototype.hasOwnProperty.call(client, "intervals")
  );
};

/**
 * 组装自检失败诊断串 (供日志定位失配原因)。
 */
const describeWsFailure = (client, central, hints) => {
  let protoOnMessage = "n/a";
  try {
    protoOnMessage = typeof getPrototypeMethod(client, "onMessage");
  } catch (err) {
    protoOnMessage = "threw";
  }
  return (
    `typeof(client)=${typeof client}, ` +
    `onMessage=${client && typeof client.onMessage}, ` +
    `setHost=${client && typeof client.setHost}, ` +
    `sendMessage=${client && typeof client.sendMessage}, ` +
    `proto.onMessage=${protoOnMessage}, ` +
    `moduleTable=${Boolean(central.m && central.c)}, ` +
    `tableEntries=${central.m ? Object.keys(central.m).length : 0}, ` +
    `cacheEntries=${central.c ? Object.keys(central.c).length : 0}, ` +
    `hints=[${hints.join(",")}]`
  );
};

/**
 * 建立 (或复用) WS 客户端上的共享拦截蹦床, 返回拦截器数组。
 *
 * 蹦床负责: 解析 JSON -> 依次调用拦截器 -> 按返回值决定消费/延迟/放行。
 * 幂等: 已建立时直接返回既有拦截器数组 (多 hook 共享同一条链)。
 *
 * @param {any} client WS 客户端实例
 * @returns {Function[]} 拦截器数组
 */
const ensureWsTrampoline = (client) => {
  if (client[WS_TRAMPOLINE_FLAG]) return client[WS_INTERCEPTORS_FLAG];

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
        console.error("[HugoAura / WsHook] Interceptor error:", err);
      }
      if (ret === true) return; // 已消费 (拦截)
      if (ret && typeof ret === "object" && Number(ret.delay) > 0) {
        const ms = Number(ret.delay);
        setTimeout(() => {
          try {
            originalOnMessage(rawMsg);
          } catch (err) {
            console.error("[HugoAura / WsHook] Delayed dispatch error:", err);
          }
        }, ms);
        return;
      }
    }
    return originalOnMessage(rawMsg);
  };

  client[WS_TRAMPOLINE_FLAG] = true;
  return interceptors;
};

/**
 * 断开已有连接以触发基类自动重连, 使 create() 闭包重新捕获蹦床。
 *
 * 原因: 基类 create() 在"连接建立时"一次性解构 onMessage 进闭包, 事后替换
 * 实例属性不会被调用 —— 必须让连接重建一次。每个客户端只做一次。
 *
 * @param {any} client WS 客户端实例
 * @param {string} label 日志标识
 * @returns {boolean} true=本次真的触发了重连
 */
const refreshWsClient = (client, label) => {
  if (!client.ws || client[WS_REFRESHED_FLAG]) return false;
  client[WS_REFRESHED_FLAG] = true;
  try {
    client.intervals = 0; // 重连不退避 (基类 relinkFun 会 +2000ms, 约 2s 重连)
    console.log(
      `[HugoAura / WsHook] Refreshing ${label} connection to activate interceptor...`
    );
    client.ws.close();
    return true;
  } catch (err) {
    console.error(`[HugoAura / WsHook] Failed to refresh ${label} connection:`, err);
    client[WS_REFRESHED_FLAG] = false;
    return false;
  }
};

/**
 * 向 WS 客户端安装共享拦截蹦床并注册处理函数。
 *
 * 处理函数签名: handler(parsed, rawMsg) => true | { delay: ms } | void
 *   - 返回 true          : 消息已消费, 终止链条 (拦截/吞掉指令)
 *   - 返回 { delay: ms } : 终止链条, 并在 ms 毫秒后放行原始消息
 *   - 其他               : 继续传递给下一个处理函数 / 原始 onMessage
 *
 * @param {(id: number) => any} central 模块加载器
 * @param {number} moduleId WS 客户端模块 ID (构建相关, 失配时走扫描兜底)
 * @param {string} label 入口名称 (日志标识; 同时作为默认扫描特征 ——
 *        该名称即 WS 的配置键, 会出现在对应客户端模块的工厂源码里)
 * @param {(parsed: any, rawMsg: string) => true | { delay: number } | void} handler
 * @param {{ factoryHints?: string[] }} [options] 额外选项
 * @returns {boolean} true=安装成功 / false=模块未就绪需重试
 */
const installWsInterceptor = (central, moduleId, label, handler, options = {}) => {
  const hints =
    Array.isArray(options.factoryHints) && options.factoryHints.length > 0
      ? options.factoryHints
      : [label];
  try {
    let client = null;
    try {
      client = resolveModule(central, moduleId);
    } catch (err) {
      client = null;
    }

    // 模块号失配兜底: 按特征扫描重新定位 WS 客户端 (受节流约束)。
    if (!isWsClientInstance(client) && shouldScan(`${label}:${moduleId}`)) {
      const recovered = resolveByScan(central, hints, isWsClientInstance);
      if (recovered) {
        client = recovered.mod;
        console.warn(
          `[HugoAura / WsHook] ${label}: module ${moduleId} unavailable, ` +
            `recovered via ${recovered.how} (module ${recovered.id}).`
        );
      }
    }

    if (!isWsClientInstance(client)) {
      if (!wsDiagLogged[label]) {
        wsDiagLogged[label] = true;
        console.warn(
          `[HugoAura / WsHook] ${label} (module ${moduleId}) self-check failed. ` +
            describeWsFailure(client, central, hints)
        );
      }
      console.debug(
        `[HugoAura / WsHook] ${label} (module ${moduleId}) not ready, retrying...`
      );
      return false;
    }

    // 首次安装: 建立共享蹦床 (幂等, 多 hook 共用)
    const interceptors = ensureWsTrampoline(client);

    // 注册处理函数 (防重复注册, 重试场景)
    if (!interceptors.includes(handler)) interceptors.push(handler);

    // 连接已建立: 主动断开触发基类重连, 使 create() 闭包捕获蹦床。
    // 仅需执行一次 — 蹦床稳定存在, 后续注册的处理函数即时生效。
    refreshWsClient(client, label);

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
  resolveByScan,
  shouldScan,
  looksLikeModuleFactory,
  isWsClientInstance,
  isWsClientLike,
  ensureWsTrampoline,
  refreshWsClient,
  installWsInterceptor,
};
