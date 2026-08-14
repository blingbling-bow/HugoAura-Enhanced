// @ts-check

/**
 * 更新请求 URL 安全校验 (防 SSRF)。
 *
 * 仅允许 http / https, 并在发请求前解析 hostname 的 DNS 结果,
 * 拒绝 localhost、环回、链路本地、私有、保留地址。
 *
 * 注意: 纯函数部分 (validateUrl / isBlockedIp*) 不触发网络, 便于单测;
 * validateUrlResolved 会做真实 DNS 解析, 供主进程更新客户端使用。
 */

const dns = require("dns");

/**
 * @param {string} ip
 * @returns {number | null}
 */
const ipv4ToInt = (ip) => {
  const parts = ip.split(".").map((n) => Number(n));
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return null;
  }
  return (
    ((parts[0] << 24) >>> 0) +
    ((parts[1] << 16) >>> 0) +
    ((parts[2] << 8) >>> 0) +
    parts[3]
  );
};

/**
 * @param {string} ip
 * @param {string} base
 * @param {number} bits
 * @returns {boolean}
 */
const inV4Range = (ip, base, bits) => {
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
};

/** @type {[string, number][]} */
const BLOCKED_IPV4_RANGES = [
  ["0.0.0.0", 8], // 本网络
  ["10.0.0.0", 8], // 私有
  ["100.64.0.0", 10], // CGNAT 共享地址
  ["127.0.0.0", 8], // 环回
  ["169.254.0.0", 16], // 链路本地
  ["172.16.0.0", 12], // 私有
  ["192.0.0.0", 24], // IETF 协议保留
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // 私有
  ["198.18.0.0", 15], // 基准测试
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // 组播
  ["240.0.0.0", 4], // 保留
];

/**
 * @param {string} ip
 * @returns {boolean}
 */
const isBlockedIpv4 = (ip) => {
  const normalized = String(ip || "").trim().split("%")[0];
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(normalized)) return false;
  return BLOCKED_IPV4_RANGES.some(([base, bits]) =>
    inV4Range(normalized, base, bits)
  );
};

/**
 * @param {string} ip
 * @returns {boolean}
 */
const isBlockedIpv6 = (ip) => {
  const normalized = String(ip || "").trim().toLowerCase().split("%")[0];
  if (normalized === "::" || normalized === "::0" || normalized === "::1") {
    return true;
  }
  // fe80::/10 链路本地
  if (/^fe[89ab]/.test(normalized)) return true;
  // fc00::/7 唯一本地
  if (/^f[cd]/.test(normalized)) return true;
  // ff00::/8 组播
  if (/^ff/.test(normalized)) return true;
  // IPv4 映射地址
  if (normalized.startsWith("::ffff:")) {
    return isBlockedIpv4(normalized.slice("::ffff:".length));
  }
  return false;
};

/**
 * @param {string} ip
 * @returns {boolean}
 */
const isBlockedIp = (ip) => {
  const normalized = String(ip || "").trim();
  if (!normalized) return false;
  return normalized.includes(":") ? isBlockedIpv6(normalized) : isBlockedIpv4(normalized);
};

/**
 * @param {string} value
 * @returns {URL | null}
 */
const parseUrl = (value) => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/**
 * 同步校验 URL 形态 (不触发 DNS)。
 * @param {string} value
 * @returns {{ ok: true, url: URL } | { ok: false, reason: string }}
 */
const validateUrl = (value) => {
  const url = parseUrl(value);
  if (!url) return { ok: false, reason: "INVALID_URL" };
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "UNSAFE_PROTOCOL" };
  }
  if (!url.hostname) return { ok: false, reason: "NO_HOST" };
  if (isBlockedIp(url.hostname)) return { ok: false, reason: "BLOCKED_ADDRESS" };
  return { ok: true, url };
};

/**
 * 解析 hostname 并校验所有返回地址 (防 DNS 重绑定)。
 * @param {string} value
 * @returns {Promise<{ ok: true, url: URL } | { ok: false, reason: string, url?: URL }>}
 */
const validateUrlResolved = (value) => {
  const base = validateUrl(value);
  if (!base.ok) return Promise.resolve(base);

  return new Promise((resolve) => {
    dns.lookup(base.url.hostname, { all: true }, (err, addresses) => {
      if (err) {
        resolve({ ok: false, reason: "DNS_FAILED", url: base.url });
        return;
      }
      for (const record of addresses) {
        if (isBlockedIp(record.address)) {
          resolve({ ok: false, reason: "BLOCKED_ADDRESS", url: base.url });
          return;
        }
      }
      resolve({ ok: true, url: base.url });
    });
  });
};

module.exports = {
  validateUrl,
  validateUrlResolved,
  parseUrl,
  isBlockedIp,
  isBlockedIpv4,
  isBlockedIpv6,
};
