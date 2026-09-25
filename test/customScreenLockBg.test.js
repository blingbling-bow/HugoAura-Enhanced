// @ts-check

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ruleFn,
} = require("../src/aura/jsRewrite/network/appearance/customScreenLockBg");

const BEGIN_ANCHOR = "t.handleListenScreenLockSource=function(e){var n=";
const END_ANCHOR = ";Object(S.a)(n,function(e){var n=P(e||{})";

// 含两个锚点的最小样例, 中间那段即真实 screenLock.js 中被替换掉的原始表达式
const SAMPLE = BEGIN_ANCHOR + '"file:///"+e.picture[0]' + END_ANCHOR + "{});";

const makeConfig = (enabled, backgroundPath) => ({
  networkRewrite: {
    "appearance/customScreenLockBg": { enabled, backgroundPath },
  },
});

// 取出替换后位于两锚点之间的注入表达式, 并在给定上下文里求值
const runInjected = (content, picture, ruleConfig) => {
  const beginIdx = content.indexOf(BEGIN_ANCHOR);
  const endIdx = content.indexOf(END_ANCHOR, beginIdx);
  assert.notEqual(beginIdx, -1, "替换后应仍能定位起始锚点");
  assert.notEqual(endIdx, -1, "替换后应仍能定位结束锚点");

  const injected = content.slice(beginIdx + BEGIN_ANCHOR.length, endIdx);
  const window = { __HUGO_AURA_CONFIG__: ruleConfig };
  const value = new Function("e", "window", `return ${injected}`)(
    { picture },
    window
  );
  return { injected, value };
};

test("锚点缺失时原样返回, 不破坏内容", () => {
  const unrelated = "var a=1;function b(){return a}";
  const result = ruleFn(unrelated, makeConfig(true, "C:\\bg.png"));
  assert.equal(result, unrelated);
});

test("锚点存在时替换掉原表达式并保留锚点", () => {
  const config = makeConfig(true, "C:\\bg.png");
  const result = ruleFn(SAMPLE, config);

  assert.notEqual(result, SAMPLE, "应发生替换");
  assert.ok(result.startsWith(BEGIN_ANCHOR), "起始锚点前的结构应保留");
  assert.ok(result.endsWith(`${END_ANCHOR}{});`), "结束锚点后的结构应保留");
  assert.notEqual(
    runInjected(result, ["C:\\pic.png"], config).injected,
    '"file:///"+e.picture[0]',
    "锚点之间的原表达式应被替换"
  );
});

test("启用自定义背景且为 http(s) 地址时直接返回该地址", () => {
  const config = makeConfig(true, "https://example.com/bg.png");
  const result = ruleFn(SAMPLE, config);

  assert.equal(
    runInjected(result, ["C:\\pic.png"], config).value,
    "https://example.com/bg.png"
  );
});

test("启用自定义背景且为本地路径时输出 file:/// 并转义反斜杠", () => {
  const config = makeConfig(true, "C:\\bg.png");
  const result = ruleFn(SAMPLE, config);

  assert.equal(
    runInjected(result, ["C:\\pic.png"], config).value,
    "file:///C:\\\\bg.png"
  );
});

test("未启用自定义背景时回退到管家下发的 picture", () => {
  const config = makeConfig(false, "C:\\bg.png");
  const result = ruleFn(SAMPLE, config);

  assert.equal(
    runInjected(result, ["C:\\pic.png"], config).value,
    "file:///C:\\\\pic.png"
  );
});

test("无 picture 且未配置自定义背景时返回空串", () => {
  const config = makeConfig(false, "");
  const result = ruleFn(SAMPLE, config);

  assert.equal(runInjected(result, undefined, config).value, "");
});
