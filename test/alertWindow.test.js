// @ts-check

const test = require("node:test");
const assert = require("node:assert");

const alertWindow = require("../src/aura/mainProcess/hooks/alertWindow.js");

test("getAlertContent: 开机锁屏拦截 (本地路径) 措辞区分于远程指令", () => {
  const content = alertWindow.getAlertContent({
    action: "blocked",
    source: "local",
    ts: "2026-10-11T03:00:00.000Z",
    _logType: "lockScreen",
    bootGuard: true,
  });

  assert.strictEqual(content.title, "已阻止开机自动锁屏");
  assert.strictEqual(content.type, "blocked");
  assert.strictEqual(content.durationMs, 5000);
});

test("getAlertContent: 远程锁屏拦截 / 延迟放行 / 远程关机", () => {
  assert.strictEqual(
    alertWindow.getAlertContent({ action: "blocked", _logType: "lockScreen" })
      .title,
    "已阻止远程锁屏"
  );

  // notify 模式: 锁屏延迟 5 秒放行 (与 lockScreenInterceptor.NOTIFY_DELAY_MS 同源)
  const notify = alertWindow.getAlertContent({
    action: "captured",
    _logType: "lockScreen",
  });
  assert.strictEqual(notify.title, "即将在 5 秒后锁屏");
  assert.strictEqual(notify.type, "notify");
  assert.strictEqual(notify.durationMs, 5000);

  const powerOff = alertWindow.getAlertContent({
    action: "blocked",
    _logType: "powerOff",
  });
  assert.strictEqual(powerOff.title, "已阻止远程关机");
  assert.strictEqual(powerOff.type, "blocked");
  assert.strictEqual(powerOff.durationMs, 10000);
});
