// @ts-check

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  hookFunc,
} = require("../src/aura/mainProcess/hooks/deviceLinkNotify");

const MANAGER_ID = 58;

// 钩子内部会打日志, 测试期间静音, 避免污染测试输出
const silently = (fn) => {
  const log = console.log;
  const warn = console.warn;
  const error = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = error;
  }
};

const LINKED_CFG = { type: "wifidongle", state: 1, model: "M1", sid: "42" };
const BROKEN_CFG = { type: "wifidongle", state: 0, model: "M1", sid: "42" };
const CUSTOM_CFG = {
  type: "smartpen",
  state: 2,
  model: "SP20E",
  title: "匹配失败",
  subTitle: "请重置智能笔",
};

/**
 * 装好钩子后触发一次建窗, 返回实际落到原生 createWindow 的调用记录。
 * 记录为空 = 提示被拦下。
 */
const callCreateWindow = (enabled, config, windowId) => {
  global.__HUGO_AURA_CONFIG_MGR__ = {
    loadConfig: () => ({
      networkRewrite: { "appearance/hideDeviceLinkNotify": { enabled } },
    }),
  };

  const calls = [];
  const manager = {
    windowList: {},
    waitList: {},
    createWindow(innerConfig, innerWindowId) {
      calls.push({ config: innerConfig, windowId: innerWindowId });
      return { windowId: innerWindowId };
    },
    closeWindow() {},
    checkWindowExist() {
      return false;
    },
  };

  const central = (id) => {
    assert.equal(id, MANAGER_ID, `钩子不应加载其他模块 (实际 ${id})`);
    return manager;
  };

  silently(() => hookFunc(central));
  silently(() => manager.createWindow(config, windowId));
  return calls;
};

test("开关开启时不创建「连接成功」提示窗", () => {
  assert.equal(callCreateWindow(true, LINKED_CFG, "wifidongleM142").length, 0);
});

test("开关开启时不创建「断开连接」提示窗", () => {
  assert.equal(callCreateWindow(true, BROKEN_CFG, "wifidongleM142").length, 0);
});

test("开关开启时仍放行 CUSTOM 告警 (智能笔配对失败)", () => {
  const calls = callCreateWindow(true, CUSTOM_CFG, "SP20E_MATCH_FAIL");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].config, CUSTOM_CFG);
});

test("开关关闭时照常放行上下线提示, 且参数原样透传", () => {
  const calls = callCreateWindow(false, LINKED_CFG, "wifidongleM142");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].windowId, "wifidongleM142");
  assert.deepEqual(calls[0].config, LINKED_CFG);
});

test("state 缺失的未知配置不被误拦", () => {
  const config = { type: "unknown", model: "X", sid: "1" };
  const calls = callCreateWindow(true, config, "unknownX1");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].config, config);
});
