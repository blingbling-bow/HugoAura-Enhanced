const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  getExpectedInstallerSha256,
  isTrustedInstallerUrl,
  calculateFileSha256,
  sha256Matches,
} = require("../src/aura/init/main/ipcModules/aikariIpcHandler");

const SAMPLE_SHA256 = "a".repeat(64);

test("Aikari 安装器只允许无凭据的 HTTPS URL", () => {
  assert.equal(isTrustedInstallerUrl("https://example.com/a.exe"), true);
  assert.equal(isTrustedInstallerUrl("http://example.com/a.exe"), false);
  assert.equal(
    isTrustedInstallerUrl("https://user:pass@example.com/a.exe"),
    false
  );
  assert.equal(isTrustedInstallerUrl("not-a-url"), false);
});

test("Aikari 发布信息必须包含对应架构的合法 SHA-256", () => {
  assert.equal(
    getExpectedInstallerSha256({ sha256: { x64: SAMPLE_SHA256 } }, "x64"),
    SAMPLE_SHA256
  );
  assert.equal(getExpectedInstallerSha256({ sha256: {} }, "x64"), null);
  assert.equal(
    getExpectedInstallerSha256({ sha256: { x64: "invalid" } }, "x64"),
    null
  );
});

test("Aikari 安装器文件 SHA-256 可计算并恒定时间比较", async () => {
  const filePath = path.join(os.tmpdir(), `hugoaura-hash-${process.pid}.bin`);
  fs.writeFileSync(filePath, "HugoAura Aikari installer test", "utf8");
  try {
    const actual = await calculateFileSha256(filePath);
    assert.equal(actual.length, 64);
    assert.equal(sha256Matches(actual.toUpperCase(), actual), true);
    assert.equal(sha256Matches("0".repeat(64), actual), false);
  } finally {
    fs.unlinkSync(filePath);
  }
});
