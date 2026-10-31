// @ts-check

const crypto = require("crypto");

const PREFIX = "pbkdf2:v1:";
const ITERATIONS = 210000;
const KEY_LENGTH = 32;
const DIGEST = "sha256";
const SALT_LENGTH = 16;

/**
 * base64url 编码 (URL 安全, 去掉填充)。
 *
 * 不能直接用 Buffer 的 "base64url" 内置编码: 该编码是 Node 15.7 才加入的, 而宿主管家
 * 内置的 Electron / Node 版本更老, 会在编码时抛 "Unknown encoding: base64url" ——
 * 表现为"密码格式正确、也确实填了, 却始终设置不上, 开关也打不开"。
 * 这里手工转换, 输出与 Node 内置 base64url 完全一致, 已存的哈希仍然兼容。
 * @param {Buffer} buf
 * @returns {string}
 */
const base64UrlEncode = (buf) =>
  buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/**
 * base64url 解码: 先还原 +/ 字符并补齐填充, 再按标准 base64 解析。
 * 老版本 Node 的 Buffer 同样不认识 "base64url", 必须手工还原。
 * @param {string} str
 * @returns {Buffer}
 */
const base64UrlDecode = (str) => {
  const std = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (std.length % 4)) % 4;
  return Buffer.from(std + "=".repeat(padLen), "base64");
};

/**
 * Create a versioned, slow password verifier. The salt is stored with the
 * verifier; it is not a secret and is required for deterministic checking.
 * @param {string} password
 * @returns {string}
 */
const hashPassword = (password) => {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const derived = crypto.pbkdf2Sync(
    password,
    salt,
    ITERATIONS,
    KEY_LENGTH,
    DIGEST
  );
  return `${PREFIX}${ITERATIONS}:${base64UrlEncode(salt)}:${base64UrlEncode(
    derived
  )}`;
};

/**
 * Verify either the current PBKDF2 format or the legacy SHA-512 format.
 * @param {string} password
 * @param {string} stored
 * @param {string} legacySalt
 * @returns {{ valid: boolean, needsUpgrade: boolean }}
 */
const verifyPassword = (password, stored, legacySalt = "EndlessX") => {
  if (typeof password !== "string" || typeof stored !== "string") {
    return { valid: false, needsUpgrade: false };
  }
  if (stored.startsWith(PREFIX)) {
    const parts = stored.split(":");
    if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "v1") {
      return { valid: false, needsUpgrade: false };
    }
    const iterations = Number(parts[2]);
    if (!Number.isSafeInteger(iterations) || iterations < 100000 || iterations > 1000000) {
      return { valid: false, needsUpgrade: false };
    }
    try {
      const salt = base64UrlDecode(parts[3]);
      const expected = base64UrlDecode(parts[4]);
      if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) {
        return { valid: false, needsUpgrade: false };
      }
      const actual = crypto.pbkdf2Sync(password, salt, iterations, KEY_LENGTH, DIGEST);
      return {
        valid: crypto.timingSafeEqual(actual, expected),
        needsUpgrade: false,
      };
    } catch {
      return { valid: false, needsUpgrade: false };
    }
  }
  const legacy = crypto.createHash("sha512").update(password + legacySalt).digest("hex").toUpperCase();
  return { valid: legacy === stored.toUpperCase(), needsUpgrade: legacy === stored.toUpperCase() };
};

module.exports = { hashPassword, verifyPassword, PREFIX };
