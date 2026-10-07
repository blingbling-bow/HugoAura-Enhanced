// @ts-check
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  applyAuditIpcHandler,
  parseJsonlFile,
  normalizeLimit,
} = require("../src/aura/init/main/ipcModules/auditIpcHandler.js");

/** 构造一个只记录 handler 的假 ipcMain */
const makeFakeIpcMain = () => {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
    invoke(channel, arg) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return fn({}, arg);
    },
  };
};

/** 建立临时 aura 目录并把 global.__HUGO_AURA__ 指过去 */
const withTempAuraDir = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-audit-"));
  const prev = global.__HUGO_AURA__;
  global.__HUGO_AURA__ = { auraDir: dir };
  try {
    return fn(dir);
  } finally {
    global.__HUGO_AURA__ = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const writeCloud = (dir, entries) => {
  const logDir = path.join(dir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(
    path.join(logDir, "cloudCommandAudit.log"),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
  );
  return logDir;
};

test("normalizeLimit: 非法值回落到默认 300", () => {
  assert.strictEqual(normalizeLimit(undefined), 300);
  assert.strictEqual(normalizeLimit(null), 300);
  assert.strictEqual(normalizeLimit(0), 300);
  assert.strictEqual(normalizeLimit(-5), 300);
  assert.strictEqual(normalizeLimit("abc"), 300);
  assert.strictEqual(normalizeLimit(NaN), 300);
});

test("normalizeLimit: 取整并封顶 1000", () => {
  assert.strictEqual(normalizeLimit(50), 50);
  assert.strictEqual(normalizeLimit("50"), 50);
  assert.strictEqual(normalizeLimit(12.9), 12);
  assert.strictEqual(normalizeLimit(999999), 1000);
});

test("parseJsonlFile: 文件不存在返回空数组", () => {
  assert.deepStrictEqual(parseJsonlFile("C:\\nope\\nope.log", 10), []);
  assert.deepStrictEqual(parseJsonlFile("", 10), []);
});

test("parseJsonlFile: 跳过损坏行并保持倒序", () => {
  withTempAuraDir((dir) => {
    const logDir = path.join(dir, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, "x.log");
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ ts: "2026-01-01T00:00:01.000Z", n: 1 }),
        "{ 这不是 JSON",
        "",
        JSON.stringify({ ts: "2026-01-01T00:00:02.000Z", n: 2 }),
      ].join("\n")
    );

    const got = parseJsonlFile(file, 10);
    assert.strictEqual(got.length, 2);
    assert.strictEqual(got[0].n, 2);
    assert.strictEqual(got[1].n, 1);
  });
});

test("parseJsonlFile: limit 只保留最近的条目", () => {
  withTempAuraDir((dir) => {
    const logDir = path.join(dir, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, "x.log");
    fs.writeFileSync(
      file,
      [1, 2, 3, 4, 5].map((n) => JSON.stringify({ n })).join("\n") + "\n"
    );

    const got = parseJsonlFile(file, 2);
    assert.deepStrictEqual(
      got.map((e) => e.n),
      [5, 4]
    );
  });
});

test("applyAuditIpcHandler: 注册三个通道", () => {
  const ipc = makeFakeIpcMain();
  applyAuditIpcHandler(ipc);
  assert.ok(ipc.handlers.has("$aura.audit.getLogs"));
  assert.ok(ipc.handlers.has("$aura.audit.exportLogs"));
  assert.ok(ipc.handlers.has("$aura.audit.clearLogs"));
});

test("getLogs: 合并两个来源并补 _logType", () => {
  withTempAuraDir((dir) => {
    const logDir = writeCloud(dir, [
      { ts: "2026-01-01T00:00:01.000Z", url: "/a" },
      {
        ts: "2026-01-01T00:00:02.000Z",
        url: "/b",
        _logType: "lockScreen",
      },
    ]);
    fs.writeFileSync(
      path.join(logDir, "screenPeekAudit.log"),
      JSON.stringify({ ts: "2026-01-01T00:00:03.000Z", action: "peek_start" }) +
        "\n"
    );

    const ipc = makeFakeIpcMain();
    applyAuditIpcHandler(ipc);
    const res = ipc.invoke("$aura.audit.getLogs", {});

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.data.cloud.length, 2);
    assert.strictEqual(res.data.peek.length, 1);
    // 默认值兜底
    assert.strictEqual(res.data.cloud[1]._logType, "cloud");
    // 自带 _logType 不被覆写
    assert.strictEqual(res.data.cloud[0]._logType, "lockScreen");
    assert.strictEqual(res.data.peek[0]._logType, "peek");
  });
});

test("getLogs: limit 生效", () => {
  withTempAuraDir((dir) => {
    writeCloud(
      dir,
      [1, 2, 3, 4, 5].map((n) => ({
        ts: `2026-01-01T00:00:0${n}.000Z`,
        url: `/${n}`,
      }))
    );

    const ipc = makeFakeIpcMain();
    applyAuditIpcHandler(ipc);
    const res = ipc.invoke("$aura.audit.getLogs", { limit: 2 });
    assert.strictEqual(res.data.cloud.length, 2);
    assert.strictEqual(res.data.cloud[0].url, "/5");
  });
});

test("getLogs: 无 auraDir 时失败但不抛错", () => {
  const prev = global.__HUGO_AURA__;
  global.__HUGO_AURA__ = undefined;
  try {
    const ipc = makeFakeIpcMain();
    applyAuditIpcHandler(ipc);
    const res = ipc.invoke("$aura.audit.getLogs", {});
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.error, "LOG_DIR_UNAVAILABLE");
    assert.strictEqual(res.data, null);
  } finally {
    global.__HUGO_AURA__ = prev;
  }
});

test("exportLogs: 输出按时间正序的 JSONL", () => {
  withTempAuraDir((dir) => {
    const logDir = writeCloud(dir, [
      { ts: "2026-01-01T00:00:03.000Z", url: "/c" },
      { ts: "2026-01-01T00:00:01.000Z", url: "/a" },
    ]);
    fs.writeFileSync(
      path.join(logDir, "screenPeekAudit.log"),
      JSON.stringify({ ts: "2026-01-01T00:00:02.000Z", action: "peek_start" }) +
        "\n"
    );

    const ipc = makeFakeIpcMain();
    applyAuditIpcHandler(ipc);
    const res = ipc.invoke("$aura.audit.exportLogs", {});

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.data.count, 3);

    const lines = res.data.text.trim().split("\n").map((l) => JSON.parse(l));
    assert.deepStrictEqual(
      lines.map((e) => e.ts),
      [
        "2026-01-01T00:00:01.000Z",
        "2026-01-01T00:00:02.000Z",
        "2026-01-01T00:00:03.000Z",
      ]
    );
  });
});

test("exportLogs: 无记录时返回空文本", () => {
  withTempAuraDir((dir) => {
    fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
    const ipc = makeFakeIpcMain();
    applyAuditIpcHandler(ipc);
    const res = ipc.invoke("$aura.audit.exportLogs", {});
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.data.text, "");
    assert.strictEqual(res.data.count, 0);
  });
});

test("clearLogs: 按 target 清空对应文件", () => {
  withTempAuraDir((dir) => {
    const logDir = writeCloud(dir, [{ ts: "2026-01-01T00:00:01.000Z", url: "/a" }]);
    const peekFile = path.join(logDir, "screenPeekAudit.log");
    fs.writeFileSync(peekFile, JSON.stringify({ ts: "x", action: "peek_start" }) + "\n");

    const ipc = makeFakeIpcMain();
    applyAuditIpcHandler(ipc);

    const res = ipc.invoke("$aura.audit.clearLogs", { target: "cloud" });
    assert.strictEqual(res.success, true);
    assert.strictEqual(
      fs.readFileSync(path.join(logDir, "cloudCommandAudit.log"), "utf8"),
      ""
    );
    // peek 未受影响
    assert.ok(fs.readFileSync(peekFile, "utf8").length > 0);
  });
});

test("clearLogs: target=all 清空全部", () => {
  withTempAuraDir((dir) => {
    const logDir = writeCloud(dir, [{ ts: "2026-01-01T00:00:01.000Z", url: "/a" }]);
    const peekFile = path.join(logDir, "screenPeekAudit.log");
    fs.writeFileSync(peekFile, "{}\n");

    const ipc = makeFakeIpcMain();
    applyAuditIpcHandler(ipc);
    const res = ipc.invoke("$aura.audit.clearLogs", {});

    assert.strictEqual(res.success, true);
    assert.strictEqual(
      fs.readFileSync(path.join(logDir, "cloudCommandAudit.log"), "utf8"),
      ""
    );
    assert.strictEqual(fs.readFileSync(peekFile, "utf8"), "");
  });
});
