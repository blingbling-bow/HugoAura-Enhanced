// @ts-check

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseVersion, compareVersion, isNewer } = require("../src/aura/utils/auraVersion");

test("parseVersion 解析带 v 前缀与 rc 后缀", () => {
  assert.deepEqual(parseVersion("v0.2.0-rc2"), {
    major: 0,
    minor: 2,
    patch: 0,
    pre: ["rc2"],
  });
});

test("parseVersion 解析纯数字版本", () => {
  assert.deepEqual(parseVersion("1.2.3"), {
    major: 1,
    minor: 2,
    patch: 3,
    pre: [],
  });
});

test("parseVersion 解析多段预发布", () => {
  assert.deepEqual(parseVersion("v1.2.3-beta.4"), {
    major: 1,
    minor: 2,
    patch: 3,
    pre: ["beta", "4"],
  });
});

test("parseVersion 对非法输入返回 null", () => {
  assert.equal(parseVersion(""), null);
  assert.equal(parseVersion("v1.2"), null);
  assert.equal(parseVersion("abc"), null);
  assert.equal(parseVersion(null), null);
  assert.equal(parseVersion(undefined), null);
});

test("正式版大于 rc 预发布", () => {
  assert.equal(compareVersion("v0.2.0", "v0.2.0-rc2"), 1);
  assert.equal(isNewer("v0.2.0", "v0.2.0-rc2"), true);
});

test("rc3 大于 rc2", () => {
  assert.equal(compareVersion("v0.2.0-rc3", "v0.2.0-rc2"), 1);
});

test("rc10 按数值大于 rc2 (而非字符串比较)", () => {
  assert.equal(compareVersion("v0.2.0-rc10", "v0.2.0-rc2"), 1);
});

test("主版本号比较优先", () => {
  assert.equal(compareVersion("v0.3.0-rc1", "v0.2.9"), 1);
});

test("相同版本返回 0", () => {
  assert.equal(compareVersion("v0.2.0-rc2", "0.2.0-rc2"), 0);
});

test("无法解析的版本视为更旧", () => {
  assert.equal(compareVersion("invalid", "v0.2.0-rc2"), -1);
  assert.equal(compareVersion("v0.2.0-rc2", "invalid"), 1);
});
