// @ts-check
"use strict";

/**
 * 指令表覆盖度回归测试。
 *
 * 下面这组键来自真机审计日志 (2026-10-04, 295 条记录, 管家 1.6.7.4010)。
 * 当时它们全部显示为「未识别」, 现已补进 KNOWN_COMMANDS。
 * 这条用例的作用是防止后续改动把已补齐的条目又删掉 —— 一旦删了, 真机上
 * 这些指令会重新变成「未识别」, 而单测是唯一能在装机前发现的地方。
 */

const test = require("node:test");
const assert = require("node:assert");

const ui = require("../src/aura/ui/pages/configSubPages/preferences/settings/auditLog.js");

/** 真机日志里出现过的全部指令键 (WS 下行 + 出站 HTTP) */
const OBSERVED_KEYS = [
  // WebSocket 下行
  "/cancelResidentNotice",
  "/serviceUpgrade/status",
  "/password/authMode",
  "/qrCode/remoteAuth",
  "/message/user/login/info",
  "/newsBroadcast/auth",
  "/edgeServer/ip",
  "/propaganda/uips/property",
  "/record",
  "/switch",
  "/superState",
  "/lightAudio/device",
  "/qrCode/notify",
  "messageType:/propaganda/auth",
  "messageType:1001",
  "messageType:1003",
  "messageType:1004",
  "messageType:1211",
  "messageType:1213",
  "messageType:1214",
  "messageType:1215",
  "messageType:1315",
  "messageType:1317",
  "messageType:1318",
  // 出站 HTTP (真实 path 带代理前缀)
  "/forward/SeewoHugoHttp/api/v1/cancelResidentNotice/feedback",
  "/forward/SeewoHugoHttp/api/v1/screenSaver/reset",
  "/forward/SeewoHugoHttp/api/v1/screenlock/unlockfeedback",
  "/api/v1/device/id",
  // bundle 字面量扫荡补充 (2026-10-07, 防止已补条目被误删)
  "/tipConfirm",
  "/batchbind/receivedResult",
  "/batchBind/success",
  "/disk/clean/status",
  "/systemDisk/clean/status",
  "/userProfile/moving/status",
  "/edgeServer/search",
  "/eye_protection/timer/created",
  "/eye_protection/timer/aborted",
  "/eye_protection/timer/paused",
  "/eye_protection/timer/resumed",
  "/message/nfc/authResult",
  "/newsBroadcast/play",
  "/newsBroadcast/cancel",
  "/propaganda/task",
  "/propaganda/cancel",
  "/propaganda/uips/playProgram",
  "/propaganda/uips/cancelProgram",
  "/propaganda/uips/stopPrograms",
  "/propaganda/uips/service",
  "/qrCode/auth",
  "/serviceUpgrade/feedback",
  "/shouting/notice",
  "/sp20e/pairingError",
];

const isKnown = (key) => {
  if (Object.prototype.hasOwnProperty.call(ui.KNOWN_COMMANDS, key)) return true;
  const normalized = ui.normalizeHttpPath(key);
  return Object.prototype.hasOwnProperty.call(ui.KNOWN_COMMANDS, normalized);
};

test("KNOWN_COMMANDS: 真机日志里出现过的指令全部已收录", () => {
  const missing = OBSERVED_KEYS.filter((key) => !isKnown(key));
  assert.deepStrictEqual(
    missing,
    [],
    "以下真机指令重新变成「未识别」: " + missing.join(", ")
  );
});

test("KNOWN_COMMANDS: 每条都有非空中文标注", () => {
  for (const [key, label] of Object.entries(ui.KNOWN_COMMANDS)) {
    assert.strictEqual(
      typeof label,
      "string",
      `指令 ${key} 的标注不是字符串`
    );
    assert.ok(label.trim().length > 0, `指令 ${key} 的标注为空`);
  }
});

test("normalizeHttpPath: 剥掉 /forward/SeewoHugoHttp 代理前缀", () => {
  assert.strictEqual(
    ui.normalizeHttpPath("/forward/SeewoHugoHttp/api/v1/device/id"),
    "/api/v1/device/id"
  );
  assert.strictEqual(ui.normalizeHttpPath("/api/v1/device/id"), "/api/v1/device/id");
  assert.strictEqual(ui.normalizeHttpPath(""), "");
  assert.strictEqual(ui.normalizeHttpPath(null), "");
  // 前缀本身 -> 回落为 "/"
  assert.strictEqual(ui.normalizeHttpPath("/forward/SeewoHugoHttp"), "/");
});

test("shortChannelOf: 旧日志里的 URL 形态通道名还原成最后一段", () => {
  assert.strictEqual(
    ui.shortChannelOf(
      "wss://127.0.0.1:51270/forward/SeewoHugoHttp/SeewoWindowBlock"
    ),
    "SeewoWindowBlock"
  );
  assert.strictEqual(
    ui.shortChannelOf("wss://127.0.0.1/SeewoProxy"),
    "SeewoProxy"
  );
  // 新版本日志本身就是通道名, 原样保留
  assert.strictEqual(ui.shortChannelOf("ADBlockWebSocket"), "ADBlockWebSocket");
  assert.strictEqual(ui.shortChannelOf("cloud"), "cloud");
  assert.strictEqual(ui.shortChannelOf(""), "");
  assert.strictEqual(ui.shortChannelOf(null), null);
});

test("formatDuration: 无数据显示占位符, 毫秒/秒自适应", () => {
  const { formatDuration } = ui;
  assert.strictEqual(formatDuration(null), "—");
  assert.strictEqual(formatDuration(undefined), "—");
  assert.strictEqual(formatDuration(Number.NaN), "—");
  assert.strictEqual(formatDuration(0), "0.00 ms");
  assert.strictEqual(formatDuration(0.4), "0.40 ms");
  assert.strictEqual(formatDuration(12.34), "12 ms");
  assert.strictEqual(formatDuration(142), "142 ms");
  assert.strictEqual(formatDuration(1500), "1.50 s");
});

test("buildStats: 8 张卡且口径与动作语义一致", () => {
  const all = [
    { action: "blocked", _logType: "cloud" },
    { action: "logged", _logType: "http", url: "/x", key: "/x" },
    { action: "peek_start", _logType: "peek" },
    { action: "peek_stop", _logType: "peek" },
    { action: "unlock", _logType: "unlock" },
    { url: "/mystery-thing", key: "/mystery-thing", _logType: "cloud" },
  ];
  const stats = ui.buildStats(all, all);
  assert.strictEqual(stats.length, 8, "统计卡应为 8 张 (一行放下)");

  const byLabel = Object.fromEntries(stats.map((s) => [s.label, s.value]));
  assert.strictEqual(byLabel["全部记录"], 6);
  assert.strictEqual(byLabel["已拦截"], 1);
  assert.strictEqual(byLabel["未识别指令"], 1);
  assert.strictEqual(byLabel["出站响应"], 1);
  assert.strictEqual(byLabel["窥屏事件"], 1);
  assert.strictEqual(byLabel["解锁记录"], 1);
});

test("搜索过滤: 关键字/动作/通道/仅未识别 均可命中", () => {
  const entries = [
    { url: "/record", key: "/record", channel: "ADBlockWebSocket", action: "logged", _logType: "cloud" },
    { url: "/serviceUpgrade/status", key: "/serviceUpgrade/status", channel: "proxyWebsocketHost", action: "blocked", _logType: "cloud" },
    { messageType: 1211, key: "messageType:1211", channel: "proxyWebsocketHost", action: "blocked", _logType: "cloud" },
    { action: "peek_start", channel: "screenPeek", _logType: "peek" },
    { action: "unlock", channel: "screenLockController", _logType: "unlock" },
  ];
  const m = (entry, f) => ui.entryMatchesFilters(entry, f);

  // 关键字 (大小写不敏感, 命中 url / key / channel / messageType)
  assert.strictEqual(
    entries.filter((e) => m(e, { text: "record", channel: "all", type: "all" })).length,
    1
  );
  assert.strictEqual(
    entries.filter((e) => m(e, { text: "SERVICEUPGRADE", channel: "all", type: "all" })).length,
    1
  );
  assert.strictEqual(
    entries.filter((e) => m(e, { text: "adblockwebsocket", channel: "all", type: "all" })).length,
    1
  );
  assert.strictEqual(
    entries.filter((e) => m(e, { text: "1211", channel: "all", type: "all" })).length,
    1
  );

  // 动作
  assert.strictEqual(
    entries.filter((e) => m(e, { channel: "all", type: "blocked" })).length,
    2
  );

  // 通道
  assert.strictEqual(
    entries.filter((e) => m(e, { channel: "proxyWebsocketHost", type: "all" })).length,
    2
  );

  // 组合: 通道 + 动作
  assert.strictEqual(
    entries.filter((e) => m(e, { channel: "proxyWebsocketHost", type: "blocked" })).length,
    2
  );
  assert.strictEqual(
    entries.filter((e) => m(e, { channel: "hugoServiceWebsocket", type: "blocked" })).length,
    0
  );
});

test("搜索过滤: 无关键字且类型为 all 时全部通过", () => {
  const e = { url: "/x", key: "/x", channel: "c", action: "logged", _logType: "cloud" };
  assert.strictEqual(ui.entryMatchesFilters(e, { channel: "all", type: "all" }), true);
});
