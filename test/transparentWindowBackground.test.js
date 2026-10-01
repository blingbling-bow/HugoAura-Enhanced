// @ts-check

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  needsClearBackground,
} = require("../src/aura/mainProcess/hooks/transparentWindowBackground");

test("needsClearBackground 只把透明白当成需要清掉的底色", () => {
  assert.equal(needsClearBackground("#00FFFFFF"), true);
  assert.equal(needsClearBackground("#00ffffff"), true);
  assert.equal(needsClearBackground("#00FFffFF"), true);
});

test("needsClearBackground 保留不透明黑、全透明黑和空值", () => {
  assert.equal(needsClearBackground("#000000"), false);
  assert.equal(needsClearBackground("#00000000"), false);
  assert.equal(needsClearBackground(""), false);
  assert.equal(needsClearBackground(null), false);
  assert.equal(needsClearBackground(undefined), false);
});
