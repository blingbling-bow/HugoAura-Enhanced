// @ts-check

/**
 * retryHook 模块定位兜底的单元测试 (不需要安装希沃管家)。
 *
 * 覆盖场景: 管家发版导致硬编码模块号漂移时, "特征扫描兜底"是否真的能接管。
 * 关键回归点: webpack 对未知模块号会抛 MODULE_NOT_FOUND —— 快路径必须吞掉
 * 该异常并返回 undefined, 否则 tryInstall 直接失败, 扫描兜底永远跑不到。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveModule,
  resolveByScan,
  shouldScan,
  looksLikeModuleFactory,
} = require("../src/aura/mainProcess/hooks/retryHook");

/**
 * 造一个最小 webpack 运行时, 语义与真机一致:
 *   m         模块表 { id: factory }
 *   c         模块缓存 { id: { i, l, exports } }
 *   central(id)
 *     命中缓存   -> 返回 exports
 *     命中模块表 -> 执行工厂, 写入缓存, 返回 exports
 *     都没有     -> 抛 MODULE_NOT_FOUND (webpack 的真实行为)
 * executed 记录真正被执行过的工厂 id, 用于验证"先过滤后执行"。
 */
const makeCentral = ({ modules = {}, cache = {} } = {}) => {
  const m = modules;
  const c = cache;
  /** @type {number[]} */
  const executed = [];

  const central = (id) => {
    if (c[id]) return c[id].exports;
    const factory = m[id];
    if (typeof factory !== "function") {
      const err = new Error(`Cannot find module '${id}'`);
      // @ts-ignore 与 webpack 保持一致的错误码
      err.code = "MODULE_NOT_FOUND";
      throw err;
    }
    executed.push(id);
    const moduleObj = { i: id, l: false, exports: {} };
    c[id] = moduleObj;
    factory(moduleObj, moduleObj.exports, central);
    return moduleObj.exports;
  };

  central.m = m;
  central.c = c;
  return { central, executed };
};

/** 与 powerOffInterceptor.isPowerOffHandler 等价的简化验证器 */
const isPowerOffHandler = (mod) =>
  Boolean(
    mod &&
      typeof mod.onMessage === "function" &&
      typeof mod.pushMessageToWindow === "function" &&
      typeof mod.getMessage === "function"
  );

/** 关机处理器工厂: 特征串只出现在工厂源码里 (与真机一致, URL 是模块作用域常量) */
const powerOffFactory = (id) =>
  function (e, t, n) {
    const url = "/powerOff/confirm";
    e.exports = { id, url, onMessage() {}, pushMessageToWindow() {}, getMessage() {} };
  };

/** 干扰模块: 特征不匹配, 不应被执行 */
const decoyFactory = (id) =>
  function (e, t, n) {
    e.exports = { id, onMessage() {}, other() {} };
  };

test("回归: 模块号不存在时 resolveModule 返回 undefined 而不是抛异常", () => {
  const { central } = makeCentral({ modules: {} });
  assert.doesNotThrow(() => resolveModule(central, 999999));
  assert.equal(resolveModule(central, 999999), undefined);
});

test("resolveModule 走模块表时返回 exports, 且工厂只执行一次", () => {
  const { central, executed } = makeCentral({ modules: { 7: powerOffFactory(7) } });
  const first = resolveModule(central, 7);
  const second = resolveModule(central, 7);
  assert.equal(first, second);
  assert.deepEqual(executed, [7]);
});

test("模块号消失时, 特征扫描能从模块表找回关机处理器", () => {
  const { central, executed } = makeCentral({
    modules: {
      12: decoyFactory(12),
      137: powerOffFactory(137),
      200: decoyFactory(200),
    },
  });

  // 快路径: 硬编码的 128 在新版本里已不存在 -> 软失败, 不能抛
  assert.equal(resolveModule(central, 128), undefined);

  const hit = resolveByScan(central, ["/powerOff/confirm"], isPowerOffHandler);
  assert.ok(hit, "扫描应命中");
  assert.equal(hit.id, 137);
  assert.equal(hit.how, "module-table");
  assert.equal(isPowerOffHandler(hit.mod), true);

  // 副作用防护: 只有特征命中的模块才允许被执行
  assert.deepEqual(executed, [137]);
});

test("模块表不可用时, 退回模块缓存扫描", () => {
  const handler = { onMessage() {}, pushMessageToWindow() {}, getMessage() {} };
  const { central } = makeCentral({
    cache: { 402: { i: 402, l: true, exports: handler } },
  });
  central.m = undefined; // 模拟注入环境未暴露模块表

  const hit = resolveByScan(central, ["/powerOff/confirm"], isPowerOffHandler);
  assert.ok(hit);
  assert.equal(hit.how, "module-cache");
  assert.equal(hit.id, 402);
});

test("特征不匹配时返回 null, 且不执行任何模块", () => {
  const { central, executed } = makeCentral({
    modules: { 1: decoyFactory(1), 2: decoyFactory(2) },
  });
  assert.equal(resolveByScan(central, ["/powerOff/confirm"], isPowerOffHandler), null);
  assert.deepEqual(executed, []);
});

test("hints 为空时跳过模块表扫描, 只走缓存", () => {
  const handler = { onMessage() {}, pushMessageToWindow() {}, getMessage() {} };
  const { central, executed } = makeCentral({
    modules: { 137: powerOffFactory(137) },
    cache: { 402: { i: 402, l: true, exports: handler } },
  });

  const hit = resolveByScan(central, [], isPowerOffHandler);
  assert.equal(hit.how, "module-cache");
  assert.deepEqual(executed, []);
});

test("验证函数抛错不会中断扫描", () => {
  const good = { onMessage() {}, pushMessageToWindow() {}, getMessage() {} };
  const { central } = makeCentral({
    cache: {
      1: {
        i: 1,
        l: true,
        exports: {
          get onMessage() {
            throw new Error("boom");
          },
        },
      },
      2: { i: 2, l: true, exports: good },
    },
  });

  const hit = resolveByScan(central, [], isPowerOffHandler);
  assert.ok(hit);
  assert.equal(hit.id, 2);
});

test("shouldScan 对同一入口在节流窗口内只放行一次", () => {
  const key = `unit-${Date.now()}-${Math.random()}`;
  assert.equal(shouldScan(key), true);
  assert.equal(shouldScan(key), false);
});

test("looksLikeModuleFactory: 识别三参数普通函数工厂", () => {
  assert.equal(looksLikeModuleFactory(function (e, t, n) {}), true);
  assert.equal(looksLikeModuleFactory(function (e) {}), false);
  assert.equal(looksLikeModuleFactory({}), false);
});

test("looksLikeModuleFactory: 当前不识别箭头函数工厂 (已知限制)", () => {
  assert.equal(looksLikeModuleFactory((e, t, n) => {}), false);
});
