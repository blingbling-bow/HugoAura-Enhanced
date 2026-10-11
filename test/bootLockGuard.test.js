// @ts-check
"use strict";

/**
 * 开机锁屏保护 (禁止开机自动锁屏) 集成测试
 *
 * 覆盖: 窗口期内云端锁屏指令被拦截并伪造回执; 窗口期外放行; 功能关闭时放行;
 * 回执通道失败时 fail-closed 放行 (与 lockScreenIntercept 同一套语义);
 * 解锁指令不受开机保护影响; 本地 userLock 路径 (真机取证的开机自动锁屏
 * 实际触发路径, 模块 375 "锁屏并注销"流程) 在窗口期内被吞掉、窗口期外放行。
 *
 * 窗口从"钩子安装"(管家程序启动) 起算, 默认 90 秒 —— 用户的场景是
 * "程序一打开就会锁屏", 锁屏在启动后极短时间内发生。
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
  const userLockCalls = [];
  const pushedRecords = [];

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
  handler.userLock = () => {
    userLockCalls.push(1);
  };
  handler.stopLockTask = () => {};
  handler.onMessage = handler.onMessage.bind(handler);

  const stubs = {
    1: {
      ipcMain: {
        // Aura 定制的 ipcMain.send 签名: (windowKey, channel, data)
        send: (windowKey, channel, data) =>
          pushedRecords.push({ windowKey, channel, data }),
      },
    },
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
    userLockCalls,
    pushedRecords,
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
    // 静默拦截: 不弹提醒
    assert.strictEqual(
      env.pushedRecords.filter((p) => p.channel === "$aura.lockScreen.onBlocked")
        .length,
      0,
      "开机拦截不应推送提醒"
    );
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

test("窗口期内: 本地 userLock (下课锁屏流程) 被吞掉并记审计", () => {
  const env = makeEnv({ elapsedSec: 1 });
  try {
    env.handler.userLock();

    assert.strictEqual(
      env.userLockCalls.length,
      0,
      "真实锁屏调用应被跳过"
    );
    const pushed = env.pushedRecords.filter(
      (p) => p.channel === "$aura.audit.onLog"
    );
    assert.strictEqual(pushed.length, 1, "应推送一条审计记录");
    assert.strictEqual(pushed[0].data.record.bootGuard, true);
    assert.strictEqual(pushed[0].data.record.url, "local:userLock");
    assert.strictEqual(pushed[0].data.record.action, "blocked");
    // 本地路径无云端指令, 不伪造回执
    assert.strictEqual(env.lockFeedbackCalls.length, 0);
    // 静默拦截: 不弹提醒
    assert.strictEqual(
      env.pushedRecords.filter((p) => p.channel === "$aura.lockScreen.onBlocked")
        .length,
      0,
      "开机拦截不应推送提醒"
    );
  } finally {
    env.cleanup();
  }
});

test("窗口期外: 本地 userLock 照常执行 (手动下课锁屏不受影响)", () => {
  const env = makeEnv({ elapsedSec: 1 });
  try {
    env.setElapsedSec(120); // 超过 90 秒窗口

    env.handler.userLock();

    assert.strictEqual(env.userLockCalls.length, 1, "应原样执行");
    assert.strictEqual(env.pushedRecords.length, 0, "不应产生审计/推送");
  } finally {
    env.cleanup();
  }
});

test("功能关闭时: 本地 userLock 照常执行", () => {
  const env = makeEnv({ bootEnabled: false, elapsedSec: 1 });
  try {
    env.handler.userLock();
    assert.strictEqual(env.userLockCalls.length, 1);
    assert.strictEqual(env.pushedRecords.length, 0);
  } finally {
    env.cleanup();
  }
});

test("未配置 graceSeconds 时默认窗口为 30 秒", () => {
  // makeEnv 只覆盖 enabled/graceSeconds 两个字段, 这里直接构造
  // 缺 graceSeconds 的配置验证代码内回退值
  const state = { elapsedMs: 0 };
  const userLockCalls = [];
  const handler = Object.create({
    onMessage(e) {
      this.calls.push(e);
    },
  });
  handler.message = null;
  handler.windows = [];
  // 结构特征自检要求 startLockTask / userLock / stopLockTask 同时存在
  handler.startLockTask = () => {};
  handler.userLock = () => userLockCalls.push(1);
  handler.stopLockTask = () => {};

  const central = (id) =>
    ({
      1: { ipcMain: { send() {} } },
      33: handler,
      310: () => true,
      311: () => true,
    })[id];
  global.__HUGO_AURA_CONFIG_MGR__ = {
    loadConfig: () => ({
      auraSettings: { preventBootLock: { enabled: true } },
    }),
  };

  try {
    lockScreen.hookFunc(central, { getElapsedMs: () => state.elapsedMs });

    state.elapsedMs = 29 * SECOND_MS;
    handler.userLock();
    assert.strictEqual(userLockCalls.length, 0, "29 秒仍在默认窗口内");

    state.elapsedMs = 31 * SECOND_MS;
    handler.userLock();
    assert.strictEqual(userLockCalls.length, 1, "31 秒已超出默认窗口");
  } finally {
    delete global.__HUGO_AURA_CONFIG_MGR__;
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
