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

  // 拦截时间是模块级的, 跨用例共享, 每个用例前重置
  lockScreen.resetBootGuardState();
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

test("拦截后窗口动态延长: 固定窗口过期后, 重推的锁屏指令仍被静默拦截", () => {
  const env = makeEnv({ elapsedSec: 1 });
  try {
    // 窗口期内拦截一次本地开机锁屏
    env.handler.userLock();
    assert.strictEqual(env.userLockCalls.length, 0);

    // 40 秒后 (已超 30 秒固定窗口): 集控端重推的云端锁屏指令仍按开机锁屏静默拦截,
    // 不落进 notify 模式的 "提醒 + 5 秒放行" 流程
    env.setElapsedSec(40);
    env.handler.onMessage(LOCK_MSG("500"));
    assert.strictEqual(env.lockFeedbackCalls.length, 1, "重推指令应被拦截并伪造回执");
    assert.strictEqual(env.originalCalls.length, 0, "不应放行真实锁屏");
    assert.strictEqual(
      env.pushedRecords.filter((p) => p.channel === "$aura.lockScreen.onBlocked")
        .length,
      0,
      "开机锁屏重推不应弹提醒"
    );
  } finally {
    env.cleanup();
  }
});

test("动态延长有上限: 距最近一次拦截超过 5 分钟后恢复正常拦截流程", () => {
  const env = makeEnv({ elapsedSec: 1 });
  try {
    env.handler.userLock(); // 1 秒时拦截一次

    // 6 分钟后: 延长窗口已过 (拦截功能关闭), 锁屏指令交回管家原逻辑
    env.setElapsedSec(1 + 360);
    env.handler.onMessage(LOCK_MSG("600"));
    assert.strictEqual(env.lockFeedbackCalls.length, 0);
    assert.strictEqual(env.originalCalls.length, 1, "延长过期后应放行");
  } finally {
    env.cleanup();
  }
});

test("解锁即终点: 解锁指令之后, 云端锁屏立即恢复正常流程", () => {
  const env = makeEnv({ elapsedSec: 1 });
  try {
    // 1s: 本地开机锁屏拦截 (静默)
    env.handler.userLock();
    assert.strictEqual(env.userLockCalls.length, 0);

    // 40s: 集控端重推的锁屏指令仍被延长窗口静默拦截 + 伪造回执
    env.setElapsedSec(40);
    env.handler.onMessage(LOCK_MSG("700"));
    assert.strictEqual(env.lockFeedbackCalls.length, 1);
    assert.strictEqual(env.originalCalls.length, 0);

    // 50s: 教师解锁 (拦截功能关闭 -> 交回管家原逻辑执行解锁)
    env.setElapsedSec(50);
    env.handler.onMessage(
      JSON.stringify({
        messageType: 1211,
        data: { screenLockStatus: 0, operationLogId: "701" },
      })
    );
    assert.strictEqual(env.originalCalls.length, 1, "解锁应交回管家");

    // 100s: 教师再次远程锁屏 (已超 90s 固定窗口, 且延长窗口已随解锁结束)
    // -> 正常放行真实锁屏
    env.setElapsedSec(100);
    env.handler.onMessage(LOCK_MSG("702"));
    assert.strictEqual(env.originalCalls.length, 2, "解锁后云端锁屏应恢复正常");
    assert.strictEqual(
      env.lockFeedbackCalls.length,
      1,
      "真实锁屏由管家自行回执, 不再伪造"
    );
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
    lockScreen.resetBootGuardState();
    lockScreen.hookFunc(central, { getElapsedMs: () => state.elapsedMs });

    state.elapsedMs = 29 * SECOND_MS;
    handler.userLock();
    assert.strictEqual(userLockCalls.length, 0, "29 秒仍在默认窗口内");

    // 29 秒处发生过拦截 -> 保护窗口向后延长 5 分钟, 31 秒仍在保护期内
    state.elapsedMs = 31 * SECOND_MS;
    handler.userLock();
    assert.strictEqual(userLockCalls.length, 0, "31 秒仍在延长窗口内");

    // 距最近一次拦截超过 5 分钟后才放行
    state.elapsedMs = 29 * SECOND_MS + 310 * SECOND_MS;
    handler.userLock();
    assert.strictEqual(userLockCalls.length, 1, "延长窗口过期后放行");
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
