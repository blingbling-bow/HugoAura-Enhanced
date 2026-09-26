// @ts-check

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const HOOK_PATH = path.resolve(
  __dirname,
  "../src/aura/mainProcess/hooks/unlockAudit.js"
);
const AUDIT_WRITER_PATH = require.resolve(
  "../src/aura/mainProcess/hooks/auditWriter.js"
);

// 原生 stopLockTask 内的 tslKey 字面量, 钩子据此做源码特征自检
const MARKER = "unlockStreamControl";

/** 带特征串的模块 33 桩 (模拟原生: 内部依赖 this, 并清空 message / windows) */
const controllerWithMarker = (options = {}) =>
  class ScreenLockController {
    constructor() {
      this.message = null;
      this.windows = [];
    }
    stopLockTask(arg) {
      if (options.throwOnUnlock) throw new Error("native unlock failed");
      this.message = null;
      this.windows = [];
      // 特征串必须作为字面量出现在源码里 (自检匹配的是 String(fn)),
      // 原生对应 tslKey: "unlockStreamControl"
      return "unlockStreamControl:" + JSON.stringify(arg === undefined ? null : arg);
    }
  };

/** 缺少特征串的桩, 用于验证自检失败时优雅降级 */
const controllerWithoutMarker = () =>
  class NotTheController {
    stopLockTask() {
      return "untouched";
    }
  };

/**
 * 装配并加载钩子。
 * @param {object} cfg 可变配置对象 (直接改字段即可模拟热更新)
 * @param {() => any} controllerFactory
 */
const loadHook = (cfg, controllerFactory) => {
  const records = [];

  // 钩子在模块加载时 require("./auditWriter"), 必须先于 require 钩子写入桩
  require.cache[AUDIT_WRITER_PATH] = {
    id: AUDIT_WRITER_PATH,
    filename: AUDIT_WRITER_PATH,
    loaded: true,
    exports: {
      writeAudit: (file, record) => {
        records.push({ file, record });
        return true;
      },
      rewriteAudit: () => true,
      readAudit: () => "",
    },
  };

  global.__HUGO_AURA_CONFIG_MGR__ = { loadConfig: () => cfg };

  const controller = new (controllerFactory())();

  // resolveModule 的工厂兜底要求 central.m / central.c 同时存在, 这里不提供,
  // 因此 central(33) 的返回值被直接当作模块实例使用。
  const central = () => controller;

  delete require.cache[HOOK_PATH];
  const hook = require(HOOK_PATH);
  hook.hookFunc(central);

  return { controller, records };
};

/** 静音钩子内部的 log/warn/debug 日志, 让测试输出保持干净 */
const silently = (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "debug", () => {});
  // withRetry 在自检失败时会用 setTimeout 排定重试; 模拟定时器避免真实挂起
  t.mock.timers.enable({ apis: ["setTimeout"] });
};

const configWith = (enabled) => ({ auraSettings: { unlockAudit: { enabled } } });

test("开关关闭时不写审计", (t) => {
  silently(t);
  const { controller, records } = loadHook(configWith(false), controllerWithMarker);

  controller.message = { operationLogId: "0" };
  const returned = controller.stopLockTask({ actionOperator: 3, operationLogId: "0" });

  assert.equal(records.length, 0, "关闭审计时不应写入任何记录");
  assert.ok(returned.includes(MARKER), "包装不得改变原方法返回值");
});

test("actionOperator 1/2/3 映射为 remote/activationCode/password", (t) => {
  silently(t);
  const { controller, records } = loadHook(configWith(true), controllerWithMarker);

  controller.stopLockTask({ actionOperator: 1, operationLogId: "a" });
  controller.stopLockTask({ actionOperator: 2, operationLogId: "b" });
  controller.stopLockTask({ actionOperator: 3, operationLogId: "c" });

  assert.deepEqual(
    records.map((r) => r.record.method),
    ["remote", "activationCode", "password"]
  );
  assert.deepEqual(
    records.map((r) => r.record.actionOperator),
    [1, 2, 3]
  );
  assert.deepEqual(
    records.map((r) => r.record.operationLogId),
    ["a", "b", "c"]
  );
  assert.equal(records[0].file, "cloudCommandAudit.log");
});

test("非法 actionOperator 落 unknown", (t) => {
  silently(t);
  const { controller, records } = loadHook(configWith(true), controllerWithMarker);

  controller.stopLockTask({ actionOperator: 7, operationLogId: "0" });

  assert.equal(records.length, 1);
  assert.equal(records[0].record.method, "unknown");
  assert.equal(records[0].record.actionOperator, 7);
});

test("hadLock 在调用前取样 (原方法清空 message/windows 后记录仍为 true)", (t) => {
  silently(t);
  const { controller, records } = loadHook(configWith(true), controllerWithMarker);

  controller.message = { operationLogId: "0" };
  controller.windows = ["screenLock_0"];
  controller.stopLockTask({ actionOperator: 3, operationLogId: "0" });

  assert.equal(records.length, 1);
  assert.equal(records[0].record.hadLock, true, "快照必须在原方法清空状态之前取");
});

test("无锁状态下的解锁指令记录为 hadLock=false", (t) => {
  silently(t);
  const { controller, records } = loadHook(configWith(true), controllerWithMarker);

  controller.message = null;
  controller.windows = [];
  controller.stopLockTask({ actionOperator: 1, operationLogId: "0" });

  assert.equal(records.length, 1);
  assert.equal(records[0].record.hadLock, false);
});

test("原方法抛错时不写日志且异常原样抛出", (t) => {
  silently(t);
  const { controller, records } = loadHook(configWith(true), () =>
    controllerWithMarker({ throwOnUnlock: true })
  );

  assert.throws(
    () => controller.stopLockTask({ actionOperator: 3, operationLogId: "0" }),
    /native unlock failed/
  );
  assert.equal(records.length, 0, "失败解锁不应留下记录");
});

test("自检失败时不包装、不写日志、不抛错", (t) => {
  silently(t);
  const { controller, records } = loadHook(configWith(true), controllerWithoutMarker);

  const original = controller.stopLockTask;
  assert.equal(controller.stopLockTask, original, "自检失败时原型方法不得被替换");
  assert.equal(controller.stopLockTask(), "untouched");
  assert.equal(records.length, 0);
});

test("arg 非对象时 operationLogId 为 0 / actionOperator 为 null / method 为 unknown", (t) => {
  silently(t);
  const { controller, records } = loadHook(configWith(true), controllerWithMarker);

  controller.stopLockTask();

  assert.equal(records.length, 1);
  const { record } = records[0];
  assert.equal(record.operationLogId, "0");
  assert.equal(record.actionOperator, null);
  assert.equal(record.method, "unknown");
});

test("记录字段集合与取值固定", (t) => {
  silently(t);
  const { controller, records } = loadHook(configWith(true), controllerWithMarker);

  controller.message = { operationLogId: "0" };
  controller.windows = ["screenLock_0"];
  controller.stopLockTask({ actionOperator: 3, operationLogId: "0" });

  const { record } = records[0];
  assert.deepEqual(
    Object.keys(record).sort(),
    [
      "_logType",
      "action",
      "actionOperator",
      "channel",
      "hadLock",
      "method",
      "operationLogId",
      "ts",
    ]
  );
  assert.equal(record.channel, "screenLockController");
  assert.equal(record.action, "unlock");
  assert.equal(record._logType, "unlock");
  assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
});
