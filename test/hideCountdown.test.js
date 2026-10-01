// @ts-check

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isCountdownUrl,
} = require("../src/aura/mainProcess/hooks/hideCountdown");

test("isCountdownUrl 识别倒计日页面", () => {
  assert.equal(
    isCountdownUrl("file:///C:/app/public/countdown.html"),
    true
  );
  assert.equal(
    isCountdownUrl("file:///C:/app/public/countdown.html?windowName=countdown"),
    true
  );
  assert.equal(
    isCountdownUrl("C:\\Seewo\\resources\\app.asar\\public\\countdown.html"),
    true
  );
});

test("isCountdownUrl 不误伤其它页面", () => {
  assert.equal(isCountdownUrl("file:///C:/app/public/assistant.html"), false);
  assert.equal(
    isCountdownUrl("file:///C:/app/public/countdownExtra.html"),
    false
  );
  assert.equal(isCountdownUrl(""), false);
  assert.equal(isCountdownUrl(null), false);
  assert.equal(isCountdownUrl(undefined), false);
});
