// @ts-check

/**
 * cloudUpdateInterceptor 审计记录测试 (不需要安装希沃管家)。
 *
 * 重点回归: 旧实现要求 `url` 必须是非空字符串, 导致 **messageType 类指令全部漏记**
 * (窥屏 /liveclient、设备信息 1001、锁屏 1211…), 这正是"审计里看不到云端到底发了
 * 什么"的直接原因。现在 url / messageType / 陌生内容 都要能记录。
 *
 * 同时覆盖: 动作语义 (blocked / captured / logged)、一条指令只写一条记录、
 * 拦截仍会吞掉指令、心跳空消息不记录、以及既有纯函数 cleanExpiredEntries。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const auditWriter = require("../src/aura/mainProcess/hooks/auditWriter");
const cloudUpdate = require("../src/aura/mainProcess/hooks/cloudUpdateInterceptor");
const { commandKeyOf, cleanExpiredEntries } = cloudUpdate;

let written = [];
const origWriteAudit = auditWriter.writeAudit;
const origReadAudit = auditWriter.readAudit;
auditWriter.writeAudit = (file, record) => written.push({ file, record });
auditWriter.readAudit = () => "";

/** 假 WS 客户端: 原型方法含 JSON.parse, 以通过 installWsInterceptor 自检 */
class FakeWsClient {
  constructor(name) {
    this.name = name;
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

const setConfig = ({
  auditEnabled = true,
  retentionDays = 7,
  interceptEnabled = true,
  mode = "block",
} = {}) => {
  // @ts-ignore 钩子通过 global.__HUGO_AURA_CONFIG_MGR__.loadConfig() 读配置
  global.__HUGO_AURA_CONFIG_MGR__ = {
    loadConfig: () => ({
      auraSettings: {
        cloudCommandAudit: { enabled: auditEnabled, retentionDays },
        cloudUpdateIntercept: { enabled: interceptEnabled, mode, extraBlockUrls: [] },
      },
    }),
  };
};

const makeHarness = (opts = {}) => {
  written = [];
  setConfig(opts);

  const sent = [];
  const electron = {
    ipcMain: {
      send: (windowKey, channel, payload) => sent.push({ channel, payload }),
    },
  };

  const ws399 = new FakeWsClient("hugoServiceWebsocket");
  const ws390 = new FakeWsClient("proxyWebsocketHost");

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
      // @ts-ignore 与 webpack 一致
      err.code = "MODULE_NOT_FOUND";
      throw err;
    }
    return modules[id];
  };
  central.m = {};
  central.c = {};

  cloudUpdate.hookFunc(central);

  return {
    sent,
    ws399,
    ws390,
    records: () => written.map((w) => w.record),
  };
};

test("commandKeyOf: url 优先, messageType 兜底, 陌生内容标 unidentified", () => {
  assert.equal(commandKeyOf({ url: "/a" }), "/a");
  assert.equal(commandKeyOf({ url: "/a", messageType: 1 }), "/a");
  assert.equal(commandKeyOf({ messageType: "/liveclient" }), "messageType:/liveclient");
  assert.equal(commandKeyOf({ messageType: 1001 }), "messageType:1001");
  assert.equal(commandKeyOf({ data: { x: 1 } }), "(unidentified)");
  assert.equal(commandKeyOf({ traceId: "T" }), "(unidentified)");
  assert.equal(commandKeyOf({}), null);
  assert.equal(commandKeyOf(null), null);
});

test("commandKeyOf: 备选判别字段也能定位指令 (旧实现静默漏记)", () => {
  assert.equal(commandKeyOf({ type: 7 }), "type:7");
  assert.equal(commandKeyOf({ type: "freeze", data: { x: 1 } }), "type:freeze");
  assert.equal(commandKeyOf({ cmd: "lock" }), "cmd:lock");
  assert.equal(commandKeyOf({ command: 1211 }), "command:1211");
  assert.equal(commandKeyOf({ method: "peek" }), "method:peek");
  assert.equal(commandKeyOf({ event: "bind" }), "event:bind");
  assert.equal(commandKeyOf({ action: "shutdown" }), "action:shutdown");
  // url / messageType 仍然优先
  assert.equal(commandKeyOf({ url: "/a", type: 7 }), "/a");
  assert.equal(commandKeyOf({ messageType: 1001, type: 7 }), "messageType:1001");
  // 空字符串 / 非有限数值不算命中, 落到 unidentified
  assert.equal(commandKeyOf({ type: "", data: {} }), "(unidentified)");
  assert.equal(commandKeyOf({ type: NaN, data: {} }), "(unidentified)");
});

test("commandKeyOf: 纯心跳仍不记录 (避免十几条通道刷屏)", () => {
  assert.equal(commandKeyOf({ ts: "2026-01-01T00:00:00Z" }), null);
  assert.equal(commandKeyOf({ ping: 1 }), null);
  assert.equal(commandKeyOf({ heartbeat: true, time: 1 }), null);
  assert.equal(commandKeyOf({ keepAlive: 1 }), null);
  // 心跳里夹带判别字段 -> 按指令记录 (说明确实是条指令)
  assert.equal(commandKeyOf({ ts: "x", type: 7 }), "type:7");
});

test("回归: messageType 类指令也会被记录 (旧实现只记录带 url 的)", () => {
  const h = makeHarness({ auditEnabled: true });
  h.ws399.onMessage(
    JSON.stringify({ messageType: "/liveclient", data: { state: true }, traceId: "T1" })
  );

  const records = h.records();
  assert.equal(records.length, 1);
  const rec = records[0];
  assert.equal(rec.key, "messageType:/liveclient");
  assert.equal(rec.messageType, "/liveclient");
  assert.equal(rec.url, null);
  assert.equal(rec.channel, "hugoServiceWebsocket");
  assert.equal(rec.channelId, 399);
  assert.equal(rec.traceId, "T1");
  assert.equal(rec.action, "logged");
  assert.deepEqual(rec.data, { state: true });
  assert.equal(rec._logType, "cloud");
});

test("url 类指令: 记录完整字段并推送到渲染层", () => {
  const h = makeHarness({ auditEnabled: true });
  h.ws390.onMessage(
    JSON.stringify({ url: "/password/authMode", data: { mode: 0 }, traceId: "T2" })
  );

  const records = h.records();
  assert.equal(records.length, 1);
  assert.equal(records[0].key, "/password/authMode");
  assert.equal(records[0].channel, "proxyWebsocketHost");
  assert.equal(records[0].channelId, 390);
  assert.equal(records[0].source, "wss://127.0.0.1/SeewoProxy");

  const pushed = h.sent.filter((s) => s.channel === "$aura.audit.onLog");
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].payload.record.key, "/password/authMode");
});

test("陌生指令 (无 url/messageType 但有内容) 记为 unidentified", () => {
  const h = makeHarness({ auditEnabled: true });
  h.ws399.onMessage(JSON.stringify({ data: { weird: true } }));

  const records = h.records();
  assert.equal(records.length, 1);
  assert.equal(records[0].key, "(unidentified)");
});

test("心跳/空消息不记录", () => {
  const h = makeHarness({ auditEnabled: true });
  h.ws399.onMessage(JSON.stringify({}));
  h.ws399.onMessage(JSON.stringify({ foo: "bar" }));
  assert.equal(h.records().length, 0);
});

test("block 模式: 命中更新规则只写一条 blocked 记录, 并吞掉指令", () => {
  const h = makeHarness({ auditEnabled: true, mode: "block" });
  h.ws399.onMessage(
    JSON.stringify({ url: "/serviceUpgrade/status", data: { status: 1 } })
  );

  const records = h.records();
  assert.equal(records.length, 1, "旧实现会同时写 logged + blocked 两条");
  assert.equal(records[0].action, "blocked");
  assert.equal(records[0].blocked, true);
  assert.equal(records[0].intercepted, true);
  assert.deepEqual(h.ws399.messages, [], "被拦截的指令不应到达原始 onMessage");
});

test("block 模式: 非更新指令放行, 全量记录开启时写 logged", () => {
  const h = makeHarness({ auditEnabled: true, mode: "block" });
  h.ws399.onMessage(JSON.stringify({ url: "/password/authMode", data: { mode: 0 } }));

  const records = h.records();
  assert.equal(records.length, 1);
  assert.equal(records[0].action, "logged");
  assert.equal(records[0].blocked, false);
  assert.equal(h.ws399.messages.length, 1, "非更新指令必须透传");
});

test("审计关闭 + block 模式: 非更新指令不记录, 拦截指令仍留痕", () => {
  const h = makeHarness({ auditEnabled: false, mode: "block" });

  h.ws399.onMessage(JSON.stringify({ url: "/password/authMode", data: {} }));
  assert.equal(h.records().length, 0, "审计关闭时非高危指令不该写日志");

  h.ws399.onMessage(JSON.stringify({ url: "/serviceUpgrade/status", data: {} }));
  const records = h.records();
  assert.equal(records.length, 1);
  assert.equal(records[0].action, "blocked");
});

test("log 模式: 写 captured 且不吞指令 (审计关闭时也保留留痕)", () => {
  const h = makeHarness({ auditEnabled: false, mode: "log" });
  h.ws399.onMessage(JSON.stringify({ url: "/serviceUpgrade/status", data: {} }));

  const records = h.records();
  assert.equal(records.length, 1);
  assert.equal(records[0].action, "captured");
  assert.equal(records[0].intercepted, false);
  assert.equal(h.ws399.messages.length, 1, "log 模式不得拦截");
});

test("功能未启用: 只做全量记录, 不拦截", () => {
  const h = makeHarness({ auditEnabled: true, interceptEnabled: false });
  h.ws399.onMessage(JSON.stringify({ url: "/serviceUpgrade/status", data: {} }));

  const records = h.records();
  assert.equal(records.length, 1);
  assert.equal(records[0].action, "logged");
  assert.equal(records[0].blocked, false);
  assert.equal(h.ws399.messages.length, 1);
});

test("cleanExpiredEntries: 按时间清理, 保留损坏行", () => {
  const now = Date.now();
  const content = [
    JSON.stringify({ ts: new Date(now - 10 * 86400000).toISOString(), url: "/old" }),
    JSON.stringify({ ts: new Date(now).toISOString(), url: "/new" }),
    "{broken",
  ].join("\n");

  const { kept, removed } = cleanExpiredEntries(content, now - 7 * 86400000);
  assert.equal(removed, 1);
  assert.equal(kept.length, 2, "未过期条目与损坏行都应保留");
});

// 收尾: 还原被替换的写入器 (避免影响同进程其它测试文件)
test.after(() => {
  auditWriter.writeAudit = origWriteAudit;
  auditWriter.readAudit = origReadAudit;
});
