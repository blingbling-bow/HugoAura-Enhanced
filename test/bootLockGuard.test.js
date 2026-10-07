// @ts-check
"use strict";

/**
 * 开机锁屏保护 (禁止开机自动锁屏) 集成测试
 *
 * 覆盖: 窗口期内锁屏指令被拦截并伪造回执; 窗口期外放行; 功能关闭时放行;
 * 回执通道失败时 fail-closed 放行 (与 lockScreenIntercept 同一套语义);
 * 解锁指令不受开机保护影响。
 *
 * 窗口从"钩子安装"(管家程序启动) 起算, 默认 90 秒 —— 用户的场景是
 * "程序一打开就会锁屏", 锁屏指令在启动后极短时间内到达。
 */

const test = require("node:test");
const assert = require("node:assert");

const lockScreen = require("../src/aura/mainProcess/hooks/lockScreenInterceptor.js");

const GRACE_SECONDS = 90;
const SECOND_MS = 1000;

/** 构造被测环境: 模块 33 锁屏控制器 + 310/311 回执 + electron/配置桩 */
const makeEnv = ({ bootEnabled = true, elapsedSec = 1 } = {}) => {
  const state = { elapsedMs: elapsedSec * SECOND_MS, feedbackFails: false };
  const lockFeedbackCalls = [];
  const unlockFeedbackCalls = [];
  const originalCalls = [];

  const proto = {
    // 源码需包含 "screenLockStatus" (锁屏控制器自检特征)
    onMessage(e) {
      this.calls.push(e);
      return undefined;
    },
  };

  const handler = Object.create(proto);
  handler.calls = originalCalls;
  handler.message = null;
  handler.windows = [];
  handler.startLockTask = () => {};
  handler.userLock = () => {};
  handler.stopLockTask = () => {};
  handler.onMessage = handler.onMessage.bind(handler);

  const stubs = {
    1: { ipcMain: { send() {} } },
    0: { hugoServiceWebsocket: { ip: "wss://127.0.0.1", url: "/x" } },
    33: handler,
    310: (payload) => {
      if (state.feedbackFails) throw new Error("feedback channel down");
      lockFeedbackCalls.push(payload);
      return true;
    },
    311: () => true,
  };
  const central = (id) => stubs[id];

  const config = {
    auraSettings: {
      preventBootLock: { enabled: bootEnabled, graceSeconds: GRACE_SECONDS },
      lockScreenIntercept: { enabled: false },
    },
  };
  global.__HUGO_AURA_CONFIG_MGR__ = { loadConfig: () => config };

  lockScreen.hookFunc(central, { getElapsedMs: () => state.elapsedMs });

  return {
    handler,
    lockFeedbackCalls,
    unlockFeedbackCalls,
    originalCalls,
    setElapsedSec: (sec) => {
      state.elapsedMs = sec * SECOND_MS;
    },
    setFeedbackFails: (v) => {
      state.feedbackFails = v;
    },
    cleanup() {
      delete global.__HUGO_AURA_CONFIG_MGR__;
    },
  };
};

const LOCK_MSG = (operationLogId = "1") =>
  JSON.stringify({
    messageType: 1211,
    data: { screenLockStatus: 1, operationLogId },
  });

test("窗口期内: 锁屏指令被拦截并伪造锁屏回执, 不进入真实锁屏", () => {
  const env = makeEnv({ elapsedSec: 1 });
  try {
    env.handler.onMessage(LOCK_MSG("100"));

    assert.strictEqual(env.lockFeedbackCalls.length, 1, "应伪造锁屏回执");
    assert.strictEqual(env.lockFeedbackCalls[0].status, 1);
    assert.strictEqual(env.lockFeedbackCalls[0].operationLogId, "100");
    assert.strictEqual(env.originalCalls.length, 0, "真实锁屏逻辑不应被执行");
  } finally {
    env.cleanup();
  }
});

test("窗口期外: 锁屏指令放行, 走管家原逻辑", () => {
  const env = makeEnv({ elapsedSec: 1 });
  try {
    env.setElapsedSec(120); // 超过 90 秒窗口

    env.handler.onMessage(LOCK_MSG("200"));

    assert.strictEqual(env.lockFeedbackCalls.length, 0, "不应伪造回执");
    assert.strictEqual(env.originalCalls.length, 1, "应交回管家原逻辑");
  } finally {
    env.cleanup();
  }
});

test("功能关闭时: 锁屏指令放行", () => {
  const env = makeEnv({ bootEnabled: false, elapsedSec: 1 });
  try {
    env.handler.onMessage(LOCK_MSG("300"));
    assert.strictEqual(env.lockFeedbackCalls.length, 0);
    assert.strictEqual(env.originalCalls.length, 1, "应交回管家原逻辑");
  } finally {
    env.cleanup();
  }
});

test("解锁指令不受开机保护影响", () => {
  const env = makeEnv({ elapsedSec: 1 });
  try {
    const unlock = JSON.stringify({
      messageType: 1211,
      data: { screenLockStatus: 0, operationLogId: "9" },
    });
    env.handler.onMessage(unlock);

    assert.strictEqual(env.lockFeedbackCalls.length, 0);
    // 锁屏拦截关闭 + 无真实锁屏: 解锁交回管家原逻辑
    assert.strictEqual(env.originalCalls.length, 1);
  } finally {
    env.cleanup();
  }
});

test("回执通道失败: fail-closed 放行真实锁屏 (与集控端保持一致)", () => {
  const env = makeEnv({ elapsedSec: 1 });
  try {
    env.setFeedbackFails(true);

    env.handler.onMessage(LOCK_MSG("401"));

    assert.strictEqual(env.lockFeedbackCalls.length, 0);
    assert.strictEqual(env.originalCalls.length, 1, "fail-closed 应放行");
  } finally {
    env.cleanup();
  }
});

test("isWithinBootGrace: 边界与非法输入", () => {
  const g = lockScreen.isWithinBootGrace;
  assert.strictEqual(
    g({ elapsedMs: 0, graceMs: 1 }),
    true,
    "程序启动瞬间在窗口内"
  );
  assert.strictEqual(
    g({ elapsedMs: 1000, graceMs: 1000 }),
    true,
    "恰好等于窗口期"
  );
  assert.strictEqual(g({ elapsedMs: 1001, graceMs: 1000 }), false, "超窗不放行");
  assert.strictEqual(g({ elapsedMs: -1, graceMs: 1000 }), false, "负值非法");
  assert.strictEqual(g({ elapsedMs: 10, graceMs: Number.NaN }), false);
});
