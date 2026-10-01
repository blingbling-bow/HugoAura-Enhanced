// @ts-check

/**
 * powerOffInterceptor 端到端集成测试 (不需要安装希沃管家)。
 *
 * 用一张假的 webpack 模块表驱动真实的拦截器, 逐环验证:
 *   1. 定位 + 包装关机处理器 (模块 128 快路径)
 *   2. /powerOff/confirm 被吞掉 —— 原始 onMessage 不再执行 (等于自动取消远程关机)
 *   3. 审计写入 cloudCommandAudit.log
 *   4. 推送到渲染层 (审计页 + 拦截提醒)
 *   5. 兜底弹窗 (注入窗口不可见时)
 *   6. 其它云端指令原样透传
 *   7. 配置关闭时不拦, 但仍正常安装
 *   8. 模块号漂移时按 "/powerOff/confirm" 特征扫描恢复, 并仍然拦住
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const auditWriter = require("../src/aura/mainProcess/hooks/auditWriter");
const alertWindow = require("../src/aura/mainProcess/hooks/alertWindow");
const powerOff = require("../src/aura/mainProcess/hooks/powerOffInterceptor");

const POWER_OFF_URL = "/powerOff/confirm";
const AUDIT_FILE = "cloudCommandAudit.log";

/**
 * 假的关机指令处理器: onMessage 必须在**原型**上 (拦截器用
 * getPrototypeMethod 取未绑定版本做源码自检), 且源码里要出现"自动关机"文案。
 */
class FakePowerOffHandler {
  constructor() {
    this.calls = [];
    this.message = {};
    this.dialogStarted = false;
  }

  onMessage(e) {
    const countdownText = "设备将于10秒后自动关机。";
    this.calls.push(e);
    if (e && e.url === POWER_OFF_URL) {
      this.dialogStarted = true; // 真实实现会在这里弹倒计时对话框
    }
    return countdownText;
  }

  pushMessageToWindow() {}
  getMessage() {
    return this.message;
  }
}

/** 采集副作用 */
const makeSpies = () => {
  const sent = [];
  const audits = [];
  const alerts = [];

  const electron = {
    ipcMain: {
      send: (windowKey, channel, payload) => {
        sent.push({ windowKey, channel, payload });
      },
    },
    BrowserWindow: function FakeBrowserWindow() {},
    screen: {
      getPrimaryDisplay: () => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
    },
  };

  const origWriteAudit = auditWriter.writeAudit;
  const origShowAlert = alertWindow.showAlertWindow;
  auditWriter.writeAudit = (file, record) => audits.push({ file, record });
  alertWindow.showAlertWindow = (el, record) => {
    alerts.push(record);
    return true;
  };

  const restore = () => {
    auditWriter.writeAudit = origWriteAudit;
    alertWindow.showAlertWindow = origShowAlert;
  };

  return { sent, audits, alerts, electron, restore };
};

/** 快路径: 模块 128 就是关机处理器 */
const makeFastPathCentral = (handler, electron) => {
  const modules = {
    0: { proxyWebsocketHost: { ip: "wss://127.0.0.1", url: "/SeewoProxy" } },
    1: electron,
    128: handler,
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
  central.m = {}; // 模块表存在但为空 —— 与真机一致: central.m[id] 是工厂而非导出
  central.c = {};
  return central;
};

/** 漂移场景: 模块 128 不存在, 真正的处理器挂在 137, 靠工厂源码特征扫描 */
const makeScanCentral = (handler, electron) => {
  const factory = function (e, t, n) {
    // 特征串必须以**字面量**形式出现在工厂源码里 (resolveByScan 只做源码包含判断,
    // 引用外层变量是匹配不到的)
    const powerOffUrl = "/powerOff/confirm";
    e.exports = handler;
    return powerOffUrl;
  };
  const modules = {
    0: { proxyWebsocketHost: { ip: "wss://127.0.0.1", url: "/SeewoProxy" } },
    1: electron,
    137: factory,
  };
  const central = (id) => {
    if (!(id in modules)) {
      const err = new Error(`Cannot find module '${id}'`);
      // @ts-ignore
      err.code = "MODULE_NOT_FOUND";
      throw err;
    }
    const mod = modules[id];
    if (typeof mod !== "function") return mod;
    const moduleObj = { i: id, l: false, exports: {} };
    mod(moduleObj, moduleObj.exports, central);
    return moduleObj.exports;
  };
  central.m = { 137: factory };
  central.c = {};
  return central;
};

const setConfig = (enabled) => {
  // @ts-ignore 拦截器通过 global.__HUGO_AURA_CONFIG_MGR__.loadConfig() 读配置
  global.__HUGO_AURA_CONFIG_MGR__ = {
    loadConfig: () => ({ auraSettings: { powerOffIntercept: { enabled } } }),
  };
};

test("启用时: 吞掉 /powerOff/confirm, 并走完审计 / 推送 / 兜底弹窗", () => {
  const spies = makeSpies();
  const handler = new FakePowerOffHandler();
  setConfig(true);

  try {
    powerOff.hookFunc(makeFastPathCentral(handler, spies.electron));

    // 已包装: 实例属性被替换, 原始方法仍可从原型取到
    assert.notEqual(
      handler.onMessage,
      FakePowerOffHandler.prototype.onMessage,
      "onMessage 应已被包装"
    );

    handler.onMessage({ url: POWER_OFF_URL, data: { from: "cloud" } });

    // 关键: 原始处理器一次都没被调用 -> 不会弹倒计时, 也不会回执云端
    assert.deepEqual(handler.calls, [], "被拦时原始 onMessage 不应执行");
    assert.equal(handler.dialogStarted, false, "不应启动关机倒计时");

    // 审计
    assert.equal(spies.audits.length, 1);
    assert.equal(spies.audits[0].file, AUDIT_FILE);
    assert.equal(spies.audits[0].record.action, "blocked");
    assert.equal(spies.audits[0].record._logType, "powerOff");
    assert.equal(spies.audits[0].record.url, POWER_OFF_URL);
    assert.equal(spies.audits[0].record.source, "wss://127.0.0.1/SeewoProxy");

    // 推送到渲染层: 审计页 + 拦截提醒
    const channels = spies.sent.map((s) => s.channel);
    assert.ok(channels.includes("$aura.audit.onLog"), "应推送审计事件");
    assert.ok(
      channels.includes("$aura.powerOff.onBlocked"),
      "应推送拦截提醒"
    );

    // 兜底独立小窗
    assert.equal(spies.alerts.length, 1);
    assert.equal(spies.alerts[0]._logType, "powerOff");
  } finally {
    spies.restore();
  }
});

test("其它云端指令原样透传", () => {
  const spies = makeSpies();
  const handler = new FakePowerOffHandler();
  setConfig(true);

  try {
    powerOff.hookFunc(makeFastPathCentral(handler, spies.electron));

    handler.onMessage({ url: "/batchBind/success", data: {} });
    handler.onMessage({ url: "/password/authMode", data: { mode: 0 } });

    assert.equal(handler.calls.length, 2, "非关机指令必须透传给原始处理器");
    assert.equal(spies.audits.length, 0);
    assert.equal(spies.alerts.length, 0);
  } finally {
    spies.restore();
  }
});

test("配置关闭时: 不拦但照常透传 (钩子仍然安装)", () => {
  const spies = makeSpies();
  const handler = new FakePowerOffHandler();
  setConfig(false);

  try {
    powerOff.hookFunc(makeFastPathCentral(handler, spies.electron));

    handler.onMessage({ url: POWER_OFF_URL, data: {} });

    assert.equal(handler.calls.length, 1, "关闭时应透传");
    assert.equal(handler.dialogStarted, true, "关闭时原逻辑应照常执行");
    assert.equal(spies.audits.length, 0);
    assert.equal(spies.alerts.length, 0);
  } finally {
    spies.restore();
  }
});

test("模块号漂移时: 按 /powerOff/confirm 特征扫描恢复, 并仍然拦住", () => {
  const spies = makeSpies();
  const handler = new FakePowerOffHandler();
  setConfig(true);

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    // 模块 128 不存在 -> 走 resolveByScan 兜底 (特征串全包唯一)
    powerOff.hookFunc(makeScanCentral(handler, spies.electron));

    assert.notEqual(
      handler.onMessage,
      FakePowerOffHandler.prototype.onMessage,
      "兜底后仍应完成包装"
    );

    handler.onMessage({ url: POWER_OFF_URL, data: {} });
    assert.deepEqual(handler.calls, [], "兜底路径同样必须拦住");
    assert.equal(spies.audits.length, 1);

    const recovered = warnings.find((w) => w.includes("recovered via"));
    assert.ok(recovered, `应记录兜底日志, 实际: ${warnings.join(" | ")}`);
    assert.match(recovered, /module-table/);
  } finally {
    console.warn = origWarn;
    spies.restore();
  }
});
