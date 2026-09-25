// @ts-check

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  hookFunc,
} = require("../src/aura/mainProcess/hooks/keepPasswordUnlock");

const HANDLER_ID = 137;
const DATA_BUS_ID = 2;
const UNLOCK_MODE_MESSAGE_TYPE = 1214;

// 钩子内部会打日志, 测试期间静音, 避免污染测试输出
const silently = (fn) => {
  const log = console.log;
  const warn = console.warn;
  const error = console.error;
  const dbg = console.debug;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  console.debug = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = error;
    console.debug = dbg;
  }
};

/** 数据总线桩: 记录每一次 share 调用 */
const buildDataBus = () => ({
  shared: [],
  share(name, value, windowName) {
    this.shared.push({ name, value, windowName });
  },
  getData() {
    return null;
  },
  setData() {},
});

/**
 * 解锁方式策略处理器桩 (模块 137)。
 * 行为与原生一致: messageType 1214 且 unlockMode === 1 时把
 * "hasNetworkHidePasswordBlock" 共享为 true。
 */
class FakePasswordPolicyHandler {
  constructor(dataBus) {
    this.message = null;
    this.dataBus = dataBus;
  }

  onMessage(message) {
    this.message = message;
    if (message && message.messageType === UNLOCK_MODE_MESSAGE_TYPE) {
      this.dataBus.share(
        "hasNetworkHidePasswordBlock",
        Boolean(message.data && message.data.unlockMode === 1)
      );
    }
  }

  getMessage() {
    return this.message;
  }
}

/**
 * 装好钩子后投递一条消息, 返回 (数据总线, 处理器) 供断言。
 * shared 中记录的即钩子放行/改写后真实共享出去的值。
 */
const dispatch = (enabled, message) => {
  global.__HUGO_AURA_CONFIG_MGR__ = {
    loadConfig: () => ({
      networkRewrite: { "appearance/keepPasswordUnlock": { enabled } },
    }),
  };

  const dataBus = buildDataBus();
  const handler = new FakePasswordPolicyHandler(dataBus);
  const configListeners = [];
  global.__HUGO_AURA_EVENT_BUS__ = {
    on(name, fn) {
      if (name === "$aura.config.refreshConfig") configListeners.push(fn);
    },
  };

  const central = (id) => {
    assert.ok(
      id === HANDLER_ID || id === DATA_BUS_ID,
      `钩子不应加载其他模块 (实际 ${id})`
    );
    return id === HANDLER_ID ? handler : dataBus;
  };

  silently(() => hookFunc(central));
  const installShares = dataBus.shared.slice();
  silently(() => handler.onMessage(message));
  // 安装阶段 (开关打开时会主动复位一次) 与本次消息分开统计
  const messageShares = dataBus.shared.slice(installShares.length);
  return { dataBus, handler, configListeners, installShares, messageShares };
};

const UNLOCK_MODE_HIDE = {
  messageType: UNLOCK_MODE_MESSAGE_TYPE,
  data: { unlockMode: 1 },
};
const UNLOCK_MODE_SHOW = {
  messageType: UNLOCK_MODE_MESSAGE_TYPE,
  data: { unlockMode: 0 },
};

test("开关开启时 unlockMode=1 被改写: 密码解锁标记不会被置为 true", () => {
  const { messageShares, handler } = dispatch(true, UNLOCK_MODE_HIDE);
  assert.deepEqual(
    messageShares.map((c) => c.value),
    [false]
  );
  // 原生处理器未被调用 (message 由原生逻辑写入)
  assert.equal(handler.message, null);
});

test("开关开启时 unlockMode=0 同样只共享 false (消息不再交给原生)", () => {
  const { messageShares, handler } = dispatch(true, UNLOCK_MODE_SHOW);
  assert.deepEqual(
    messageShares.map((c) => c.value),
    [false]
  );
  assert.equal(handler.message, null);
});

test("开关关闭时 unlockMode=1 照常透传, 原生行为保留", () => {
  const { messageShares, handler, installShares } = dispatch(
    false,
    UNLOCK_MODE_HIDE
  );
  assert.equal(installShares.length, 0);
  assert.deepEqual(
    messageShares.map((c) => c.value),
    [true]
  );
  assert.equal(handler.message, UNLOCK_MODE_HIDE);
});

test("开关关闭时 unlockMode=0 照常透传", () => {
  const { messageShares, handler } = dispatch(false, UNLOCK_MODE_SHOW);
  assert.deepEqual(
    messageShares.map((c) => c.value),
    [false]
  );
  assert.equal(handler.message, UNLOCK_MODE_SHOW);
});

test("其他 messageType (1212 扫码回执) 无论开关如何都原样透传", () => {
  const message = { messageType: 1212, data: { foo: "bar" } };
  const on = dispatch(true, message);
  assert.equal(on.handler.message, message);
  // 开关打开时只有安装阶段的复位, 消息本身不产生任何共享值
  assert.equal(on.messageShares.length, 0);
  assert.equal(on.installShares.length, 1);

  const off = dispatch(false, message);
  assert.equal(off.handler.message, message);
  assert.equal(off.messageShares.length, 0);
  assert.equal(off.installShares.length, 0);
});

test("字符串形式的策略消息同样能被识别并改写", () => {
  const { messageShares, handler } = dispatch(
    true,
    JSON.stringify(UNLOCK_MODE_HIDE)
  );
  assert.deepEqual(
    messageShares.map((c) => c.value),
    [false]
  );
  assert.equal(handler.message, null);
});

test("钩子安装时开关已打开: 立即复位残留的共享值", () => {
  const { installShares, handler } = dispatch(true, {
    messageType: 9999,
    data: {},
  });
  assert.deepEqual(
    installShares.map((c) => c.value),
    [false]
  );
  assert.equal(handler.message.messageType, 9999);
});

test("配置热更新: 打开开关时复位共享值, 关闭时不动", () => {
  const { dataBus, configListeners } = dispatch(false, {
    messageType: 9999,
    data: {},
  });
  assert.equal(configListeners.length, 1);
  assert.equal(dataBus.shared.length, 0);

  // 关闭状态下的刷新事件不应改写任何值
  silently(() => configListeners[0]());
  assert.equal(dataBus.shared.length, 0);

  // 打开开关后再刷新: 复位为 false
  global.__HUGO_AURA_CONFIG_MGR__ = {
    loadConfig: () => ({
      networkRewrite: { "appearance/keepPasswordUnlock": { enabled: true } },
    }),
  };
  silently(() => configListeners[0]());
  assert.deepEqual(
    dataBus.shared.map((c) => c.value),
    [false]
  );
});