// @ts-check
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const tap = require("../src/aura/mainProcess/hooks/wsAuditTap.js");

/** 模拟希沃管家 WS 基类派生的客户端实例 */
class FakeWs {
  constructor(opts = {}) {
    /** @type {string[]} */
    this.calls = [];
    // 基类构造器初始化的状态字段 (isWsClientLike 据此确认身份)
    this.ws = "";
    this.start = false;
    this.ready = false;
    this.relink = false;
    this.intervals = 0;
    Object.assign(this, opts);
    // 基类构造器会 bind onMessage (见 retryHook 注释)
    this.onMessage = this.onMessage.bind(this);
  }
  setHost() {}
  sendMessage() {}
  onMessage(raw) {
    this.calls.push(raw);
    // 真实基类会自行容错非 JSON 报文; 这里同样不抛错
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

const makeCentral = (clients) => {
  const c = {};
  clients.forEach((client, index) => {
    c[index + 1] = { i: index + 1, exports: client };
  });
  return { c, m: {} };
};

const makeDeps = (overrides = {}) => {
  const written = [];
  const pushed = [];
  return {
    written,
    pushed,
    deps: {
      getConfig: () => ({ enabled: true, retentionDays: 7 }),
      writeRecord: (record) => written.push(record),
      pushEvent: (record) => pushed.push(record),
      now: () => "2026-01-01T00:00:00.000Z",
      ...overrides,
    },
  };
};

test("clientLabelOf: 优先客户端自带标识", () => {
  assert.strictEqual(tap.clientLabelOf(new FakeWs({ label: "L" }), 5), "L");
  assert.strictEqual(tap.clientLabelOf(new FakeWs({ name: "N" }), 5), "N");
  assert.strictEqual(tap.clientLabelOf(new FakeWs({ channel: "C" }), 5), "C");
});

test("clientLabelOf: 退化到 URL 最后一段 / 模块号", () => {
  // 无通道表时取 URL 最后一段, 比整条 URL 可读
  assert.strictEqual(tap.clientLabelOf(new FakeWs({ host: "wss://a/b" }), 5), "b");
  assert.strictEqual(
    tap.clientLabelOf(new FakeWs({ host: { ip: "10.0.0.1", url: "/ws" } }), 5),
    "ws"
  );
  assert.strictEqual(tap.clientLabelOf(new FakeWs(), 42), "ws-42");
});

test("urlPathOf: 丢掉 scheme://host:port, 只留路径", () => {
  assert.strictEqual(
    tap.urlPathOf("wss://127.0.0.1:51270/forward/SeewoHugoHttp/SeewoWindowBlock"),
    "/forward/SeewoHugoHttp/SeewoWindowBlock"
  );
  assert.strictEqual(tap.urlPathOf("wss://127.0.0.1/SeewoProxy"), "/SeewoProxy");
  assert.strictEqual(tap.urlPathOf("127.0.0.1:51270"), "");
  assert.strictEqual(tap.urlPathOf(""), "");
  assert.strictEqual(tap.urlPathOf(null), "");
});

test("buildChannelMap: 由管家配置表构建 路径 -> 通道名", () => {
  const map = tap.buildChannelMap({
    hugoServiceWebsocket: {
      ip: "wss://127.0.0.1",
      url: "/forward/SeewoHugoHttp/SeewoHugoService",
    },
    proxyWebsocketHost: { ip: "wss://127.0.0.1", url: "/SeewoProxy" },
    broken: null,
    noUrl: { ip: "wss://127.0.0.1" },
  });
  assert.strictEqual(
    map["/forward/SeewoHugoHttp/SeewoHugoService"],
    "hugoServiceWebsocket"
  );
  assert.strictEqual(map["/SeewoProxy"], "proxyWebsocketHost");
  assert.deepStrictEqual(tap.buildChannelMap(null), {});
  assert.deepStrictEqual(tap.buildChannelMap({}), {});
});

test("clientLabelOf: 用通道表把真机长 URL 还原成通道名", () => {
  // 真机日志里的实际形态: 客户端 host 带端口, 配置表里不带
  const map = tap.buildChannelMap({
    ADBlockWebSocket: {
      ip: "wss://127.0.0.1",
      url: "/forward/SeewoHugoHttp/SeewoWindowBlock",
    },
    audioWebsocket: {
      ip: "wss://127.0.0.1",
      url: "/forward/SeewoHugoHttp/SeewoLightAudio",
    },
  });
  const blockClient = new FakeWs({
    host: "wss://127.0.0.1:51270/forward/SeewoHugoHttp/SeewoWindowBlock",
  });
  const audioClient = new FakeWs({
    host: "wss://127.0.0.1:51270/forward/SeewoHugoHttp/SeewoLightAudio",
  });

  assert.strictEqual(tap.clientLabelOf(blockClient, 397, map), "ADBlockWebSocket");
  assert.strictEqual(tap.clientLabelOf(audioClient, 407, map), "audioWebsocket");
  // 无通道表时退化为 URL 最后一段
  assert.strictEqual(tap.clientLabelOf(blockClient, 397, {}), "SeewoWindowBlock");
  // 客户端自带 label 仍然最优先
  assert.strictEqual(
    tap.clientLabelOf(new FakeWs({ label: "X", host: "wss://a/b" }), 1, map),
    "X"
  );
});

test("sourceOf: 无 host 时返回 unknown", () => {
  assert.strictEqual(tap.sourceOf(new FakeWs()), "unknown");
  assert.strictEqual(tap.sourceOf(null), "unknown");
  assert.strictEqual(tap.sourceOf(new FakeWs({ url: "/u" })), "/u");
});

test("collectWsClients: 只收集 WS 客户端并去重", () => {
  const a = new FakeWs();
  const b = new FakeWs();
  const notWs = { foo: 1 };
  const central = { c: { 1: { i: 1, exports: a }, 2: { i: 2, exports: notWs }, 3: { i: 3, exports: b }, 4: { i: 4, exports: a } }, m: {} };

  const found = tap.collectWsClients(central);
  assert.deepStrictEqual(
    found.map((f) => f.moduleId),
    [1, 3]
  );
});

test("collectWsClients: 无模块缓存时返回空", () => {
  assert.deepStrictEqual(tap.collectWsClients(null), []);
  assert.deepStrictEqual(tap.collectWsClients({}), []);
});

test("collectWsClients: onMessage 不含 JSON.parse 的客户端也要采集 (宽松判定)", () => {
  // 只做转发的客户端: onMessage 源码里没有 JSON.parse
  const relay = {
    ws: "",
    ready: false,
    relink: false,
    intervals: 0,
    onMessage(raw) {
      return raw;
    },
    setHost() {},
    sendMessage() {},
  };
  const central = { c: { 1: { i: 1, exports: relay } }, m: {} };

  // 严格判定 (WS 基类定位用) 会漏掉它
  const strict = tap.collectWsClients(central, (c) =>
    require("../src/aura/mainProcess/hooks/retryHook.js").isWsClientInstance(c)
  );
  assert.strictEqual(strict.length, 0);

  // 宽松判定 (探针默认) 必须采集到
  const loose = tap.collectWsClients(central);
  assert.deepStrictEqual(
    loose.map((f) => f.moduleId),
    [1]
  );
});

test("collectWsClients: 不具备 WS 基类成员的对象不采集", () => {
  const central = {
    c: {
      1: { i: 1, exports: { setHost() {}, sendMessage() {} } }, // 缺 onMessage
      2: { i: 2, exports: { onMessage() {}, ready: false } }, // 缺 setHost
      3: { i: 3, exports: { onMessage() {}, setHost() {}, sendMessage() {} } }, // 缺状态字段
    },
    m: {},
  };
  assert.deepStrictEqual(tap.collectWsClients(central), []);
});

test("探针: cloudUpdateInterceptor 晚于探针安装时动态让位, 不再重复记录", () => {
  const a = new FakeWs({ label: "A" });
  const { deps, written } = makeDeps();
  tap.installTapOnClient(a, 1, deps, { refreshOnInstall: false });

  a.onMessage(JSON.stringify({ url: "/x" }));
  assert.strictEqual(written.length, 1);

  // 覆盖者后来才挂上 (模块懒加载重试成功的场景)
  const coverHandler = () => false;
  coverHandler.__auraAuditCovered = true;
  a.__auraWsInterceptors.push(coverHandler);

  a.onMessage(JSON.stringify({ url: "/y" }));
  // 探针让位, 不再新增记录; 消息仍然透传
  assert.strictEqual(written.length, 1);
  assert.strictEqual(a.calls.length, 2);
});

test("installAll: 给所有客户端挂探针 (关闭自动重连)", () => {
  const a = new FakeWs({ label: "A" });
  const b = new FakeWs({ label: "B" });
  const central = makeCentral([a, b]);
  const { deps } = makeDeps();

  const res = tap.installAll(central, deps, { refreshOnInstall: false });
  assert.strictEqual(res.total, 2);
  assert.strictEqual(res.installed, 2);
  assert.ok(Array.isArray(a.__auraWsInterceptors));
  assert.strictEqual(a.__auraWsInterceptors.length, 1);
  assert.strictEqual(typeof a.__auraWsInterceptors[0], "function");
});

test("installTapOnClient: 幂等, 重复安装不叠加处理函数", () => {
  const a = new FakeWs({ label: "A" });
  const { deps } = makeDeps();

  assert.strictEqual(
    tap.installTapOnClient(a, 1, deps, { refreshOnInstall: false }),
    true
  );
  assert.strictEqual(
    tap.installTapOnClient(a, 1, deps, { refreshOnInstall: false }),
    false
  );
  assert.strictEqual(a.__auraWsInterceptors.length, 1);
});

test("installAll: 跳过 cloudUpdateInterceptor 固定覆盖的 390/399 通道", () => {
  const ws399 = new FakeWs({ label: "hugoServiceWebsocket" });
  const ws390 = new FakeWs({ label: "proxyWebsocketHost" });
  const other = new FakeWs({ label: "webrtcWebsocket" });
  const central = {
    c: {
      390: { i: 390, exports: ws390 },
      399: { i: 399, exports: ws399 },
      408: { i: 408, exports: other },
    },
    m: {},
  };

  const { deps, written } = makeDeps();
  const res = tap.installAll(central, deps, { refreshOnInstall: false });

  assert.strictEqual(res.total, 3);
  assert.strictEqual(res.installed, 1);
  assert.strictEqual(ws399.__auraWsInterceptors, undefined);
  assert.strictEqual(ws390.__auraWsInterceptors, undefined);
  assert.strictEqual(other.__auraWsInterceptors.length, 1);
  assert.strictEqual(written.length, 0);
});

test("installAll: 跳过已被 cloudUpdateInterceptor 覆盖的通道", () => {
  const covered = new FakeWs({ label: "covered" });
  const handler = () => false;
  handler.__auraAuditCovered = true;
  covered.__auraWsInterceptors = [handler];
  const free = new FakeWs({ label: "free" });

  const { deps, written } = makeDeps();
  const res = tap.installAll(makeCentral([covered, free]), deps, {
    refreshOnInstall: false,
  });

  assert.strictEqual(res.total, 2);
  assert.strictEqual(res.installed, 1);
  // 被覆盖的通道不新增处理函数
  assert.strictEqual(covered.__auraWsInterceptors.length, 1);
  assert.strictEqual(free.__auraWsInterceptors.length, 1);
  assert.strictEqual(written.length, 0);
});

test("isCoveredByExistingHook: 无标记返回 false", () => {
  const client = new FakeWs();
  assert.strictEqual(tap.isCoveredByExistingHook(client), false);
  client.__auraWsInterceptors = [() => false];
  assert.strictEqual(tap.isCoveredByExistingHook(client), false);
  client.__auraWsInterceptors = [Object.assign(() => false, { __auraAuditCovered: true })];
  assert.strictEqual(tap.isCoveredByExistingHook(client), true);
});

test("探针记录指令且不消费消息 (原始 onMessage 仍被调用)", () => {
  const a = new FakeWs({ label: "A", host: "wss://h/1" });
  const { deps, written, pushed } = makeDeps();
  tap.installTapOnClient(a, 7, deps, { refreshOnInstall: false });

  a.onMessage(JSON.stringify({ url: "/liveclient", traceId: "t1" }));

  // 消息继续透传 (calls 里记录了原始报文)
  assert.strictEqual(a.calls.length, 1);
  assert.strictEqual(written.length, 1);
  assert.strictEqual(pushed.length, 1);

  const rec = written[0];
  assert.strictEqual(rec.channel, "A");
  assert.strictEqual(rec.channelId, 7);
  assert.strictEqual(rec.source, "wss://h/1");
  assert.strictEqual(rec.url, "/liveclient");
  assert.strictEqual(rec.key, "/liveclient");
  assert.strictEqual(rec.action, "logged");
  assert.strictEqual(rec.blocked, false);
  assert.strictEqual(rec._logType, "cloud");
  assert.strictEqual(rec.ts, "2026-01-01T00:00:00.000Z");
});

test("探针: messageType 类指令也能记录 (旧实现的漏记点)", () => {
  const a = new FakeWs({ label: "A" });
  const { deps, written } = makeDeps();
  tap.installTapOnClient(a, 7, deps, { refreshOnInstall: false });

  a.onMessage(JSON.stringify({ messageType: 1001, data: { sn: "x" } }));

  assert.strictEqual(written.length, 1);
  assert.strictEqual(written[0].key, "messageType:1001");
  assert.strictEqual(written[0].messageType, 1001);
});

test("探针: 心跳 / 空消息不记录", () => {
  const a = new FakeWs({ label: "A" });
  const { deps, written } = makeDeps();
  tap.installTapOnClient(a, 7, deps, { refreshOnInstall: false });

  a.onMessage(JSON.stringify({}));
  a.onMessage(JSON.stringify({ ping: 1 }));
  assert.strictEqual(written.length, 0);
});

test("探针: 配置关闭时不记录, 但仍透传消息", () => {
  const a = new FakeWs({ label: "A" });
  const { deps, written } = makeDeps({
    getConfig: () => ({ enabled: false, retentionDays: 7 }),
  });
  tap.installTapOnClient(a, 7, deps, { refreshOnInstall: false });

  a.onMessage(JSON.stringify({ url: "/x" }));
  assert.strictEqual(written.length, 0);
  assert.strictEqual(a.calls.length, 1);
});

test("探针: 非 JSON 消息原样透传, 不抛错", () => {
  const a = new FakeWs({ label: "A" });
  const { deps, written } = makeDeps();
  tap.installTapOnClient(a, 7, deps, { refreshOnInstall: false });

  assert.doesNotThrow(() => a.onMessage("not-json"));
  assert.strictEqual(written.length, 0);
});

test("探针: 写日志抛错不影响消息透传", () => {
  const a = new FakeWs({ label: "A" });
  const { deps } = makeDeps({
    writeRecord: () => {
      throw new Error("disk full");
    },
  });
  tap.installTapOnClient(a, 7, deps, { refreshOnInstall: false });

  assert.doesNotThrow(() => a.onMessage(JSON.stringify({ url: "/x" })));
  assert.strictEqual(a.calls.length, 1);
});

test("安装时连接已建立: 主动重连一次 (幂等)", () => {
  const closed = [];
  const a = new FakeWs({
    label: "A",
    ws: { close: () => closed.push(1) },
  });
  const { deps } = makeDeps();

  tap.installTapOnClient(a, 1, deps, { refreshOnInstall: true });
  assert.strictEqual(closed.length, 1);
  assert.strictEqual(a.intervals, 0);

  // 再次调用被幂等拦截, 不会二次断线
  tap.installTapOnClient(a, 1, deps, { refreshOnInstall: true });
  assert.strictEqual(closed.length, 1);
});

test("refreshOnInstall=false 时不重连", () => {
  const closed = [];
  const a = new FakeWs({ label: "A", ws: { close: () => closed.push(1) } });
  const { deps } = makeDeps();
  tap.installTapOnClient(a, 1, deps, { refreshOnInstall: false });
  assert.strictEqual(closed.length, 0);
});

test("installAll: 错峰重连, 第二个客户端延迟 REFRESH_STAGGER_MS", () => {
  const delays = [];
  const origSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => {
    delays.push(ms);
    return { unref() {} };
  };
  try {
    const clients = [
      new FakeWs({ label: "A", ws: { close() {} } }),
      new FakeWs({ label: "B", ws: { close() {} } }),
    ];
    const { deps } = makeDeps();
    tap.installAll(makeCentral(clients), deps, { refreshOnInstall: true });
    // 第一个客户端立即重连, 第二个错峰
    assert.deepStrictEqual(delays, [tap.REFRESH_STAGGER_MS]);
  } finally {
    global.setTimeout = origSetTimeout;
  }
});
