// @ts-check

const crypto = require("crypto");

const PREFIX = "pbkdf2:v1:";
const ITERATIONS = 600000;
const KEY_LENGTH = 32;
const DIGEST = "sha256";
const SALT_LENGTH = 16;

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
  return `${PREFIX}${ITERATIONS}:${salt.toString("base64url")}:${derived.toString(
    "base64url"
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
      const salt = Buffer.from(parts[3], "base64url");
      const expected = Buffer.from(parts[4], "base64url");
      if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) {
        return { valid: false, needsUpgrade: false };
      }
      const actual = crypto.pbkdf2Sync(password, salt, iterations, KEY_LENGTH, DIGEST);
      const valid = crypto.timingSafeEqual(actual, expected);
      return {
        valid,
        needsUpgrade: valid && iterations < ITERATIONS,
      };
    } catch {
      return { valid: false, needsUpgrade: false };
    }
  }
  const legacy = crypto.createHash("sha512").update(password + legacySalt).digest("hex").toUpperCase();
  return { valid: legacy === stored.toUpperCase(), needsUpgrade: legacy === stored.toUpperCase() };
};

module.exports = { hashPassword, verifyPassword, PREFIX };
