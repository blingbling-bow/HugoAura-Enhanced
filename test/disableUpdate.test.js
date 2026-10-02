// @ts-check

/**
 * disableUpdate 端到端集成测试 (不需要安装希沃管家)。
 *
 * 覆盖两层拦截, 重点是本次 bug 的回归:
 *   现象: 开着更新拦截, 管家仍然"检测到有新版本"。
 *   原因: 前端 hasUpdate 只由 DataBus 里的 UPGRADE_STATUS 决定
 *         (assistant.js: handleGetUpgradeStatus = e => setState({hasUpdate: e.status === 1}))。
 *         而 WS 层的消息拦截存在时序/通道漏洞 (真机日志里同一条
 *         /serviceUpgrade/status 第一次被拦、第二次漏过), 处理器级拦截又只在
 *         disableUpdate 打开时生效 —— 漏过的消息照样会 share("UPGRADE_STATUS")。
 *   修法: 在 DataBus 层把状态改写成"已是最新", 与通道、时序都无关。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const disableUpdate = require("../src/aura/mainProcess/hooks/disableUpdate");

/** 与真实模块 2 同构的共享数据总线 */
const makeFakeDataBus = () => {
  const published = [];
  const bus = {
    shareData: {},
    storeData: {},
    getData(key) {
      return Object.prototype.hasOwnProperty.call(this.storeData, key)
        ? this.storeData[key]
        : null;
    },
    setData(obj) {
      Object.assign(this.storeData, obj);
    },
    publishData(typeName, value) {
      published.push({ typeName, value });
    },
    share(typeName, value, windowKey) {
      if (windowKey) {
        if (!this.shareData[windowKey]) this.shareData[windowKey] = {};
        this.shareData[windowKey][typeName] = value;
      } else {
        if (!this.shareData._default) this.shareData._default = {};
        this.shareData._default[typeName] = value;
      }
      this.publishData(typeName, value);
    },
  };
  return { bus, published };
};

/** 假的升级状态分发器: onMessage 必须在原型上, 源码含 UPGRADE_STATUS/UPGRADE_FEEDBACK */
class FakeUpgradeHandler {
  constructor() {
    this.calls = [];
  }
  onMessage(e) {
    this.calls.push(e);
    if (e && e.url === "/serviceUpgrade/status") this.lastShared = "UPGRADE_STATUS";
    if (e && e.url === "/serviceUpgrade/feedback") this.lastShared = "UPGRADE_FEEDBACK";
  }
}

const makeCentral = (bus, handler) => {
  const modules = {
    0: { proxyWebsocketHost: { ip: "wss://127.0.0.1", url: "/SeewoProxy" } },
    1: { ipcMain: { send() {} } },
    2: bus,
    394: handler,
  };
  const central = (id) => {
    if (!(id in modules)) {
      const err = new Error(`Cannot find module '${id}'`);
      // @ts-ignore 与 webpack 一致
      err.code = "MODULE_NOT_FOUND";
      throw err;
    }
    return modules[id];
  };
  central.m = {};
  central.c = {};
  return central;
};

const setConfig = ({ disableUpdate: du = false, cloudIntercept = false } = {}) => {
  // @ts-ignore 钩子通过 global.__HUGO_AURA_CONFIG_MGR__.loadConfig() 读配置
  global.__HUGO_AURA_CONFIG_MGR__ = {
    loadConfig: () => ({
      auraSettings: {
        disableUpdate: du,
        cloudUpdateIntercept: { enabled: cloudIntercept },
      },
    }),
  };
};

const UPGRADE_PAYLOAD = {
  latestVersion: "9.9.9",
  localVersion: "1.6.7.4018",
  status: 1,
};

test("回归: 漏过模块 394 的 UPGRADE_STATUS 在数据总线层被改写成已是最新", () => {
  const { bus, published } = makeFakeDataBus();
  const handler = new FakeUpgradeHandler();
  setConfig({ disableUpdate: true });

  disableUpdate.hookFunc(makeCentral(bus, handler));

  // 模拟"绕过处理器直接共享"的漏网消息
  bus.share("UPGRADE_STATUS", { ...UPGRADE_PAYLOAD });

  const last = published[published.length - 1];
  assert.equal(last.typeName, "UPGRADE_STATUS");
  assert.equal(last.value.status, 0, "status 必须置 0, 前端才不会显示升级入口");
  assert.equal(
    last.value.latestVersion,
    "1.6.7.4018",
    "latestVersion 应被拉回本地版本"
  );
  assert.equal(
    bus.shareData._default.UPGRADE_STATUS.status,
    0,
    "共享存储里的值同样必须被改写 (前端 getAndRegister 读的就是它)"
  );
});

test("UPGRADE_FEEDBACK 被改写成无事发生", () => {
  const { bus, published } = makeFakeDataBus();
  const handler = new FakeUpgradeHandler();
  setConfig({ disableUpdate: true });

  disableUpdate.hookFunc(makeCentral(bus, handler));
  bus.share("UPGRADE_FEEDBACK", { upgradeStatus: 3 });

  assert.equal(published[published.length - 1].value.upgradeStatus, 0);
});

test("处理器级: 吞掉升级状态/反馈, 其它消息原样透传", () => {
  const { bus } = makeFakeDataBus();
  const handler = new FakeUpgradeHandler();
  setConfig({ disableUpdate: true });

  disableUpdate.hookFunc(makeCentral(bus, handler));

  handler.onMessage({ url: "/serviceUpgrade/status", data: {} });
  handler.onMessage({ url: "/serviceUpgrade/feedback", data: {} });
  assert.deepEqual(handler.calls, [], "升级消息不应到达原始处理器");

  handler.onMessage({ url: "/disableCover", data: {} });
  assert.equal(handler.calls.length, 1, "其它消息必须透传");
});

test("仅打开「云端更新指令全面拦截」时, 数据总线兜底同样生效", () => {
  const { bus, published } = makeFakeDataBus();
  const handler = new FakeUpgradeHandler();
  setConfig({ cloudIntercept: true });

  disableUpdate.hookFunc(makeCentral(bus, handler));

  bus.share("UPGRADE_STATUS", { ...UPGRADE_PAYLOAD });
  assert.equal(
    published[published.length - 1].value.status,
    0,
    "只开云端拦截时也必须压制状态"
  );

  // 处理器级这层只认 disableUpdate, 因此消息照常透传 (由 WS 层负责)
  handler.onMessage({ url: "/serviceUpgrade/status", data: {} });
  assert.equal(handler.calls.length, 1);
});

test("两个开关都关时: 不改写也不拦截", () => {
  const { bus, published } = makeFakeDataBus();
  const handler = new FakeUpgradeHandler();
  setConfig({});

  disableUpdate.hookFunc(makeCentral(bus, handler));

  bus.share("UPGRADE_STATUS", { ...UPGRADE_PAYLOAD });
  assert.deepEqual(published[published.length - 1].value, UPGRADE_PAYLOAD);

  handler.onMessage({ url: "/serviceUpgrade/status", data: {} });
  assert.equal(handler.calls.length, 1);
});

test("安装时清掉钩子生效前已共享出去的『有更新』状态", () => {
  const { bus, published } = makeFakeDataBus();
  // 模拟: 钩子安装前主进程已经广播过一次"有更新"
  bus.shareData._default = { UPGRADE_STATUS: { ...UPGRADE_PAYLOAD } };
  const handler = new FakeUpgradeHandler();
  setConfig({ disableUpdate: true });

  disableUpdate.hookFunc(makeCentral(bus, handler));

  const last = published[published.length - 1];
  assert.equal(last.typeName, "UPGRADE_STATUS");
  assert.equal(last.value.status, 0);
  assert.equal(bus.shareData._default.UPGRADE_STATUS.status, 0);
});

/**
 * 造一个"DataBus 尚未就绪"的 central: 处理器 (394) 可用, 但模块 2 抛错。
 * 用于验证两层懒加载时机不同时的重试行为。
 */
const makeCentralWithLateDataBus = (bus, handler) => {
  const base = makeCentral(bus, handler);
  let dataBusAvailable = false;
  const central = (id) => {
    if (id === 2 && !dataBusAvailable) {
      const err = new Error("Cannot find module '2'");
      // @ts-ignore 与 webpack 一致
      err.code = "MODULE_NOT_FOUND";
      throw err;
    }
    return base(id);
  };
  central.m = base.m;
  central.c = base.c;
  return {
    central,
    releaseDataBus: () => {
      dataBusAvailable = true;
    },
  };
};

/** 捕获 withRetry 排下的重试回调 (它用 setTimeout), 由测试手动驱动 */
const captureRetries = (run) => {
  const originalSetTimeout = global.setTimeout;
  const pending = [];
  // @ts-ignore
  global.setTimeout = (fn) => {
    pending.push(fn);
    return { unref() {} };
  };
  try {
    run();
  } finally {
    global.setTimeout = originalSetTimeout;
  }
  return pending;
};

test("回归: DataBus 未就绪时不得提前结束重试, 重试后必须补装兜底", () => {
  const { bus, published } = makeFakeDataBus();
  const handler = new FakeUpgradeHandler();
  setConfig({ disableUpdate: true });

  const { central, releaseDataBus } = makeCentralWithLateDataBus(bus, handler);
  const pending = captureRetries(() => disableUpdate.hookFunc(central));

  // 处理器层已成功, 但 DataBus 层没成功 -> 整体不得判定为安装完成
  assert.equal(
    pending.length,
    1,
    "DataBus 未就绪时必须安排重试 (否则兜底永远不会补装)"
  );

  // 第二次尝试: DataBus 已就绪
  releaseDataBus();
  pending[0]();

  // 兜底必须已补装并生效
  bus.share("UPGRADE_STATUS", { ...UPGRADE_PAYLOAD });
  assert.equal(
    published[published.length - 1].value.status,
    0,
    "重试后 DataBus 兜底必须补装成功"
  );

  // 两层都就绪后不应再排新的重试
  assert.equal(pending.length, 1);
});

test("幂等: 重试不会把 onMessage 层层包裹", () => {
  const { bus } = makeFakeDataBus();
  const handler = new FakeUpgradeHandler();
  setConfig({ disableUpdate: true });

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));

  try {
    const { central, releaseDataBus } = makeCentralWithLateDataBus(bus, handler);
    const pending = captureRetries(() => disableUpdate.hookFunc(central));

    const wrappedOnce = handler.onMessage;
    assert.equal(pending.length, 1);

    releaseDataBus();
    pending[0]();

    assert.equal(
      handler.onMessage,
      wrappedOnce,
      "重试不得重新包裹 onMessage (否则每层重复判断、日志重复)"
    );
    const installedLogs = logs.filter((l) =>
      l.includes("Source interception installed (module 394)")
    );
    assert.equal(installedLogs.length, 1, "安装日志只应出现一次");

    // 包裹仍然只有一层: 升级消息依然被吞掉
    handler.onMessage({ url: "/serviceUpgrade/status", data: {} });
    assert.deepEqual(handler.calls, []);
  } finally {
    console.log = originalLog;
  }
});
