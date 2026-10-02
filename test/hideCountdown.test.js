// @ts-check

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  hookFunc,
  isCountdownUrl,
} = require("../src/aura/mainProcess/hooks/hideCountdown");

class MockWindow {
  constructor(url = "") {
    this.webContents = {
      getURL: () => url,
      on: () => {},
    };
    this.hidden = false;
    this.showCalls = 0;
    this.hideCalls = 0;
    this.listeners = new Map();
  }

  isDestroyed() {
    return false;
  }

  show() {
    this.showCalls++;
    this.hidden = false;
  }

  showInactive() {
    this.showCalls++;
    this.hidden = false;
  }

  hide() {
    this.hideCalls++;
    this.hidden = true;
  }

  once(event, listener) {
    this.listeners.set(event, listener);
  }
}

const createHarness = (enabled = true) => {
  const slotManager = {
    slotList: ["countdown", "notice"],
    hideSlot(name) {
      this.slotList = this.slotList.filter((item) => item !== name);
    },
    showSlot(name) {
      if (!this.slotList.includes(name)) this.slotList.push(name);
    },
  };
  const appListeners = new Map();
  const app = {
    on(event, listener) {
      appListeners.set(event, listener);
    },
  };
  const electron = {
    BrowserWindow: { getAllWindows: () => [] },
    app,
  };
  const windowManager = {
    newOne() {
      return new MockWindow("file:///app/countdown.html");
    },
    checkWindowExist: () => false,
    getInstance: () => null,
  };
  const central = (id) => {
    if (id === 1) return electron;
    if (id === 3) return windowManager;
    if (id === 19) return slotManager;
    return null;
  };
  global.__HUGO_AURA_CONFIG_MGR__ = {
    loadConfig: () => ({
      networkRewrite: {
        "appearance/hideCountdown": { enabled },
      },
    }),
  };
  global.__HUGO_AURA_EVENT_BUS__ = {
    on(_event, listener) {
      appListeners.set("config-refresh", listener);
      return () => appListeners.delete("config-refresh");
    },
  };
  return { central, slotManager, windowManager, appListeners };
};

test("倒计日窗口创建时隐藏并释放槽位，重复 show 仍保持隐藏", () => {
  const previousConfig = global.__HUGO_AURA_CONFIG_MGR__;
  const previousBus = global.__HUGO_AURA_EVENT_BUS__;
  const harness = createHarness(true);
  try {
    hookFunc(harness.central);
    const win = harness.windowManager.newOne("countdown");

    assert.equal(win.hidden, true);
    assert.equal(win.hideCalls, 1);
    assert.deepEqual(harness.slotManager.slotList, ["notice"]);

    win.show();
    assert.equal(win.hidden, true);
    assert.equal(win.hideCalls, 1);
    assert.deepEqual(harness.slotManager.slotList, ["notice"]);
  } finally {
    global.__HUGO_AURA_CONFIG_MGR__ = previousConfig;
    global.__HUGO_AURA_EVENT_BUS__ = previousBus;
  }
});

test("关闭开关后恢复倒计日窗口和槽位", () => {
  const previousConfig = global.__HUGO_AURA_CONFIG_MGR__;
  const previousBus = global.__HUGO_AURA_EVENT_BUS__;
  let enabled = true;
  const harness = createHarness(enabled);
  global.__HUGO_AURA_CONFIG_MGR__.loadConfig = () => ({
    networkRewrite: { "appearance/hideCountdown": { enabled } },
  });
  try {
    hookFunc(harness.central);
    const win = harness.windowManager.newOne("countdown");
    enabled = false;
    harness.appListeners.get("config-refresh")();

    assert.equal(win.hidden, false);
    assert.equal(win.showCalls, 1);
    assert.deepEqual(harness.slotManager.slotList, ["notice", "countdown"]);
  } finally {
    global.__HUGO_AURA_CONFIG_MGR__ = previousConfig;
    global.__HUGO_AURA_EVENT_BUS__ = previousBus;
  }
});

test("isCountdownUrl 识别倒计日页面", () => {
  assert.equal(
    isCountdownUrl("file:///C:/app/public/countdown.html"),
    true
  );
  assert.equal(
    isCountdownUrl("file:///C:/app/public/countdown.html?windowName=countdown"),
    true
  );
  assert.equal(
    isCountdownUrl("C:\\Seewo\\resources\\app.asar\\public\\countdown.html"),
    true
  );
});

test("isCountdownUrl 不误伤其它页面", () => {
  assert.equal(isCountdownUrl("file:///C:/app/public/assistant.html"), false);
  assert.equal(
    isCountdownUrl("file:///C:/app/public/countdownExtra.html"),
    false
  );
  assert.equal(isCountdownUrl(""), false);
  assert.equal(isCountdownUrl(null), false);
  assert.equal(isCountdownUrl(undefined), false);
});
