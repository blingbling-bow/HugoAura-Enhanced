// @ts-check
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const tap = require("../src/aura/mainProcess/hooks/httpAuditTap.js");

class FakeReq extends EventEmitter {
  constructor() {
    super();
    /** @type {any[]} */
    this.writes = [];
    this.ended = false;
  }
  write(chunk) {
    this.writes.push(chunk);
    return true;
  }
  end() {
    this.ended = true;
  }
}

class FakeRes extends EventEmitter {
  constructor(statusCode = 200) {
    super();
    this.statusCode = statusCode;
  }
}

/** 造一个 follow-redirects 风格的 provider */
const makeProvider = () => {
  const calls = [];
  const https = {
    request(options, cb) {
      const req = new FakeReq();
      calls.push({ options, cb, req });
      return req;
    },
  };
  return {
    calls,
    provider: { https, http: { request() {} } },
  };
};

const makeDeps = (overrides = {}) => {
  const written = [];
  const pushed = [];
  return {
    written,
    pushed,
    deps: {
      getConfig: () => ({ enabled: true, retentionDays: 7 }),
      writeRecord: (rec) => written.push(rec),
      pushEvent: (rec) => pushed.push(rec),
      now: () => "2026-01-01T00:00:00.000Z",
      ...overrides,
    },
  };
};

test("isHttpProviderLike: 只认同时具备 http/https.request 的导出", () => {
  const { provider } = makeProvider();
  assert.strictEqual(tap.isHttpProviderLike(provider), true);
  assert.strictEqual(tap.isHttpProviderLike(null), false);
  assert.strictEqual(tap.isHttpProviderLike({}), false);
  assert.strictEqual(tap.isHttpProviderLike({ https: { request() {} } }), false);
  assert.strictEqual(tap.isHttpProviderLike({ http: { request() {} } }), false);
});

test("describeRequest: 归一化 path / method / host", () => {
  assert.deepStrictEqual(
    tap.describeRequest({
      hostname: "127.0.0.1",
      port: 8899,
      path: "/api/v1/device/id",
      method: "get",
    }),
    { path: "/api/v1/device/id", method: "GET", host: "127.0.0.1:8899" }
  );
  // method 缺省为 GET; host 兜底
  assert.deepStrictEqual(tap.describeRequest({ host: "10.0.0.1", path: "/x" }), {
    path: "/x",
    method: "GET",
    host: "10.0.0.1",
  });
  assert.deepStrictEqual(tap.describeRequest(null), {
    path: "",
    method: "GET",
    host: "",
  });
});

test("buildHttpRecord: 出站记录字段与响应体解析", () => {
  const rec = tap.buildHttpRecord(
    { hostname: "127.0.0.1", port: 8899, path: "/api/v1/device/id", method: "get" },
    { statusCode: 200, body: JSON.stringify({ code: "000000", data: { id: 1 } }), requestBody: "" },
    "2026-01-01T00:00:00.000Z"
  );

  assert.strictEqual(rec.channel, "SeewoProxyHTTP");
  assert.strictEqual(rec.direction, "outbound");
  assert.strictEqual(rec.url, "/api/v1/device/id");
  assert.strictEqual(rec.key, "/api/v1/device/id");
  assert.strictEqual(rec.method, "GET");
  assert.strictEqual(rec.httpStatus, 200);
  assert.deepStrictEqual(rec.data, { code: "000000", data: { id: 1 } });
  assert.strictEqual(rec.action, "logged");
  assert.strictEqual(rec.blocked, false);
  assert.strictEqual(rec._logType, "http");
  assert.strictEqual(rec.error, null);
});

test("buildHttpRecord: 非 JSON 响应保留原文, 错误记录 error", () => {
  const rec = tap.buildHttpRecord(
    { path: "/x", method: "post" },
    { statusCode: 502, body: "<html>bad gateway</html>" },
    "T"
  );
  assert.strictEqual(rec.data, "<html>bad gateway</html>");
  assert.strictEqual(rec.messageType, null);

  const errRec = tap.buildHttpRecord(
    { path: "/y" },
    { error: new Error("ECONNREFUSED") },
    "T"
  );
  assert.strictEqual(errRec.error, "ECONNREFUSED");
  assert.strictEqual(errRec.data, null);
});

test("installHttpAuditTap: 打补丁且幂等", () => {
  const { provider } = makeProvider();
  const { deps } = makeDeps();
  const original = provider.https.request;

  assert.strictEqual(tap.installHttpAuditTap(provider, deps), true);
  const patched = provider.https.request;
  assert.notStrictEqual(patched, original);

  // 二次安装不再包装 (否则会重复记录)
  assert.strictEqual(tap.installHttpAuditTap(provider, deps), true);
  assert.strictEqual(provider.https.request, patched);

  // 原函数仍然被调用
  provider.https.request({ path: "/x" });
  assert.strictEqual(tap.installHttpAuditTap(provider, deps), true);
});

test("installHttpAuditTap: provider 不合法时返回 false", () => {
  const { deps } = makeDeps();
  assert.strictEqual(tap.installHttpAuditTap(null, deps), false);
  assert.strictEqual(tap.installHttpAuditTap({}, deps), false);
});

test("端到端: 采集请求体与响应体, 不改动原请求", () => {
  const { provider, calls } = makeProvider();
  const { deps, written, pushed } = makeDeps();
  tap.installHttpAuditTap(provider, deps);

  const req = provider.https.request({
    hostname: "127.0.0.1",
    port: 8899,
    path: "/api/v1/uips/feedback",
    method: "post",
  });
  // 模块 11 的调用方式: req.write(JSON.stringify(body)) + req.end()
  req.write(JSON.stringify({ operationLogId: "1" }));
  req.end();

  assert.deepStrictEqual(req.writes, [JSON.stringify({ operationLogId: "1" })]);
  assert.strictEqual(req.ended, true);

  const res = new FakeRes(200);
  req.emit("response", res);
  res.emit("data", Buffer.from(JSON.stringify({ code: 0 })));
  res.emit("end");

  assert.strictEqual(written.length, 1);
  assert.strictEqual(pushed.length, 1);
  const rec = written[0];
  assert.strictEqual(rec.url, "/api/v1/uips/feedback");
  assert.strictEqual(rec.method, "POST");
  assert.deepStrictEqual(rec.data, { code: 0 });
  assert.deepStrictEqual(rec.requestData, { operationLogId: "1" });
  assert.strictEqual(rec.ts, "2026-01-01T00:00:00.000Z");
  // 原始调用方仍拿到了请求对象
  assert.strictEqual(calls.length, 1);
});

test("端到端: 配置关闭时不记录", () => {
  const { provider } = makeProvider();
  const { deps, written } = makeDeps({
    getConfig: () => ({ enabled: false, retentionDays: 7 }),
  });
  tap.installHttpAuditTap(provider, deps);

  const req = provider.https.request({ path: "/x" });
  const res = new FakeRes(200);
  req.emit("response", res);
  res.emit("data", Buffer.from("{}"));
  res.emit("end");

  assert.strictEqual(written.length, 0);
});

test("端到端: 请求错误也留痕", () => {
  const { provider } = makeProvider();
  const { deps, written } = makeDeps();
  tap.installHttpAuditTap(provider, deps);

  const req = provider.https.request({ path: "/y", method: "post" });
  req.emit("error", new Error("ECONNREFUSED"));

  assert.strictEqual(written.length, 1);
  assert.strictEqual(written[0].error, "ECONNREFUSED");
  assert.strictEqual(written[0].url, "/y");
});

test("端到端: 大响应按上限截断, 不抛错", () => {
  const { provider } = makeProvider();
  const { deps, written } = makeDeps();
  tap.installHttpAuditTap(provider, deps);

  const req = provider.https.request({ path: "/big" });
  const res = new FakeRes(200);
  req.emit("response", res);
  // 连续推送远超上限的数据
  for (let i = 0; i < 20; i++) {
    res.emit("data", Buffer.alloc(16 * 1024, 0x61));
  }
  res.emit("end");

  assert.strictEqual(written.length, 1);
  const body = written[0].data;
  assert.ok(typeof body === "string");
  assert.ok(body.length <= tap.MAX_BODY_BYTES);
});

test("端到端: 采集抛错不影响原请求返回", () => {
  const { provider } = makeProvider();
  const { deps } = makeDeps({
    writeRecord: () => {
      throw new Error("disk full");
    },
  });
  tap.installHttpAuditTap(provider, deps);

  const req = provider.https.request({ path: "/x" });
  const res = new FakeRes(200);
  assert.doesNotThrow(() => {
    req.emit("response", res);
    res.emit("data", Buffer.from("{}"));
    res.emit("end");
  });
});
