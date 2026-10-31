// @ts-check

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

/**
 * Issue #12 后续: "设了密码后, 启用访问密码开关仍然打不开" 复现测试。
 * 走真实链路: 访问密码 callbackFn → 二次确认 → 哈希落盘 →
 * enableAuraSettingsPasswd callbackFn(true) → 应成功启用。
 * defaultHash 读取真实的 default.json (与渲染层一致)。
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

const AUTH_DIALOG_AREA = "aura-config-page-auth-dialog-area";
const AUTH_APP_BAR = "aura-config-page-header-area";
const AUTH_TITLE = "acp-auth-dialog-title";
const AUTH_CONFIRM_BTN = "acp-auth-confirm-btn";
const AUTH_CANCEL_BTN = "acp-auth-cancel-btn";

const els = {
  [AUTH_DIALOG_AREA]: makeEl(),
  [AUTH_APP_BAR]: makeEl(),
  [AUTH_TITLE]: makeEl(),
  [AUTH_CONFIRM_BTN]: makeEl(),
  [AUTH_CANCEL_BTN]: makeEl(),
  input: makeEl(),
  toggle: makeEl(),
  "auraSettingsPasswd": makeEl(),
  descHint: makeEl(),
};

const savedGlobals = {};

const installStubs = () => {
  savedGlobals.document = global.document;
  savedGlobals.window = global.window;
  savedGlobals.config = global.__HUGO_AURA_CONFIG__;
  savedGlobals.uiFunctions = global.__HUGO_AURA_UI_FUNCTIONS__;
  savedGlobals.configMgr = global.__HUGO_AURA_CONFIG_MGR__;

  global.document = {
    getElementsByClassName: (cls) => (els[cls] ? [els[cls]] : []),
    getElementById: (id) => {
      if (id === "acp-auth-user-input") return els.input;
      if (id === "enableAuraSettingsPasswd") return els.toggle;
      if (id === "auraSettingsPasswd") return els["auraSettingsPasswd"];
      return null;
    },
  };
  global.window = {
    __HUGO_AURA_GLOBAL__: { utils: { sleep: () => Promise.resolve() } },
  };
  global.__HUGO_AURA_CONFIG__ = {
    auraSettings: {
      settingsPasswordEnabled: false,
      settingsPasswordWithSalt: "LEGACYOLDHASH",
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
  // 与渲染层一致: 直接读取真实 default.json
  global.__HUGO_AURA_CONFIG_MGR__ = {
    getDefaultConfig: () => JSON.parse(fs.readFileSync(REAL_DEFAULT_JSON, "utf8")),
  };
};

const restoreGlobals = () => {
  global.document = savedGlobals.document;
  global.window = savedGlobals.window;
  global.__HUGO_AURA_CONFIG__ = savedGlobals.config;
  global.__HUGO_AURA_UI_FUNCTIONS__ = savedGlobals.uiFunctions;
  global.__HUGO_AURA_CONFIG_MGR__ = savedGlobals.configMgr;
};

const getEntry = (id) => {
  for (const category of auraSettings) {
    const entry = category.child.find((e) => e.id === id);
    if (entry) return entry;
  }
  return null;
};

test("设密码成功后, 启用访问密码开关应能打开 (默认哈希读取真实 default.json)", async () => {
  installStubs();
  try {
    // ① 通过真实 callbackFn 设置密码并完成二次确认
    const passwdEntry = getEntry("auraSettingsPasswd");
    const pending = passwdEntry.callbackFn("CorrectPass123");
    await new Promise((resolve) => setImmediate(resolve));
    els.input.value = "CorrectPass123";
    await els[AUTH_CONFIRM_BTN].onclick();
    assert.deepEqual(await pending, { valid: true });

    const stored = global.__HUGO_AURA_CONFIG__.auraSettings.settingsPasswordWithSalt;
    assert.equal(verifyPassword("CorrectPass123", stored).valid, true);

    // ② 手动关闭开关 (模拟用户先关再开的操作), 再重新打开
    global.__HUGO_AURA_CONFIG__.auraSettings.settingsPasswordEnabled = false;

    const switchEntry = getEntry("enableAuraSettingsPasswd");
    await switchEntry.callbackFn(true, els.toggle, null, els.descHint);

    assert.equal(
      global.__HUGO_AURA_CONFIG__.auraSettings.settingsPasswordEnabled,
      true,
      "密码已设置 (哈希 != 默认值) 时开关应能成功启用"
    );
    assert.equal(
      els.descHint.textContent,
      "",
      "不应出现 '请先设置密码' 的拒绝提示"
    );
  } finally {
    restoreGlobals();
  }
});

test("未设置密码 (哈希为默认值) 时, 开关应拒绝并给出提示", async () => {
  installStubs();
  try {
    // 模拟存量用户: 存的仍是 default.json 里的旧默认哈希
    const defaultHash = JSON.parse(fs.readFileSync(REAL_DEFAULT_JSON, "utf8"))
      .auraSettings.settingsPasswordWithSalt;
    global.__HUGO_AURA_CONFIG__.auraSettings.settingsPasswordWithSalt = defaultHash;

    const switchEntry = getEntry("enableAuraSettingsPasswd");
    await switchEntry.callbackFn(true, els.toggle, null, els.descHint);

    assert.equal(
      global.__HUGO_AURA_CONFIG__.auraSettings.settingsPasswordEnabled,
      false,
      "默认哈希下开关必须拒绝启用"
    );
    assert.equal(els.toggle.checked, false);
    assert.equal(els.descHint.textContent, '请先在下方 "访问密码" 中设置密码, 再启用此项');
  } finally {
    restoreGlobals();
  }
});

test("默认配置读取失败时, 开关不应抛错静默失效", async () => {
  installStubs();
  try {
    // 模拟 getDefaultConfig 读不到 default.json 的环境
    global.__HUGO_AURA_CONFIG_MGR__ = { getDefaultConfig: () => ({ rewrite: {} }) };

    const switchEntry = getEntry("enableAuraSettingsPasswd");

    // 场景 A: 尚未设置过密码 (存储值为 undefined) → 仍应拒绝
    delete global.__HUGO_AURA_CONFIG__.auraSettings.settingsPasswordWithSalt;
    await assert.doesNotReject(
      switchEntry.callbackFn(true, els.toggle, null, els.descHint)
    );
    assert.equal(
      global.__HUGO_AURA_CONFIG__.auraSettings.settingsPasswordEnabled,
      false
    );

    // 场景 B: 已设置过密码 (真实哈希) → 应正常启用, 不因默认值缺失而拒绝
    global.__HUGO_AURA_CONFIG__.auraSettings.settingsPasswordWithSalt =
      "pbkdf2:v1:210000:abc:def";
    await switchEntry.callbackFn(true, els.toggle, null, els.descHint);
    assert.equal(
      global.__HUGO_AURA_CONFIG__.auraSettings.settingsPasswordEnabled,
      true
    );
  } finally {
    restoreGlobals();
  }
});
