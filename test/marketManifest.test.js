// @ts-check

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  sanitizeMarketEntry,
  parseMarketManifest,
  enrichMarketItems,
} = require("../src/aura/utils/marketManifest");

const VALID_ENTRY = {
  id: "com.aura.test.main",
  name: "Aura 测试插件",
  version: "1.1.0",
  author: "HugoAura",
  description: "测试插件",
  type: "main",
  homepage: "https://github.com/blingbling-bow/HugoAura-Enhanced",
  downloadUrl: "https://cdn.jsdelivr.net/gh/x/y@dev/market/packages/p.zip",
};

test("sanitizeMarketEntry: 合法条目原样收敛", () => {
  const out = sanitizeMarketEntry(VALID_ENTRY);
  assert.ok(out);
  assert.equal(out.id, "com.aura.test.main");
  assert.equal(out.version, "1.1.0");
  assert.equal(out.type, "main");
});

test("sanitizeMarketEntry: 非法条目返回 null", () => {
  // 非对象
  assert.equal(sanitizeMarketEntry(null), null);
  assert.equal(sanitizeMarketEntry("x"), null);
  assert.equal(sanitizeMarketEntry([1]), null);
  // id 不合法
  assert.equal(sanitizeMarketEntry({ ...VALID_ENTRY, id: "1bad" }), null);
  assert.equal(sanitizeMarketEntry({ ...VALID_ENTRY, id: "" }), null);
  assert.equal(sanitizeMarketEntry({ ...VALID_ENTRY, id: "../evil" }), null);
  // downloadUrl 缺失 / 非 http(s)
  assert.equal(sanitizeMarketEntry({ ...VALID_ENTRY, downloadUrl: "" }), null);
  assert.equal(
    sanitizeMarketEntry({ ...VALID_ENTRY, downloadUrl: "ftp://x/y.zip" }),
    null
  );
  // version 缺失 / 非法字符
  assert.equal(sanitizeMarketEntry({ ...VALID_ENTRY, version: "" }), null);
  assert.equal(sanitizeMarketEntry({ ...VALID_ENTRY, version: "1.0; rm" }), null);
});

test("sanitizeMarketEntry: 字段收敛 (homepage 仅 https, 超长截断, type 归一)", () => {
  const out = sanitizeMarketEntry({
    ...VALID_ENTRY,
    homepage: "http://insecure.example.com",
    name: "N".repeat(200),
    type: "whatever",
  });
  assert.ok(out);
  assert.equal(out.homepage, "", "非 https homepage 应被丢弃");
  assert.equal(out.name.length, 64);
  assert.equal(out.type, "main");
});

test("parseMarketManifest: 合法清单解析, 脏条目跳过", () => {
  const text = JSON.stringify({
    version: 1,
    items: [
      VALID_ENTRY,
      { id: "bad id with space", downloadUrl: "https://x/y.zip", version: "1.0.0" },
      { id: "com.ok.ui", downloadUrl: "https://x/ui.zip", version: "2.0.0", type: "ui" },
      "not-an-object",
    ],
  });
  const items = parseMarketManifest(text);
  assert.equal(items.length, 2);
  assert.equal(items[0].id, "com.aura.test.main");
  assert.equal(items[1].id, "com.ok.ui");
  assert.equal(items[1].type, "ui");
});

test("parseMarketManifest: 非法 JSON / 缺 items 返回空数组", () => {
  assert.deepEqual(parseMarketManifest("not json"), []);
  assert.deepEqual(parseMarketManifest("{}"), []);
  assert.deepEqual(parseMarketManifest(JSON.stringify({ items: "x" })), []);
  assert.deepEqual(parseMarketManifest(JSON.stringify({ items: [] })), []);
});

test("enrichMarketItems: available / upgradable / installed 三态", () => {
  const items = [
    { id: "com.a", version: "1.1.0" },
    { id: "com.b", version: "2.0.0" },
    { id: "com.c", version: "1.0.0" },
  ];
  const installedPairs = [
    { id: "com.a", version: "1.1.0" }, // 同版本 → installed
    { id: "com.b", version: "1.0.0" }, // 市场 2.0.0 > 1.0.0 → upgradable
    // com.c 未安装 → available
  ];
  const out = enrichMarketItems(items, installedPairs);
  assert.equal(out[0].installState, "installed");
  assert.equal(out[0].installedVersion, "1.1.0");
  assert.equal(out[1].installState, "upgradable");
  assert.equal(out[1].installedVersion, "1.0.0");
  assert.equal(out[2].installState, "available");
  assert.equal(out[2].installedVersion, undefined);
});

test("enrichMarketItems: 市场版本低于已装时不算可更新", () => {
  const out = enrichMarketItems(
    [{ id: "com.a", version: "1.0.0" }],
    [{ id: "com.a", version: "1.1.0" }]
  );
  assert.equal(out[0].installState, "installed");
});
