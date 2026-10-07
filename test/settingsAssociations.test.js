// @ts-check
"use strict";

/**
 * 设置项关联路径回归测试 (Issue #8)
 *
 * 背景: 设置项的显隐由 auraIf() 判定, 但渲染器只在 associateVal 里
 * 精确登记的配置路径变化时才重新判定。auth.js 的「禁用屏幕锁」
 * (fastfailScreenLock) 的 auraIf 依赖 rewrite.vendor/screenLock.enabled,
 * associateVal 却只登记了自己的 fastfail —— 关闭「启用屏幕锁覆写」后
 * 再开启「禁用屏幕锁」, auraIf 会按过期的 enabled=false 把这一行隐藏,
 * 且重新打开覆写也不会再判定, 开关永久消失 (Issue #8)。
 *
 * 本测试用 settingsRenderer 相同的判定规则扫描全部设置文件,
 * 防止同类问题再次提交进来。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const checker = require("../scripts/check-settings-associations.js");

const settingsDir = path.join(
  __dirname,
  "..",
  "src",
  "aura",
  "ui",
  "pages",
  "configSubPages"
);

const collectFiles = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
};

test("回归(Issue #8): 检查器能抓到 associateVal 缺登记的模式", () => {
  const bad = `
      {
        id: "fastfailScreenLock",
        associateVal: ["rewrite.vendor/screenLock.fastfail"],
        auraIf: () => {
          return global.__HUGO_AURA_CONFIG__.rewrite["vendor/screenLock"]
            .enabled;
        },
        valueGetter: () => true,
        callbackFn: (newVal) => {},
      },
  `;
  const problems = checker.checkSource(bad, "synthetic-bad");
  assert.strictEqual(problems.length, 1, "应抓到缺失的 enabled");
  assert.strictEqual(problems[0].referenced, "rewrite.vendor/screenLock.enabled");
});

test("回归: 关联路径登记完整时不应误报", () => {
  const good = `
      {
        id: "fastfailScreenLock",
        associateVal: [
          "rewrite.vendor/screenLock.enabled",
          "rewrite.vendor/screenLock.fastfail",
        ],
        auraIf: () => {
          return global.__HUGO_AURA_CONFIG__.rewrite["vendor/screenLock"]
            .enabled;
        },
        valueGetter: () => true,
        callbackFn: (newVal) => {},
      },
  `;
  assert.strictEqual(checker.checkSource(good, "synthetic-good").length, 0);
});

test("父对象读取 (cfg 父对象再取字段) 不应误报", () => {
  const parentRead = `
      {
        associateVal: ["auraSettings.lockScreenIntercept.enabled"],
        auraIf: () => {
          const cfg =
            global.__HUGO_AURA_CONFIG__.auraSettings.lockScreenIntercept;
          return !cfg || !cfg.enabled;
        },
        valueGetter: () => true,
        callbackFn: (newVal) => {},
      },
  `;
  assert.strictEqual(checker.checkSource(parentRead, "parent").length, 0);
});

test("全部设置文件的 auraIf 读取路径都已登记进 associateVal", () => {
  let problems = [];
  for (const file of collectFiles(settingsDir)) {
    const rel = path.relative(path.join(__dirname, ".."), file);
    problems = problems.concat(
      checker.checkSource(fs.readFileSync(file, "utf8"), rel)
    );
  }
  assert.deepStrictEqual(
    problems.map((p) => `${p.path}: ${p.referenced}`),
    [],
    "以下设置项的 auraIf 读取了未登记进 associateVal 的配置路径"
  );
});
