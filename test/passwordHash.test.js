// @ts-check

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const {
  hashPassword,
  verifyPassword,
  PREFIX,
} = require("../src/aura/utils/passwordHash");

test("hashPassword → verifyPassword 往返校验通过, 且不需要升级", () => {
  const stored = hashPassword("CorrectPass123");
  assert.ok(stored.startsWith(PREFIX));

  const result = verifyPassword("CorrectPass123", stored);
  assert.equal(result.valid, true);
  assert.equal(result.needsUpgrade, false);
});

test("verifyPassword 拒绝错误密码", () => {
  const stored = hashPassword("CorrectPass123");
  const result = verifyPassword("WrongPass456", stored);
  assert.equal(result.valid, false);
  assert.equal(result.needsUpgrade, false);
});

test("旧版 SHA-512 哈希仍可校验, 且标记 needsUpgrade", () => {
  const legacy = crypto
    .createHash("sha512")
    .update("LegacyPass123" + "EndlessX")
    .digest("hex")
    .toUpperCase();

  const result = verifyPassword("LegacyPass123", legacy);
  assert.equal(result.valid, true);
  assert.equal(result.needsUpgrade, true);
});

test("老版本 Node (Buffer 不认识 base64url) 下 hashPassword / verifyPassword 仍可用", () => {
  // 宿主管家内置的 Electron / Node 比 15.7 老, Buffer 不支持 "base64url",
  // 真实故障就是在这里抛 "Unknown encoding: base64url", 导致密码永远存不上。
  const originalToString = Buffer.prototype.toString;
  Buffer.prototype.toString = function (encoding, ...rest) {
    if (encoding === "base64url") {
      throw new TypeError("Unknown encoding: base64url");
    }
    return originalToString.call(this, encoding, ...rest);
  };
  try {
    const stored = hashPassword("CorrectPass123");
    assert.equal(verifyPassword("CorrectPass123", stored).valid, true);
    assert.equal(verifyPassword("WrongPass456", stored).valid, false);
    assert.ok(
      !/[+/=]/.test(stored),
      "哈希必须是 URL 安全且无填充的 (与内置 base64url 输出一致)"
    );
  } finally {
    Buffer.prototype.toString = originalToString;
  }
});

test("非法存储格式不抛异常, 直接判为不通过", () => {
  assert.deepEqual(verifyPassword("x", "pbkdf2:v1:not-a-real-hash"), {
    valid: false,
    needsUpgrade: false,
  });
  assert.deepEqual(verifyPassword("x", "pbkdf2:v1:a:b:c:d:e"), {
    valid: false,
    needsUpgrade: false,
  });
  // @ts-expect-error 非字符串入参
  assert.equal(verifyPassword(null, "x").valid, false);
  // @ts-expect-error 非字符串入参
  assert.equal(verifyPassword("x", 123).valid, false);
});
