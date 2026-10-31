// @ts-check

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildReplacePlan,
  applyCustomScreenSaver,
  restoreScreenSaver,
  isEnabled,
  IMAGE_EXT_RE,
} = require("../src/aura/mainProcess/hooks/customScreenSaver");

const makeTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aura-ss-test-"));

const writeImage = (dir, name, content = "img") =>
  fs.writeFileSync(path.join(dir, name), content);

test("buildReplacePlan: 保持目标文件名, 源图循环取用", () => {
  const plan = buildReplacePlan(
    ["a.jpg", "b.jpg", "c.jpg", "d.jpg"],
    ["x.png", "y.jpg"]
  );
  assert.deepEqual(
    plan.map((p) => p.targetName),
    ["a.jpg", "b.jpg", "c.jpg", "d.jpg"]
  );
  assert.deepEqual(
    plan.map((p) => p.sourceName),
    ["x.png", "y.jpg", "x.png", "y.jpg"]
  );
});

test("buildReplacePlan: 空输入返回空计划", () => {
  assert.deepEqual(buildReplacePlan([], ["x.png"]), []);
  assert.deepEqual(buildReplacePlan(["a.jpg"], []), []);
});

test("IMAGE_EXT_RE: 支持 jpg/jpeg/png, 忽略大小写", () => {
  assert.ok(IMAGE_EXT_RE.test("a.jpg"));
  assert.ok(IMAGE_EXT_RE.test("a.JPEG"));
  assert.ok(IMAGE_EXT_RE.test("a.png"));
  assert.ok(!IMAGE_EXT_RE.test("a.gif"));
  assert.ok(!IMAGE_EXT_RE.test("a.jpg.txt"));
});

test("applyCustomScreenSaver: 首次替换备份原图并按计划覆盖", () => {
  const root = makeTmp();
  const targetDir = path.join(root, "target");
  const sourceDir = path.join(root, "source");
  const backupDir = path.join(sourceDir, "backup_original");
  fs.mkdirSync(targetDir);
  fs.mkdirSync(sourceDir);
  writeImage(targetDir, "seewo_1.jpg", "original1");
  writeImage(targetDir, "seewo_2.jpg", "original2");
  writeImage(sourceDir, "mine.png", "customA");
  writeImage(sourceDir, "mine2.jpg", "customB");

  const res = applyCustomScreenSaver({ targetDir, sourceDir, backupDir });
  assert.equal(res.replaced, 2);
  assert.equal(res.backupCreated, true);
  // 原文件名保留, 内容被自备图覆盖 (循环: seewo_1<-mine.png, seewo_2<-mine2.jpg)
  assert.equal(fs.readFileSync(path.join(targetDir, "seewo_1.jpg"), "utf8"), "customA");
  assert.equal(fs.readFileSync(path.join(targetDir, "seewo_2.jpg"), "utf8"), "customB");
  // 备份里是原图
  assert.equal(fs.readFileSync(path.join(backupDir, "seewo_1.jpg"), "utf8"), "original1");
  assert.equal(fs.readFileSync(path.join(backupDir, "seewo_2.jpg"), "utf8"), "original2");

  // 二次替换: 不覆盖备份
  const res2 = applyCustomScreenSaver({ targetDir, sourceDir, backupDir });
  assert.equal(res2.backupCreated, false);
  assert.equal(fs.readFileSync(path.join(backupDir, "seewo_1.jpg"), "utf8"), "original1");
  fs.rmSync(root, { recursive: true, force: true });
});

test("applyCustomScreenSaver: 目标目录缺失 / 无源图 抛类型化错误", () => {
  const root = makeTmp();
  const sourceDir = path.join(root, "source");
  fs.mkdirSync(sourceDir);
  assert.throws(
    () => applyCustomScreenSaver({ targetDir: path.join(root, "nope"), sourceDir }),
    /TARGET_DIR_NOT_FOUND/
  );

  const targetDir = path.join(root, "target");
  fs.mkdirSync(targetDir);
  writeImage(targetDir, "x.jpg", "o");
  assert.throws(
    () => applyCustomScreenSaver({ targetDir, sourceDir }),
    /NO_SOURCE_IMAGES/
  );

  // 只有子目录/非图片文件也算无源图
  fs.mkdirSync(path.join(sourceDir, "sub"));
  writeImage(sourceDir, "notes.txt", "t");
  assert.throws(
    () => applyCustomScreenSaver({ targetDir, sourceDir }),
    /NO_SOURCE_IMAGES/
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("restoreScreenSaver: 备份存在时还原原图", () => {
  const root = makeTmp();
  const targetDir = path.join(root, "target");
  const sourceDir = path.join(root, "source");
  const backupDir = path.join(sourceDir, "backup_original");
  fs.mkdirSync(targetDir);
  fs.mkdirSync(sourceDir);
  writeImage(targetDir, "s.jpg", "original");
  writeImage(sourceDir, "m.png", "custom");

  applyCustomScreenSaver({ targetDir, sourceDir, backupDir });
  assert.equal(
    fs.readFileSync(path.join(targetDir, "s.jpg"), "utf8"),
    "custom"
  );

  const res = restoreScreenSaver({ targetDir, sourceDir, backupDir });
  assert.equal(res.restored, 1);
  assert.equal(res.backupHadFiles, true);
  assert.equal(
    fs.readFileSync(path.join(targetDir, "s.jpg"), "utf8"),
    "original"
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("restoreScreenSaver: 从未替换过 (无备份) 时安全返回", () => {
  const root = makeTmp();
  const targetDir = path.join(root, "target");
  const sourceDir = path.join(root, "source");
  fs.mkdirSync(targetDir);
  fs.mkdirSync(sourceDir);
  writeImage(targetDir, "s.jpg", "original");

  const res = restoreScreenSaver({ targetDir, sourceDir });
  assert.deepEqual(res, { restored: 0, backupHadFiles: false });
  assert.equal(fs.readFileSync(path.join(targetDir, "s.jpg"), "utf8"), "original");
  fs.rmSync(root, { recursive: true, force: true });
});

test("isEnabled: 配置缺失安全回退 false", () => {
  const saved = global.__HUGO_AURA_CONFIG__;
  try {
    delete global.__HUGO_AURA_CONFIG__;
    assert.equal(isEnabled(), false);
    global.__HUGO_AURA_CONFIG__ = { auraSettings: { customScreenSaver: { enabled: true } } };
    assert.equal(isEnabled(), true);
    global.__HUGO_AURA_CONFIG__ = { auraSettings: {} };
    assert.equal(isEnabled(), false);
  } finally {
    global.__HUGO_AURA_CONFIG__ = saved;
  }
});
