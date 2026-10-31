// @ts-check

const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * Issue #12 回归测试: 设置"访问密码"的完整链路
 *
 * 修复前有两个问题:
 * 1. settingsRenderer 的密码输入框在 <form> 中回车触发隐式表单提交,
 *    页面随表单导航重载 → "输入密码回车后 electron 崩溃 / 二次确认框打不开";
 * 2. PBKDF2 重构后二次确认成功也不把新哈希写入 settingsPasswordWithSalt,
 *    密码永远设置不上。
 *
 * 本测试用 DOM 桩走真实的 callbackFn → 二次确认 → 哈希落盘链路,
 * 锁定第 2 点; 第 1 点属于浏览器隐式提交行为, 由 settingsRenderer
 * 的 Enter preventDefault + form submit preventDefault 修复。
 */

const { auraSettings } = require("../src/aura/ui/pages/configSubPages/preferences/settings/aura");
const { verifyPassword } = require("../src/aura/utils/passwordHash");

/** 构造一个最小可用的元素桩 */
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
  // 设置页的密码输入框 (取消路径会清空它)
  "auraSettingsPasswd": makeEl(),
};

const savedGlobals = {};

const installStubs = () => {
  savedGlobals.document = global.document;
  savedGlobals.window = global.window;
  savedGlobals.config = global.__HUGO_AURA_CONFIG__;
  savedGlobals.uiFunctions = global.__HUGO_AURA_UI_FUNCTIONS__;

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
};

const restoreGlobals = () => {
  global.document = savedGlobals.document;
  global.window = savedGlobals.window;
  global.__HUGO_AURA_CONFIG__ = savedGlobals.config;
  global.__HUGO_AURA_UI_FUNCTIONS__ = savedGlobals.uiFunctions;
};

const getPasswdEntry = () =>
  auraSettings[0].child.find((entry) => entry.id === "auraSettingsPasswd");

test("访问密码: 校验分支 (空值 / 过短 / 单一字符类型)", async () => {
  installStubs();
  try {
    const entry = getPasswdEntry();
    assert.deepEqual(await entry.callbackFn(""), { valid: true });
    assert.deepEqual(await entry.callbackFn("abc123"), {
      valid: false,
      hint: "请输入至少 8 位密码",
    });
    assert.deepEqual(await entry.callbackFn("abcdefgh"), {
      valid: false,
      hint: "请包含数字 / 字母 / 特殊字符中的至少 2 种",
    });
    // 校验失败不应弹出二次确认框
    assert.equal(els[AUTH_CONFIRM_BTN].onclick, null);
  } finally {
    restoreGlobals();
  }
});

test("访问密码: 二次确认输入错误 → 提示重试, 哈希不落盘", async () => {
  installStubs();
  try {
    const entry = getPasswdEntry();
    const pending = entry.callbackFn("CorrectPass123");

    // 等待弹窗装配完成 (微任务链 + 立即 resolve 的 sleep)
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(els[AUTH_TITLE].textContent, "请再次输入密码");
    assert.equal(typeof els[AUTH_CONFIRM_BTN].onclick, "function");

    // 空输入
    els.input.value = "";
    await els[AUTH_CONFIRM_BTN].onclick();
    assert.equal(els[AUTH_TITLE].textContent, "密码不能为空");

    // 错误的二次输入
    els.input.value = "WrongPass456";
    await els[AUTH_CONFIRM_BTN].onclick();
    assert.equal(els[AUTH_TITLE].textContent, "请再试一次");
    assert.equal(
      global.__HUGO_AURA_CONFIG__.auraSettings.settingsPasswordWithSalt,
      "LEGACYOLDHASH",
      "二次确认未通过前, 已存哈希不应被覆盖"
    );

    // 取消退出: 配置保持不变
    els[AUTH_CANCEL_BTN].onclick();
    const result = await pending;
    assert.deepEqual(result, { valid: false, hint: "未能验证密码, 请重试" });
    assert.equal(
      global.__HUGO_AURA_CONFIG__.auraSettings.settingsPasswordWithSalt,
      "LEGACYOLDHASH"
    );
    assert.equal(
      global.__HUGO_AURA_CONFIG__.auraSettings.settingsPasswordEnabled,
      false
    );
  } finally {
    restoreGlobals();
  }
});

test("访问密码: 二次确认弹窗元素缺失时, 密码仍应落盘并自动启用 (不能静默失败)", async () => {
  installStubs();
  try {
    // 模拟弹窗 DOM 缺失 (宿主页面结构变化 / 元素被移除)
    global.document.getElementsByClassName = () => [];

    const entry = getPasswdEntry();
    const result = await entry.callbackFn("CorrectPass123");

    assert.deepEqual(result, { valid: true });
    const stored =
      global.__HUGO_AURA_CONFIG__.auraSettings.settingsPasswordWithSalt;
    assert.notEqual(
      stored,
      "LEGACYOLDHASH",
      "弹窗不可用时也必须写入新哈希, 否则开关永远打不开"
    );
    assert.equal(verifyPassword("CorrectPass123", stored).valid, true);
    assert.equal(
      global.__HUGO_AURA_CONFIG__.auraSettings.settingsPasswordEnabled,
      true
    );
  } finally {
    restoreGlobals();
  }
});

test("访问密码: 二次确认通过 → 新哈希落盘并自动启用 (Issue #12)", async () => {
  installStubs();
  try {
    const entry = getPasswdEntry();
    const pending = entry.callbackFn("CorrectPass123");
    await new Promise((resolve) => setImmediate(resolve));

    els.input.value = "CorrectPass123";
    await els[AUTH_CONFIRM_BTN].onclick();
    const result = await pending;

    assert.deepEqual(result, { valid: true });

    const stored =
      global.__HUGO_AURA_CONFIG__.auraSettings.settingsPasswordWithSalt;
    assert.notEqual(
      stored,
      "LEGACYOLDHASH",
      "二次确认通过后新哈希必须写入配置 (Issue #12 回归点)"
    );
    assert.equal(
      verifyPassword("CorrectPass123", stored).valid,
      true,
      "落盘哈希应与本次输入的密码匹配"
    );
    assert.equal(
      global.__HUGO_AURA_CONFIG__.auraSettings.settingsPasswordEnabled,
      true,
      "密码确认成功后应自动启用访问密码"
    );
    assert.equal(els.toggle.checked, true);
  } finally {
    restoreGlobals();
  }
});
