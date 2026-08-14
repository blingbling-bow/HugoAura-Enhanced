// @ts-check

/**
 * HugoAura 版本号比较工具。
 *
 * 版本号形如 "v0.2.0-rc2"、"0.2.0"、"v1.2.3-beta.4"。
 * 规则遵循 semver 的预发布段语义:
 *   - 主/次/修订号按数值比较;
 *   - 不带预发布段的版本 > 带预发布段的版本;
 *   - 预发布段逐标识符比较, 纯数字标识符按数值比较。
 */

const VERSION_RE = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * @param {string} input
 * @returns {{ major: number, minor: number, patch: number, pre: string[] } | null}
 */
const parseVersion = (input) => {
  if (typeof input !== "string") return null;
  const match = String(input).trim().match(VERSION_RE);
  if (!match) return null;

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    pre: match[4] ? match[4].split(".") : [],
  };
};

/**
 * @param {number} a
 * @param {number} b
 * @returns {-1 | 0 | 1}
 */
const compareNumber = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 拆分字母数字标识符 (如 "rc10" -> prefix "rc", num 10)。
 * @param {string} id
 * @returns {{ prefix: string, num: number | null }}
 */
const splitIdentifier = (id) => {
  const match = id.match(/^(\D*)(\d*)$/);
  if (!match) return { prefix: id, num: null };
  return {
    prefix: match[1],
    num: match[2] === "" ? null : parseInt(match[2], 10),
  };
};

/**
 * 比较 semver 预发布段。
 * 对 "rc10" / "rc2" 这类常见后缀, 拆分字母前缀与数字后缀按数值比较,
 * 避免严格 semver 的 ASCII 字典序造成 rc10 < rc2 的反直觉结果。
 * @param {string[]} a
 * @param {string[]} b
 * @returns {-1 | 0 | 1}
 */
const comparePre = (a, b) => {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // 无预发布段 > 有预发布段
  if (b.length === 0) return -1;

  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;

    const leftIsNumber = /^\d+$/.test(left);
    const rightIsNumber = /^\d+$/.test(right);

    if (leftIsNumber && rightIsNumber) {
      const cmp = compareNumber(parseInt(left, 10), parseInt(right, 10));
      if (cmp !== 0) return cmp;
    } else if (leftIsNumber) {
      return -1; // 纯数字标识符 < 字母数字标识符
    } else if (rightIsNumber) {
      return 1;
    } else {
      const leftSplit = splitIdentifier(left);
      const rightSplit = splitIdentifier(right);
      if (
        leftSplit.prefix === rightSplit.prefix &&
        leftSplit.num !== null &&
        rightSplit.num !== null
      ) {
        const cmp = compareNumber(leftSplit.num, rightSplit.num);
        if (cmp !== 0) return cmp;
      }
      const cmp = left < right ? -1 : left > right ? 1 : 0;
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
};

/**
 * 比较两个版本号。无法解析的版本视为最小。
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
const compareVersion = (a, b) => {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);

  if (!parsedA && !parsedB) return 0;
  if (!parsedA) return -1;
  if (!parsedB) return 1;

  const coreCmp =
    compareNumber(parsedA.major, parsedB.major) ||
    compareNumber(parsedA.minor, parsedB.minor) ||
    compareNumber(parsedA.patch, parsedB.patch);

  if (coreCmp !== 0) return coreCmp;
  return comparePre(parsedA.pre, parsedB.pre);
};

/**
 * remote 是否比 current 新。
 * @param {string} remote
 * @param {string} current
 * @returns {boolean}
 */
const isNewer = (remote, current) => compareVersion(remote, current) > 0;

module.exports = { parseVersion, compareVersion, isNewer };
