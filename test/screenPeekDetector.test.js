// @ts-check

/**
 * screenPeekDetector 进程级检测测试 (不需要安装希沃管家, 也不需要真的窥屏)。
 *
 * 背景 (真机事实): 管家全包搜不到 screenCapture 字样 —— 窥屏由管家之外的独立
 * 进程完成, 管家进程内没有任何信号。因此检测改为"周期比对系统进程列表",
 * 本测试用假的 tasklist 输出驱动它。
 *
 * 注意: 钩子在模块加载时就解构了 child_process.execFile, 所以必须在 require
 * 之前替换它 —— 因此下面的替换写在 require 之前。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const childProcess = require("child_process");
const execFileCalls = [];
let nextTasklistOutput = "";
childProcess.execFile = (file, args, options, cb) => {
  execFileCalls.push({ file, args });
  cb(null, nextTasklistOutput);
};

const screenPeek = require("../src/aura/mainProcess/hooks/screenPeekDetector");
const { parseTasklistCsv, findPeekProcess } = screenPeek;

const TASKLIST_WITH_PEEK =
  '"chrome.exe","1000","Console","1","100,000 K"\r\n' +
  '"screenCapture.exe","4321","Console","1","20,000 K"\r\n';
const TASKLIST_WITHOUT_PEEK = '"chrome.exe","1000","Console","1","100,000 K"\r\n';
const TASKLIST_INFO_ONLY = "INFO: No tasks are running which match the specified criteria.\r\n";

const peekRecords = (sent) =>
  sent
    .filter((s) => s.channel === "$aura.audit.onLog")
    .map((s) => s.payload.record)
    .filter((r) => r._logType === "peek");

const peekNotifications = (sent) =>
  sent.filter((s) => s.channel === "$aura.screenPeek.onPeekDetected");

/** 假 WS 客户端: 必须让 installWsInterceptor 的自检通过 (原型方法源码含 JSON.parse) */
class FakeWsClient {
  constructor() {
    this.messages = [];
  }
  onMessage(raw) {
    this.messages.push(JSON.parse(raw));
  }
  setHost(host) {
    this.host = host;
  }
  sendMessage() {}
}

const makeHarness = ({ enabled = true, processNames } = {}) => {
  const sent = [];
  const electron = {
    ipcMain: {
      send: (windowKey, channel, payload) =>
        sent.push({ windowKey, channel, payload }),
    },
  };

  const ws399 = new FakeWsClient();
  const ws390 = new FakeWsClient();

  const modules = {
    0: {
      hugoServiceWebsocket: { ip: "wss://127.0.0.1", url: "/hugo" },
      proxyWebsocketHost: { ip: "wss://127.0.0.1", url: "/SeewoProxy" },
    },
    1: electron,
    390: ws390,
    399: ws399,
  };
  const central = (id) => {
    if (!(id in modules)) {
      const err = new Error(`Cannot find module '${id}'`);
      // @ts-ignore
      err.code = "MODULE_NOT_FOUND";
      throw err;
    }
    return modules[id];
  };
  central.m = {};
  central.c = {};

  // @ts-ignore 钩子通过 global.__HUGO_AURA_CONFIG_MGR__.loadConfig() 读配置
  global.__HUGO_AURA_CONFIG_MGR__ = {
    loadConfig: () => ({
      auraSettings: {
        screenPeekDetector: {
          enabled,
          logPeekEvents: true,
          ...(processNames ? { processNames } : {}),
        },
      },
    }),
  };

  // 捕获 setInterval 的回调, 由测试手动驱动轮询 (不真的等 2 秒)
  const originalSetInterval = global.setInterval;
  let pollFn = null;
  // @ts-ignore
  global.setInterval = (fn) => {
    pollFn = fn;
    return { unref() {} };
  };

  try {
    screenPeek.hookFunc(central);
  } finally {
    global.setInterval = originalSetInterval;
  }

  return { sent, ws399, ws390, poll: () => pollFn && pollFn() };
};

test("parseTasklistCsv: 解析进程名与 PID, 跳过 INFO 与空行", () => {
  const parsed = parseTasklistCsv(TASKLIST_WITH_PEEK + TASKLIST_INFO_ONLY + "\r\n");
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[1], { name: "screenCapture.exe", pid: 4321 });
});

test("findPeekProcess: 进程名大小写不敏感, 无匹配返回 null", () => {
  const processes = parseTasklistCsv(TASKLIST_WITH_PEEK);
  assert.equal(findPeekProcess(processes, ["screencapture.exe"]).pid, 4321);
  assert.equal(findPeekProcess(processes, ["ScreenCapture.EXE"]).name, "screenCapture.exe");
  assert.equal(findPeekProcess(processes, ["other.exe"]), null);
  assert.equal(findPeekProcess(processes, []), null);
});

test("窥屏进程出现: 写审计 + 弹提醒, 且同状态不重复记录", () => {
  nextTasklistOutput = TASKLIST_WITH_PEEK;
  execFileCalls.length = 0;
  const h = makeHarness();

  // 首次轮询 (安装时立即执行一次)
  assert.equal(execFileCalls.length, 1, "应执行一次 tasklist");
  assert.equal(execFileCalls[0].file, "tasklist");

  const records = peekRecords(h.sent);
  assert.equal(records.length, 1);
  assert.equal(records[0].action, "peek_start");
  assert.equal(records[0].channel, "process-watch");
  assert.equal(records[0]._logType, "peek");
  assert.equal(records[0].data.pid, 4321);
  assert.match(records[0].source, /screenCapture\.exe/);

  const notes = peekNotifications(h.sent);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].payload.state, true);

  // 进程仍在 → 状态未翻转, 不应重复记录
  h.poll();
  assert.equal(peekRecords(h.sent).length, 1, "同状态重复轮询不应重复写审计");
});

test("窥屏进程退出: 记录 peek_stop 并通知关闭提醒", () => {
  nextTasklistOutput = TASKLIST_WITH_PEEK;
  const h = makeHarness();

  nextTasklistOutput = TASKLIST_WITHOUT_PEEK;
  h.poll();

  const records = peekRecords(h.sent);
  assert.equal(records.length, 2);
  assert.equal(records[1].action, "peek_stop");
  assert.equal(records[1].data, null);

  const notes = peekNotifications(h.sent);
  assert.equal(notes.length, 2);
  assert.equal(notes[1].payload.state, false);
});

test("开关关闭时: 不执行 tasklist, 也不产生任何记录", () => {
  nextTasklistOutput = TASKLIST_WITH_PEEK;
  execFileCalls.length = 0;
  const h = makeHarness({ enabled: false });

  assert.equal(execFileCalls.length, 0, "开关关闭时不应执行 tasklist");
  assert.equal(peekRecords(h.sent).length, 0);
  assert.equal(peekNotifications(h.sent).length, 0);

  // 手动再轮询一次也不应触发
  h.poll();
  assert.equal(execFileCalls.length, 0);
});

test("自定义进程名: 按 processNames 匹配", () => {
  nextTasklistOutput = '"myPeek.exe","777","Console","1","1,000 K"\r\n';
  const h = makeHarness({ processNames: ["myPeek.exe"] });

  const records = peekRecords(h.sent);
  assert.equal(records.length, 1);
  assert.equal(records[0].action, "peek_start");
  assert.equal(records[0].data.pid, 777);
});

test("辅助信号: WS 上的 /liveclient 指令同样会提醒并记录", () => {
  nextTasklistOutput = TASKLIST_WITHOUT_PEEK;
  const h = makeHarness();

  h.ws399.onMessage(
    JSON.stringify({ messageType: "/liveclient", data: { state: true } })
  );

  const records = peekRecords(h.sent);
  assert.equal(records.length, 1);
  assert.equal(records[0].action, "peek_start");
  assert.equal(records[0].channel, "hugoServiceWebsocket");
});
