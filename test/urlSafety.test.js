// @ts-check

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateUrl,
  isBlockedIp,
  isBlockedIpv4,
  isBlockedIpv6,
} = require("../src/aura/utils/urlSafety");

test("允许公网 https 域名", () => {
  const result = validateUrl("https://api-aura-projekts.delta.ooo/api/x");
  assert.equal(result.ok, true);
});

test("允许 http 域名", () => {
  const result = validateUrl("http://example.com/file.zip");
  assert.equal(result.ok, true);
});

test("拒绝非 http/https 协议", () => {
  const result = validateUrl("ftp://example.com/file");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "UNSAFE_PROTOCOL");
});

test("拒绝非法 URL", () => {
  const result = validateUrl("not a url");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "INVALID_URL");
});

test("拒绝 file 协议 (非 http/https)", () => {
  const result = validateUrl("file:///etc/passwd");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "UNSAFE_PROTOCOL");
});

test("IPv4 环回与私有地址被拦截", () => {
  assert.equal(isBlockedIpv4("127.0.0.1"), true);
  assert.equal(isBlockedIpv4("127.8.8.8"), true);
  assert.equal(isBlockedIpv4("10.0.0.5"), true);
  assert.equal(isBlockedIpv4("172.16.0.1"), true);
  assert.equal(isBlockedIpv4("172.31.255.255"), true);
  assert.equal(isBlockedIpv4("192.168.1.1"), true);
  assert.equal(isBlockedIpv4("169.254.0.1"), true);
  assert.equal(isBlockedIpv4("100.64.0.1"), true);
  assert.equal(isBlockedIpv4("8.8.8.8"), false);
  assert.equal(isBlockedIpv4("1.1.1.1"), false);
});

test("IPv4 保留与测试网段被拦截", () => {
  assert.equal(isBlockedIpv4("0.0.0.0"), true);
  assert.equal(isBlockedIpv4("192.0.2.1"), true);
  assert.equal(isBlockedIpv4("198.51.100.1"), true);
  assert.equal(isBlockedIpv4("203.0.113.1"), true);
  assert.equal(isBlockedIpv4("224.0.0.1"), true);
  assert.equal(isBlockedIpv4("240.0.0.1"), true);
});

test("IPv6 环回 / 链路本地 / 唯一本地 / 组播被拦截", () => {
  assert.equal(isBlockedIpv6("::1"), true);
  assert.equal(isBlockedIpv6("fe80::1"), true);
  assert.equal(isBlockedIpv6("fd00::1"), true);
  assert.equal(isBlockedIpv6("ff02::1"), true);
});

test("IPv4 映射 IPv6 环回被拦截", () => {
  assert.equal(isBlockedIpv6("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedIpv6("::ffff:8.8.8.8"), false);
});

test("isBlockedIp 区分 IPv4 与 IPv6", () => {
  assert.equal(isBlockedIp("127.0.0.1"), true);
  assert.equal(isBlockedIp("::1"), true);
  assert.equal(isBlockedIp("8.8.8.8"), false);
  assert.equal(isBlockedIp("2606:4700:4700::1111"), false);
});

test("URL 中直接内嵌内网地址被拦截", () => {
  const result = validateUrl("https://127.0.0.1/api");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "BLOCKED_ADDRESS");
});
