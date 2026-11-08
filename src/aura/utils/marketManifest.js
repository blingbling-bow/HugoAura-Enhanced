// @ts-check

/**
 * 插件市场清单的解析与校验 (纯函数, 无 Electron 依赖, 便于单测)。
 *
 * 清单来自网络 (仓库 market/plugins.json), 属不可信输入: 逐条校验,
 * 单条脏数据直接跳过, 不让整个清单失效。字段长度截断取向与
 * pluginManager.validateManifest 一致 (homepage 仅接受 https)。
 */

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{2,63}$/;

/**
 * 校验并收敛一条市场条目; 不合法返回 null。
 * @param {any} entry
 * @returns {any | null}
 */
const sanitizeMarketEntry = (entry) => {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (!ID_PATTERN.test(id)) return null;
  const downloadUrl =
    typeof entry.downloadUrl === "string" ? entry.downloadUrl.trim() : "";
  if (!/^https?:\/\//i.test(downloadUrl)) return null;
  const version = typeof entry.version === "string" ? entry.version.trim() : "";
  if (!version || version.length > 32 || !/^[0-9A-Za-z.+\-]+$/.test(version)) {
    return null;
  }
  const str = (value, max) =>
    typeof value === "string" ? value.trim().slice(0, max) : "";
  const homepage = typeof entry.homepage === "string" ? entry.homepage.trim() : "";
  return {
    id,
    name: str(entry.name, 64) || id,
    version,
    author: str(entry.author, 64),
    description: str(entry.description, 200),
    type: entry.type === "ui" ? "ui" : "main",
    homepage: /^https:\/\//i.test(homepage) ? homepage : "",
    downloadUrl,
    // sha256 可选: 清单与包同源分发, 校验"清单↔包"一致性 (CDN 污染/截断防护)
    sha256:
      typeof entry.sha256 === "string" && /^[0-9a-fA-F]{64}$/.test(entry.sha256)
        ? entry.sha256.toLowerCase()
        : undefined,
  };
};

/**
 * 解析市场清单 JSON 文本, 返回合法条目数组 (非法清单返回空数组)。
 * @param {string} text
 * @returns {any[]}
 */
const parseMarketManifest = (text) => {
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items)) {
    return [];
  }
  return parsed.items.map(sanitizeMarketEntry).filter((item) => item !== null);
};

/**
 * 用本地已装插件标注市场条目的安装状态。
 * @param {any[]} items 市场条目
 * @param {{id: string, version: string}[]} installedPairs 已装插件 (id + 版本)
 * @returns {any[]}
 */
const enrichMarketItems = (items, installedPairs) => {
  const { compareVersion } = require("./auraVersion");
  const installed = new Map((installedPairs || []).map((p) => [p.id, p.version]));
  return items.map((item) => {
    const installedVersion = installed.get(item.id);
    if (!installedVersion) {
      return { ...item, installState: "available" };
    }
    const upgradable = compareVersion(item.version, installedVersion) > 0;
    return {
      ...item,
      installState: upgradable ? "upgradable" : "installed",
      installedVersion,
    };
  });
};

module.exports = { sanitizeMarketEntry, parseMarketManifest, enrichMarketItems };
