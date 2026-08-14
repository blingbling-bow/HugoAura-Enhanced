// @ts-check

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  pickLatestRelease,
  evaluateRelease,
  openReleasePage,
} = require("../src/aura/init/main/ipcModules/auraUpdateIpcHandler");

test("pickLatestRelease 优先稳定版", () => {
  const releases = [
    { tag_name: "v0.3.0", prerelease: false, name: "v0.3.0" },
    { tag_name: "v0.4.0-rc1", prerelease: true, name: "v0.4.0-rc1" },
  ];
  assert.equal(pickLatestRelease(releases).tag_name, "v0.3.0");
});

test("pickLatestRelease 无稳定版时退回非 CI 预发布", () => {
  const releases = [
    { tag_name: "v0.4.0-rc1", prerelease: true, name: "v0.4.0-rc1" },
  ];
  assert.equal(pickLatestRelease(releases).tag_name, "v0.4.0-rc1");
});

test("pickLatestRelease 排除 CI 构建", () => {
  const releases = [
    { tag_name: "vAutoBuild-x", prerelease: true, name: "[CI] HugoAura Auto Build" },
    { tag_name: "v0.4.0-rc1", prerelease: true, name: "v0.4.0-rc1" },
  ];
  assert.equal(pickLatestRelease(releases).tag_name, "v0.4.0-rc1");
});

test("evaluateRelease 远端更新时 hasUpdate 为 true", () => {
  const result = evaluateRelease(
    { tag_name: "v0.2.0-rc3", name: "v0.2.0-rc3" },
    "v0.2.0-rc2"
  );
  assert.equal(result.ok, true);
  assert.equal(result.hasUpdate, true);
  assert.equal(result.remoteVersion, "v0.2.0-rc3");
});

test("evaluateRelease 相同或更旧时 hasUpdate 为 false", () => {
  assert.equal(
    evaluateRelease({ tag_name: "v0.2.0-rc2" }, "v0.2.0-rc2").hasUpdate,
    false
  );
  assert.equal(
    evaluateRelease({ tag_name: "v0.2.0-rc2" }, "v0.2.0").hasUpdate,
    false
  );
});

test("evaluateRelease 非法 release 返回 error", () => {
  assert.equal(evaluateRelease(null, "v0.2.0-rc2").ok, false);
  assert.equal(evaluateRelease({}, "v0.2.0-rc2").ok, false);
});

test("openReleasePage 拒绝内网地址且不调用 openExternal", async () => {
  let called = false;
  const result = await openReleasePage("https://127.0.0.1/release", {
    openExternal: async () => {
      called = true;
    },
  });
  assert.equal(result.success, false);
  assert.equal(called, false);
});
