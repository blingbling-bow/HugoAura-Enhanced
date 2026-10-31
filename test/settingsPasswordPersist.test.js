// @ts-check

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

/**
 * "访问密码无法启用" 回归测试 (R1 / R2)
 *
 * 症状: 设置密码并二次确认后, 「启用访问密码」开关当次看起来是开的,
 *       重启后回弹为关 → 用户判定为 "无法启用"。
 *
 * 根因:
 * 1. (R2) settingsPasswordEnabled = true 发生在
 *    handleEnableConfigEncryption("update", …) 之后。
 *    encryptConfig 开启时, settingsPassword* 的赋值不会即时落盘
 *    (交给随后的加密流程补写), 于是这个 "启用标志" 成了一次没有
 *    后续写盘的动作 → 丢失。
 *    本测试用 spy 记录加密流程调用瞬间的 settingsPasswordEnabled,
 *    它必须已经是 true。
 * 2. (R1) preload.js 的 Proxy set 陷阱此前用配置标志 encryptConfig
 *    判定是否跳过即时落盘, 而真实落盘模式是 configManager.useEncConfig。
 *    二者失同步 (关闭访问密码后 useEncConfig=false 但 encryptConfig 仍 true)
 *    时, 明文模式下的赋值同样被丢弃。该修复在 preload.js, 运行于
 *    Electron preload 上下文, 无法在本测试中直接驱动, 故此处只锁定 R2
 *    与 "关闭后重新设置仍可启用" 的端到端行为。
 */

const { auraSettings } = require("../src/aura/ui/pages/configSubPages/preferences/settings/aura");
const { verifyPassword } = require("../src/aura/utils/passwordHash");

const REAL_DEFAULT_JSON = path.join(
  __dirname,
  "..",
  "src",
  "aura",
  "init",
  "shared",
  "default.json"
);

const readDefaultHash = () =>
  JSON.parse(fs.readFileSync(REAL_DEFAULT_JSON, "utf8")).auraSettings
    .settingsPasswordWithSalt;

const makeEl = () => {
  const classes = new Set();
  return {
    style: "",
    textContent: "",
    value: "",
    checked: false,
    onclick: null,
    classes,
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (n) => classes.has(n),
    },
  };
};

const els = {
  "aura-config-page-auth-dialog-area": makeEl(),
  "aura-config-page-header-area": makeEl(),
  "acp-auth-dialog-title": makeEl(),
  "acp-auth-confirm-btn": makeEl(),
  "acp-auth-cancel-btn": makeEl(),
  input: makeEl(),
  toggle: makeEl(),
  auraSettingsPasswd: makeEl(),
  descHint: makeEl(),
};

const savedGlobals = {};
/** 加密刷新流程的调用记录, 用于断言赋值时序 */
let encCalls = [];

const installStubs = () => {
  savedGlobals.document = global.document;
  savedGlobals.window = global.window;
  savedGlobals.config = global.__HUGO_AURA_CONFIG__;
  savedGlobals.uiFunctions = global.__HUGO_AURA_UI_FUNCTIONS__;
  savedGlobals.configMgr = global.__HUGO_AURA_CONFIG_MGR__;
  savedGlobals.ipcRenderer = global.ipcRenderer;

  els.toggle.checked = false;
  els.toggle.textContent = "";
  els.descHint.textContent = "";
  els.input.value = "";

  global.document = {
    getElementsByClassName: (cls) => (els[cls] ? [els[cls]] : []),
    getElementById: (id) => {
      if (id === "acp-auth-user-input") return els.input;
      if (id === "enableAuraSettingsPasswd") return els.toggle;
      if (id === "auraSettingsPasswd") return els.auraSettingsPasswd;
      return null;
    },
  };
  global.window = {
    __HUGO_AURA_GLOBAL__: { utils: { sleep: () => Promise.resolve() } },
  };
  global.__HUGO_AURA_CONFIG__ = {
    auraSettings: {
      settingsPasswordEnabled: false,
      settingsPasswordWithSalt: readDefaultHash(),
      encryptConfig: false,
    },
  };
  global.__HUGO_AURA_UI_FUNCTIONS__ = {
    config: {
      resetAuthDialogInputElOnSubmit: () => {},
      hideAndResetAuthDialog: async () => {},
      handleNavBack: () => {},
    },
  };

  encCalls = [];
  const record = (fn) => {
    encCalls.push({
      fn,
      enabled: global.__HUGO_AURA_CONFIG__.auraSettings.settingsPasswordEnabled,
    });
  };

  global.__HUGO_AURA_CONFIG_MGR__ = {
    getDefaultConfig: () =>
      JSON.parse(fs.readFileSync(REAL_DEFAULT_JSON, "utf8")),
    switchToDecConfig: async () => {
      record("switchToDecConfig");
      return { success: true };
    },
    encryptConfig: () => record("encryptConfig"),
    saveEncPassword: () => record("saveEncPassword"),
  };

  global.ipcRenderer = { invoke: async () => ({ success: true }) };
};

const restoreGlobals = () => {
  global.document = savedGlobals.document;
  global.window = savedGlobals.window;
  global.__HUGO_AURA_CONFIG__ = savedGlobals.config;
  global.__HUGO_AURA_UI_FUNCTIONS__ = savedGlobals.uiFunctions;
  global.__HUGO_AURA_CONFIG_MGR__ = savedGlobals.configMgr;
  global.ipcRenderer = savedGlobals.ipcRenderer;
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

const getEntry = (id) => {
  for (const category of auraSettings) {
    const entry = category.child.find((e) => e.id === id);
    if (entry) return entry;
  }
  return null;
};

/** 走完整链路: 设置密码 → 二次确认通过 (返回 callbackFn 的结果) */
const setPassword = async (passwd) => {
  const passwdEntry = getEntry("auraSettingsPasswd");
  const pending = passwdEntry.callbackFn(passwd);
  await flush();
  els.input.value = passwd;
  await els["acp-auth-confirm-btn"].onclick();
  await flush();
  const result = await pending;
  await flush();
  return result;
};

test("加密配置开启时: 启用标志必须在加密刷新之前落位 (R2)", async () => {
  installStubs();
  try {
    global.__HUGO_AURA_CONFIG__.auraSettings.encryptConfig = true;

    const result = await setPassword("CorrectPass123");
    assert.deepEqual(result, { valid: true });

    // 关键断言: 加密刷新被调用时, settingsPasswordEnabled 必须是 true。
    // 修复前该标志在加密流程之后才赋值 → 这里为 false, 标志永久丢失。
    const decCall = encCalls.find((c) => c.fn === "switchToDecConfig");
    assert.ok(decCall, "encryptConfig 开启时应触发切明文 → 重加密");
    assert.equal(
      decCall.enabled,
      true,
      "启用标志必须在加密刷新之前赋值, 否则不会被落盘"
    );
    assert.ok(
      encCalls.some((c) => c.fn === "encryptConfig"),
      "应完成重新加密"
    );

    const { auraSettings: cfg } = global.__HUGO_AURA_CONFIG__;
    assert.equal(cfg.settingsPasswordEnabled, true);
    assert.equal(
      verifyPassword("CorrectPass123", cfg.settingsPasswordWithSalt).valid,
      true
    );
    assert.equal(els.toggle.checked, true);
  } finally {
    restoreGlobals();
  }
});

test("加密配置关闭时: 走明文即时写路径, 启用标志与哈希一致", async () => {
  installStubs();
  try {
    const result = await setPassword("CorrectPass123");
    assert.deepEqual(result, { valid: true });

    assert.equal(
      encCalls.length,
      0,
      "encryptConfig 关闭时不应触发加密刷新流程"
    );

    const { auraSettings: cfg } = global.__HUGO_AURA_CONFIG__;
    assert.equal(cfg.settingsPasswordEnabled, true);
    assert.notEqual(cfg.settingsPasswordWithSalt, readDefaultHash());
    assert.equal(
      verifyPassword("CorrectPass123", cfg.settingsPasswordWithSalt).valid,
      true
    );
    assert.equal(els.toggle.checked, true);
  } finally {
    restoreGlobals();
  }
});

test("关闭访问密码后 (encryptConfig 仍为 true) 重新设置密码仍能启用", async () => {
  installStubs();
  try {
    global.__HUGO_AURA_CONFIG__.auraSettings.encryptConfig = true;

    // ① 先关闭开关: 只把 useEncConfig 切回明文, encryptConfig 保持 true
    const switchEntry = getEntry("enableAuraSettingsPasswd");
    await switchEntry.callbackFn(false, els.toggle, null, els.descHint);
    await flush();
    assert.equal(
      global.__HUGO_AURA_CONFIG__.auraSettings.settingsPasswordEnabled,
      false
    );
    assert.equal(
      global.__HUGO_AURA_CONFIG__.auraSettings.encryptConfig,
      true,
      "关闭访问密码不应复位 encryptConfig (R1 的失同步来源)"
    );

    // ② 重新设置密码 → 必须重新启用 (不能回弹)
    encCalls = [];
    const result = await setPassword("AnotherPass456");
    assert.deepEqual(result, { valid: true });

    const decCall = encCalls.find((c) => c.fn === "switchToDecConfig");
    assert.ok(decCall, "重新设置密码时应再次触发加密刷新");
    assert.equal(decCall.enabled, true, "重新设置密码时启用标志须先落位");

    const { auraSettings: cfg } = global.__HUGO_AURA_CONFIG__;
    assert.equal(cfg.settingsPasswordEnabled, true);
    assert.equal(
      verifyPassword("AnotherPass456", cfg.settingsPasswordWithSalt).valid,
      true
    );
    assert.equal(els.toggle.checked, true);
  } finally {
    restoreGlobals();
  }
});
