// @ts-check
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const auditWriter = require("../src/aura/mainProcess/hooks/auditWriter.js");

const DAY = 24 * 3600 * 1000;

/** 建立临时 aura 目录并把 global.__HUGO_AURA__ 指过去 */
const withTempAuraDir = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-writer-"));
  const prev = global.__HUGO_AURA__;
  global.__HUGO_AURA__ = { auraDir: dir };
  try {
    return fn(dir);
  } finally {
    global.__HUGO_AURA__ = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const logPath = (dir, fileName) => path.join(dir, "logs", fileName);

const writeLines = (dir, fileName, lines) => {
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.writeFileSync(logPath(dir, fileName), lines.join("\n") + "\n", "utf8");
};

const readLines = (dir, fileName) =>
  fs
    .readFileSync(logPath(dir, fileName), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);

const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

test("filterExpired: 保留未过期行, 删除过期行, 损坏行一律保留", () => {
  const cutoff = Date.now();
  const content = [
    JSON.stringify({ ts: new Date(cutoff - DAY).toISOString(), n: "old" }),
    JSON.stringify({ ts: new Date(cutoff + DAY).toISOString(), n: "fresh" }),
    "{ 这不是 JSON",
    "",
    JSON.stringify({ n: "no-ts" }),
  ].join("\n");

  const { kept, removed } = auditWriter.filterExpired(content, cutoff);
  assert.strictEqual(removed, 1);
  const names = kept.map((line) => {
    try {
      return JSON.parse(line).n;
    } catch {
      return "<corrupt>";
    }
  });
  assert.deepStrictEqual(names, ["fresh", "<corrupt>", "no-ts"]);
  // 损坏行被原样保留 (宁可留着也不能因一行解析失败删掉整段历史)
  assert.ok(kept.includes("{ 这不是 JSON"));
});

test("cleanupExpired: 按保留天数重写文件并返回删除数", () => {
  withTempAuraDir((dir) => {
    const file = "cleanup-a.log";
    writeLines(dir, file, [
      JSON.stringify({ ts: iso(-10 * DAY), n: "old" }),
      JSON.stringify({ ts: iso(-2 * DAY), n: "recent" }),
      JSON.stringify({ ts: iso(0), n: "now" }),
    ]);

    const removed = auditWriter.cleanupExpired(file, 7);
    assert.strictEqual(removed, 1);

    const left = readLines(dir, file).map((l) => JSON.parse(l).n);
    assert.deepStrictEqual(left, ["recent", "now"]);
  });
});

test("cleanupExpired: 1 小时内重复调用被节流", () => {
  withTempAuraDir((dir) => {
    const file = "cleanup-b.log";
    writeLines(dir, file, [
      JSON.stringify({ ts: iso(-30 * DAY), n: "old" }),
    ]);

    // 第一次清理 (注入 now, 避免依赖真实时钟)
    const now = Date.now();
    assert.strictEqual(auditWriter.cleanupExpired(file, 7, now), 1);
    assert.strictEqual(readLines(dir, file).length, 0);

    // 再写一条过期记录, 节流窗口内不应再次清理
    fs.appendFileSync(
      logPath(dir, file),
      JSON.stringify({ ts: iso(-30 * DAY), n: "old2" }) + "\n"
    );
    assert.strictEqual(auditWriter.cleanupExpired(file, 7, now + 1000), 0);
    assert.strictEqual(readLines(dir, file).length, 1);

    // 超过节流窗口后恢复清理
    assert.strictEqual(
      auditWriter.cleanupExpired(file, 7, now + auditWriter.CLEANUP_INTERVAL_MS + 1),
      1
    );
    assert.strictEqual(readLines(dir, file).length, 0);
  });
});

test("cleanupExpired: retentionDays 非法时不动文件", () => {
  withTempAuraDir((dir) => {
    const file = "cleanup-c.log";
    writeLines(dir, file, [JSON.stringify({ ts: iso(-100 * DAY) })]);

    assert.strictEqual(auditWriter.cleanupExpired(file, 0), 0);
    assert.strictEqual(auditWriter.cleanupExpired(file, -1), 0);
    assert.strictEqual(auditWriter.cleanupExpired(file, NaN), 0);
    assert.strictEqual(auditWriter.cleanupExpired(file, undefined), 0);
    assert.strictEqual(readLines(dir, file).length, 1);
  });
});

test("writeAudit: 传 retentionDays 时顺带清理过期记录", () => {
  withTempAuraDir((dir) => {
    const file = "write-a.log";
    writeLines(dir, file, [JSON.stringify({ ts: iso(-30 * DAY), n: "old" })]);

    assert.strictEqual(
      auditWriter.writeAudit(file, { ts: iso(0), n: "new" }, { retentionDays: 7 }),
      true
    );

    const left = readLines(dir, file).map((l) => JSON.parse(l).n);
    assert.deepStrictEqual(left, ["new"]);
  });
});

test("writeAudit: 不传 retentionDays 时只追加, 不清理", () => {
  withTempAuraDir((dir) => {
    const file = "write-b.log";
    writeLines(dir, file, [JSON.stringify({ ts: iso(-30 * DAY), n: "old" })]);

    assert.strictEqual(auditWriter.writeAudit(file, { ts: iso(0), n: "new" }), true);

    const left = readLines(dir, file).map((l) => JSON.parse(l).n);
    assert.deepStrictEqual(left, ["old", "new"]);
  });
});

test("writeAudit: 首次写入 (文件不存在) 也能成功", () => {
  withTempAuraDir((dir) => {
    const file = "write-c.log";
    assert.strictEqual(auditWriter.writeAudit(file, { ts: iso(0), n: 1 }), true);
    assert.strictEqual(readLines(dir, file).length, 1);
  });
});
