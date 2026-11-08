// @ts-check

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const USB_PATH = require.resolve("../src/aura/mainProcess/hooks/autoOpenUsb.js");
const usb = require(USB_PATH);

const C_BIT = 1 << 2;
const E_BIT = 1 << 4;

test("maskToDrives: 盘符位图转根路径 (bit0=A ... bit25=Z)", () => {
  assert.deepStrictEqual(usb.maskToDrives(0), []);
  assert.deepStrictEqual(usb.maskToDrives(1), ["A:\\"]);
  assert.deepStrictEqual(usb.maskToDrives(E_BIT), ["E:\\"]);
  assert.deepStrictEqual(usb.maskToDrives((C_BIT | E_BIT) >>> 0), [
    "C:\\",
    "E:\\",
  ]);
});

/** 模拟希沃管家 WS 基类派生的病毒服务处理器 (模块 141) */
class FakeVirusHandler {
  constructor() {
    this.calls = [];
    this.usbList = [];
    // WS 基类构造器初始化的状态字段 (isWsClientInstance 据此确认身份)
    this.ws = "";
    this.start = false;
    this.ready = false;
    this.relink = false;
    this.intervals = 0;
    this.onMessage = this.onMessage.bind(this);
  }
  setHost() {}
  sendMessage() {}
  onMessage(raw) {
    // 自检特征: 源码必须包含 "USB_LIST"
    this.calls.push(raw);
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

/**
 * 装配环境并加载全新模块实例 (观察器启动标记/打开记录是模块级的,
 * 每个用例必须拿到独立实例)。
 */
const makeEnv = (t, opts = {}) => {
  const state = { mask: opts.initialMask || 0, exists: opts.exists !== false };
  const opened = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-usb-test-"));

  global.__HUGO_AURA__ = global.__HUGO_AURA__ || {};
  global.__HUGO_AURA__.auraDir = tmpDir;
  global.__HUGO_AURA_CONFIG_MGR__ = {
    loadConfig: () => ({
      networkRewrite: { "appearance/autoOpenUsb": { enabled: true } },
    }),
  };

  const handler = new FakeVirusHandler();
  const central = (id) => {
    if (id === 1) {
      return {
        shell: {
          openPath: async (p) => {
            opened.push(p);
            return "";
          },
        },
      };
    }
    if (id === 42) {
      return {
        Library: (name, funcs) => ({
          GetLogicalDrives: () => state.mask >>> 0,
          GetDriveTypeA: () => usb.DRIVE_REMOVABLE,
        }),
      };
    }
    if (id === 141) return handler;
    return undefined;
  };

  t.mock.timers.enable({ apis: ["setInterval", "Date"] });

  delete require.cache[USB_PATH];
  const fresh = require(USB_PATH);
  fresh.hookFunc(central, { driveFs: { existsSync: () => state.exists } });

  const sendUsbList = (paths) => {
    handler.onMessage(
      JSON.stringify({ messageType: 1003, data: { diskList: paths.map((p) => ({ path: p })) } })
    );
  };

  return {
    handler,
    opened,
    state,
    sendUsbList,
    cleanup() {
      delete global.__HUGO_AURA_CONFIG_MGR__;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
};

test("快速观察器: 新插入的可移动驱动器在一个轮询周期内打开", (t) => {
  const env = makeEnv(t);
  try {
    // 首个 tick: 首帧只登记快照 (启动时已有的盘不打开)
    t.mock.timers.tick(usb.FAST_POLL_INTERVAL_MS);
    assert.deepStrictEqual(env.opened, []);

    // 插入 E: 盘 (位图出现新位) -> 下一个 tick 立即打开
    env.state.mask = E_BIT;
    t.mock.timers.tick(usb.FAST_POLL_INTERVAL_MS);
    assert.deepStrictEqual(env.opened, ["E:\\"]);
  } finally {
    env.cleanup();
  }
});

test("快速观察器: 驱动器未就绪时按 tick 重试, 就绪后立即打开", (t) => {
  const env = makeEnv(t, { exists: false });
  try {
    t.mock.timers.tick(usb.FAST_POLL_INTERVAL_MS); // prime
    env.state.mask = E_BIT;

    // 卷尚未就绪: 连续 3 个 tick 都只重试, 不打开
    t.mock.timers.tick(usb.FAST_POLL_INTERVAL_MS * 3);
    assert.deepStrictEqual(env.opened, []);

    // 卷就绪 -> 下一个 tick 打开
    env.state.exists = true;
    t.mock.timers.tick(usb.FAST_POLL_INTERVAL_MS);
    assert.deepStrictEqual(env.opened, ["E:\\"]);
  } finally {
    env.cleanup();
  }
});

test("1003 慢推送回声: 观察器打开后 60 秒内不重复打开, 过期后兜底生效", (t) => {
  const env = makeEnv(t, { initialMask: 0 });
  try {
    // 观察器打开 C: 盘 (该盘在本机真实存在, 兜底路径的 existsSync 能通过)
    t.mock.timers.tick(usb.FAST_POLL_INTERVAL_MS); // prime
    env.state.mask = C_BIT;
    t.mock.timers.tick(usb.FAST_POLL_INTERVAL_MS);
    assert.deepStrictEqual(env.opened, ["C:\\"]);

    // 1003 首帧: 只登记快照
    env.sendUsbList([]);
    assert.deepStrictEqual(env.opened, ["C:\\"]);

    // 推送延迟 ~10s 后到达 (>5s 跨进程去重窗口, 但 <60s 观察器 TTL):
    // 同一驱动器不再重复打开
    t.mock.timers.tick(10 * 1000);
    env.sendUsbList(["C:/"]);
    assert.deepStrictEqual(env.opened, ["C:\\"]);

    // TTL (60s) 过期后, 1003 兜底路径恢复生效 (观察器失效场景的兜底语义)
    t.mock.timers.tick(60 * 1000);
    env.sendUsbList(["C:/"]);
    assert.deepStrictEqual(env.opened, ["C:\\", "C:\\"]);
  } finally {
    env.cleanup();
  }
});
