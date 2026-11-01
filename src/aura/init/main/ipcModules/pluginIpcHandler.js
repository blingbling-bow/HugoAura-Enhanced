// @ts-check

/**
 * 插件系统 IPC ($aura.plugin)。
 *
 * 两段式安装 (插件包来自网络或他人, manifest 必须先给用户过目):
 *   1. installLocal / installFromUrl -> 下载(在线) + 解压到临时目录 +
 *      解析 manifest -> 返回 { stageId, manifest }, 此时插件尚未生效;
 *   2. 渲染层展示摘要, 用户确认后 confirmInstall {stageId} 才真正落盘;
 *      cancelInstall {stageId} 丢弃暂存。
 *
 * 安全:
 *   - 在线导入的 URL (含每一跳重定向) 一律先过 urlSafety 校验
 *     (仅 http/https, 拒绝 localhost / 内网 / 保留地址);
 *   - zip 条目路径穿越 / 条目数 / 解压体积防护见 utils/zip.js;
 *   - manifest 结构校验复用 pluginManager.validateManifest;
 *   - 覆盖安装: 已装同 id 时用 compareVersion 拒绝降级。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const nodeHttp = require("http");
const nodeHttps = require("https");

const { dialog, shell } = require("electron");

const { validateUrlResolved } = require("../../../utils/urlSafety");
const { unzipToDir } = require("../../../utils/zip");
const { compareVersion } = require("../../../utils/auraVersion");
const { genRandomHex } = require("../../../utils/crypto");
const { parseMarketManifest, enrichMarketItems } = require("../../../utils/marketManifest");
const pluginManager = require("../pluginManager");

const INSTALL_PROGRESS_CHANNEL = "$aura.plugin.post.installProgress";
const DOWNLOAD_MAX_REDIRECTS = 5;
const STAGE_TTL_MS = 30 * 60 * 1000;

/** 市场清单数据源 (按顺序尝试): jsDelivr 对国内网络更友好, raw 兜底, 最后包内本地文件 (离线可用) */
const MARKET_SOURCES = [
  "https://cdn.jsdelivr.net/gh/blingbling-bow/HugoAura-Enhanced@dev/src/aura/market/plugins.json",
  // 插件功能尚未合并到 dev 时的过渡源 (合并后此条 404 会自动跳过)
  "https://cdn.jsdelivr.net/gh/blingbling-bow/HugoAura-Enhanced@feature/plugins/src/aura/market/plugins.json",
  "https://raw.githubusercontent.com/blingbling-bow/HugoAura-Enhanced/dev/src/aura/market/plugins.json",
];
/** 本地源标识 (非 URL, fetchMarketManifest 按此走文件读取) */
const MARKET_LOCAL_SOURCE = "local";
const MARKET_CACHE_TTL_MS = 10 * 60 * 1000;

/** aura 包根 (init/../..), market/ 内置清单与插件包位于其下 */
const auraPackageRoot = () => path.join(__dirname, "..", "..", "..");
const marketPackagesDir = () =>
  path.join(auraPackageRoot(), "market", "packages");

/** @type {{at: number, items: any[], source: string} | null} */
let marketCache = null;

/** @type {Map<string, {dir: string, manifestDir: string, manifest: any, createdAt: number}>} */
const stagedInstalls = new Map();

const pluginsRoot = () => path.join(global.__HUGO_AURA__.auraDir, "plugins");

/**
 * 校验文件 sha256 (expected 为 64 位 hex; 未提供则跳过; 不匹配抛错)。
 * 市场安装链的完整性校验: 清单与包同源分发, 校验的是"清单↔包"一致性,
 * 防止 CDN 缓存污染 / 下载截断 / 半更新的清单指向旧包。
 * @param {string} filePath
 * @param {string | undefined} expected
 */
const verifyFileSha256 = (filePath, expected) => {
  if (!expected) return true;
  if (typeof expected !== "string" || !/^[0-9a-fA-F]{64}$/.test(expected)) {
    throw new Error("INVALID_SHA256");
  }
  const actual = crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
  if (actual !== expected.toLowerCase()) {
    throw new Error(`SHA256_MISMATCH: actual ${actual.slice(0, 16)}…`);
  }
  return true;
};

// >>> 旧运行时兼容 (管家 Node 可能 < 16.7, 无 fs.rmSync / fs.cpSync) <<<
// 仓库既有代码均只用老 API (unlinkSync/copyFileSync), 此处保持一致。

/** @param {string} p */
const removePathRecursive = (p) => {
  if (typeof fs.rmSync === "function") {
    fs.rmSync(p, { recursive: true, force: true });
    return;
  }
  if (!fs.existsSync(p)) return;
  const stat = fs.lstatSync(p);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(p)) {
      removePathRecursive(path.join(p, name));
    }
    fs.rmdirSync(p);
  } else {
    fs.unlinkSync(p);
  }
};

/** @param {string} src @param {string} dest */
const copyPathRecursive = (src, dest) => {
  if (typeof fs.cpSync === "function") {
    fs.cpSync(src, dest, { recursive: true });
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    fs.lstatSync(from).isDirectory()
      ? copyPathRecursive(from, to)
      : fs.copyFileSync(from, to);
  }
};

/** 清理过期的暂存目录 (每次安装操作时顺带执行) */
const pruneStaleStages = () => {
  const now = Date.now();
  for (const [stageId, stage] of stagedInstalls) {
    if (now - stage.createdAt > STAGE_TTL_MS) {
      try {
        // 只删除暂存目录本身 (mkdtemp 出来的独立目录)。
        // 之前误写为 path.dirname(stage.dir) —— 那是整个用户临时目录,
        // 递归删除会造成全系统临时文件丢失 (代码审查发现, P0)。
        removePathRecursive(stage.dir);
      } catch (err) {
        console.warn("[HugoAura / Plugin] Failed to prune stale stage:", err);
      }
      stagedInstalls.delete(stageId);
    }
  }
};

/**
 * 解析 manifest 并把暂存目录收敛到 manifest 所在层 (兼容单层顶层文件夹)。
 * @param {string} stageDir
 * @returns {{manifestDir: string, manifest: any}}
 */
const resolveManifestDir = (stageDir) => {
  let manifestDir = stageDir;
  if (!fs.existsSync(path.join(manifestDir, "manifest.json"))) {
    const subs = fs
      .readdirSync(manifestDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());
    const candidate =
      subs.length === 1
        ? path.join(manifestDir, subs[0].name)
        : null;
    if (!candidate || !fs.existsSync(path.join(candidate, "manifest.json"))) {
      throw new Error("MANIFEST_NOT_FOUND");
    }
    manifestDir = candidate;
  }
  // readManifest 内部做结构校验 + 入口文件存在性校验
  const manifest = pluginManager.readManifest(manifestDir);
  return { manifestDir, manifest };
};

/**
 * 下载文件到本地 (支持重定向, 每一跳都过 urlSafety 校验)。
 * @param {string} url
 * @param {string} destPath
 * @param {((p: {curBytes: number, totalBytes: number}) => void) | null} onProgress
 * @returns {Promise<void>}
 */
const downloadWithRedirects = (url, destPath, onProgress) =>
  new Promise((resolve, reject) => {
    /** @param {string} currentUrl @param {number} hops */
    const doRequest = async (currentUrl, hops) => {
      const safety = await validateUrlResolved(currentUrl);
      if (!safety.ok) {
        reject(new Error(`UNSAFE_URL: ${safety.reason}`));
        return;
      }
      const transport = safety.url.protocol === "https:" ? nodeHttps : nodeHttp;
      const req = transport.get(safety.url, (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          const location = res.headers.location;
          if (!location || hops >= DOWNLOAD_MAX_REDIRECTS) {
            reject(new Error("DOWNLOAD_REDIRECT_LIMIT"));
            return;
          }
          doRequest(new URL(location, safety.url).toString(), hops + 1);
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`HTTP_${status}`));
          return;
        }

        const totalBytes = parseInt(res.headers["content-length"], 10) || 0;
        let curBytes = 0;
        const stream = fs.createWriteStream(destPath);
        res.on("data", (chunk) => {
          curBytes += chunk.length;
          if (onProgress) {
            try {
              onProgress({ curBytes, totalBytes });
            } catch (err) {
              /* 进度回调异常不影响下载 */
            }
          }
        });
        res.pipe(stream);
        stream.on("finish", () => {
          stream.close();
          resolve(destPath);
        });
        stream.on("error", (err) => reject(err));
      });
      req.on("error", (err) => reject(err));
    };

    doRequest(url, 0);
  });

// ---- 市场清单 ----
// 解析/校验/安装状态标注在 utils/marketManifest.js (纯函数, 便于单测)

/**
 * 拉取市场清单 (内存缓存 MARKET_CACHE_TTL_MS; 数据源按序尝试, 全部失败抛错)。
 * 本地源 (网络源全部失败后的离线兜底) 会把包内存在的插件包改写为
 * 绝对路径下载地址并标注 local, 供 installFromPath 走本地安装。
 * @param {boolean} force 跳过缓存强制刷新
 * @returns {Promise<{items: any[], source: string}>}
 */
const fetchMarketManifest = async (force = false) => {
  if (
    !force &&
    marketCache &&
    Date.now() - marketCache.at < MARKET_CACHE_TTL_MS
  ) {
    return { items: marketCache.items, source: marketCache.source };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-market-"));
  const tmpPath = path.join(tmpDir, "plugins.json");
  try {
    let lastError = "UNKNOWN";
    for (const source of MARKET_SOURCES) {
      try {
        await downloadWithRedirects(source, tmpPath, null);
        const items = parseMarketManifest(fs.readFileSync(tmpPath, "utf8"));
        marketCache = { at: Date.now(), items, source };
        return { items, source };
      } catch (err) {
        lastError = String(err && err.message ? err.message : err);
        console.warn(
          `[HugoAura / Plugin] Market source failed (${source}): ${lastError}`
        );
      }
    }

    // 离线兜底: 包内自带的清单与插件包 (市场无需联网即可用)
    try {
      const localManifest = path.join(auraPackageRoot(), "market", "plugins.json");
      const items = parseMarketManifest(fs.readFileSync(localManifest, "utf8"));
      const packagesDir = path.resolve(marketPackagesDir());
      for (const item of items) {
        const basename = decodeURIComponent(
          String(item.downloadUrl).split("/").pop() || ""
        );
        const candidate = path.join(packagesDir, basename);
        if (
          basename &&
          path.dirname(candidate) === packagesDir &&
          fs.existsSync(candidate)
        ) {
          item.downloadUrl = candidate;
          item.local = true;
        }
      }
      marketCache = { at: Date.now(), items, source: MARKET_LOCAL_SOURCE };
      return { items, source: MARKET_LOCAL_SOURCE };
    } catch (err) {
      lastError = String(err && err.message ? err.message : err);
      console.warn(`[HugoAura / Plugin] Local market fallback failed: ${lastError}`);
    }

    throw new Error(`MARKET_SOURCES_FAILED: ${lastError}`);
  } finally {
    try {
      removePathRecursive(tmpDir);
    } catch (_cleanupErr) {
      /* 忽略清理失败 */
    }
  }
};

/**
 * 暂存一个插件包 (解压到临时目录 + 解析 manifest)。
 * @param {string} zipPath
 * @returns {{stageId: string, manifest: any}}
 */
const stagePluginZip = (zipPath) => {  pruneStaleStages();
  const stageId = genRandomHex();
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), `aura-plugin-${stageId}-`));
  try {
    unzipToDir(zipPath, stageDir);
    const { manifestDir, manifest } = resolveManifestDir(stageDir);
    stagedInstalls.set(stageId, {
      dir: stageDir,
      manifestDir,
      manifest,
      createdAt: Date.now(),
    });
    return { stageId, manifest };
  } catch (err) {
    try {
      removePathRecursive(stageDir);
    } catch (_cleanupErr) {
      /* 清理失败不影响报错 */
    }
    throw err;
  }
};

/**
 * 把暂存目录落盘为正式插件 (覆盖安装拒绝降级; 已启用则立即重载)。
 * @param {string} stageId
 * @returns {any} manifest
 */
const installStaged = (stageId) => {
  const stage = stagedInstalls.get(stageId);
  if (!stage) throw new Error("STAGE_NOT_FOUND");

  const root = pluginsRoot();
  fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, stage.manifest.id);

  if (fs.existsSync(path.join(target, "manifest.json"))) {
    const oldManifest = pluginManager.readManifest(target);
    if (compareVersion(stage.manifest.version, oldManifest.version) < 0) {
      throw new Error(
        `DOWNGRADE_REJECTED: ${oldManifest.version} -> ${stage.manifest.version}`
      );
    }
    // 旧实例先下线 (尽力调 onUnload), 再覆盖
    pluginManager.disablePlugin(oldManifest.id);
  }

  removePathRecursive(target);
  // 暂存目录可能在另一个盘, rename 会跨盘失败, 统一用 cp + rm
  copyPathRecursive(stage.manifestDir, target);

  stagedInstalls.delete(stageId);
  try {
    removePathRecursive(stage.dir);
  } catch (err) {
    console.warn("[HugoAura / Plugin] Failed to clean stage dir:", err);
  }

  recordInstalledAt(stage.manifest.id);

  // 若该插件此前处于启用状态, 立即加载 main 实例
  const config = global.__HUGO_AURA_CONFIG_MGR__?.loadConfig?.();
  const enabled =
    config &&
    config.auraSettings &&
    config.auraSettings.plugins &&
    config.auraSettings.plugins.enabled &&
    config.auraSettings.plugins.enabled[stage.manifest.id] === true;
  if (enabled && stage.manifest.type === "main") {
    try {
      pluginManager.enablePlugin(stage.manifest.id);
    } catch (err) {
      console.error("[HugoAura / Plugin] Failed to hot-load installed plugin:", err);
    }
  }

  console.log(
    `[HugoAura / Plugin] Installed plugin: ${stage.manifest.id} v${stage.manifest.version}`
  );
  return stage.manifest;
};

const discardStage = (stageId) => {
  const stage = stagedInstalls.get(stageId);
  if (!stage) return { success: false, error: "STAGE_NOT_FOUND" };
  stagedInstalls.delete(stageId);
  try {
    removePathRecursive(stage.dir);
  } catch (err) {
    console.warn("[HugoAura / Plugin] Failed to clean stage dir:", err);
  }
  return { success: true };
};

/**
 * 读写启用状态 (auraSettings.plugins.enabled[id])。
 * @param {string} id
 * @param {boolean} enabled
 */
const setPluginEnabled = (id, enabled) => {
  const mgr = global.__HUGO_AURA_CONFIG_MGR__;
  if (!mgr) return { success: false, error: "CONFIG_MANAGER_UNAVAILABLE" };

  const config = mgr.loadConfig();
  if (!config.auraSettings.plugins) config.auraSettings.plugins = { enabled: {} };
  if (!config.auraSettings.plugins.enabled) config.auraSettings.plugins.enabled = {};
  if (enabled) {
    config.auraSettings.plugins.enabled[id] = true;
  } else {
    delete config.auraSettings.plugins.enabled[id];
  }
  mgr.writeConfig(config);

  // 主进程配置缓存与运行时同步
  global.__HUGO_AURA_CONFIG__ = config;
  if (global.__HUGO_AURA_EVENT_BUS__?.emit) {
    global.__HUGO_AURA_EVENT_BUS__.emit("$aura.config.refreshConfig");
  }
  return { success: true };
};

/** 权限开关的当前状态 (auraSettings.plugins.permissions[id]) */
const getPermissionState = (id) => {
  try {
    const config = global.__HUGO_AURA_CONFIG_MGR__?.loadConfig?.();
    return (
      (config &&
        config.auraSettings &&
        config.auraSettings.plugins &&
        config.auraSettings.plugins.permissions &&
        config.auraSettings.plugins.permissions[id]) ||
      {}
    );
  } catch (err) {
    return {};
  }
};

/** UI 列表项形态 (含 v1.1 扩展字段: 配置界面/权限/能力/API 等级/安装时间) */
const toListItem = (item) => ({
  id: item.manifest.id,
  name: item.manifest.name,
  version: item.manifest.version,
  author: item.manifest.author,
  description: item.manifest.description,
  type: item.manifest.type,
  main: item.manifest.main,
  enabled: item.enabled,
  dir: item.pluginDir,
  configUI: Array.isArray(item.manifest.configUI) ? item.manifest.configUI : [],
  permissions: Array.isArray(item.manifest.permissions)
    ? item.manifest.permissions
    : [],
  permissionState: getPermissionState(item.manifest.id),
  capabilities:
    item.manifest.capabilities && typeof item.manifest.capabilities === "object"
      ? item.manifest.capabilities
      : {},
  apiLevel: Number.isInteger(item.manifest.apiLevel) ? item.manifest.apiLevel : 1,
  homepage: typeof item.manifest.homepage === "string" ? item.manifest.homepage : "",
  installedAt: getInstalledAt(item.manifest.id),
});

/**
 * 安装元数据 (安装时间等) 存在 auraSettings.plugins.meta[id]。
 * @param {string} id
 * @returns {string} ISO 时间; 未记录返回 ""
 */
const getInstalledAt = (id) => {
  try {
    const config = global.__HUGO_AURA_CONFIG_MGR__?.loadConfig?.();
    return (
      (config &&
        config.auraSettings &&
        config.auraSettings.plugins &&
        config.auraSettings.plugins.meta &&
        config.auraSettings.plugins.meta[id] &&
        config.auraSettings.plugins.meta[id].installedAt) ||
      ""
    );
  } catch (err) {
    return "";
  }
};

/** @param {string} id */
const recordInstalledAt = (id) => {
  try {
    const mgr = global.__HUGO_AURA_CONFIG_MGR__;
    if (!mgr) return;
    const config = mgr.loadConfig();
    if (!config.auraSettings.plugins) config.auraSettings.plugins = { enabled: {} };
    if (!config.auraSettings.plugins.meta) config.auraSettings.plugins.meta = {};
    config.auraSettings.plugins.meta[id] = {
      ...(config.auraSettings.plugins.meta[id] || {}),
      installedAt: new Date().toISOString(),
    };
    mgr.writeConfig(config);
  } catch (err) {
    console.warn("[HugoAura / Plugin] Failed to record install meta:", err);
  }
};

/**
 * @param {import("electron").IpcMain} ipcMain
 */
const applyPluginIpcHandler = (ipcMain) => {
  const methodBase = "$aura.plugin";

  ipcMain.handle(`${methodBase}.list`, async (_event, _arg) => {
    try {
      const items = pluginManager.scanInstalled().map(toListItem);
      return { success: true, data: items };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle(`${methodBase}.marketList`, async (_event, arg) => {
    try {
      const force = Boolean(arg && arg.force);
      const { items, source } = await fetchMarketManifest(force);
      const installedPairs = pluginManager
        .scanInstalled()
        .map((i) => ({ id: i.manifest.id, version: i.manifest.version }));
      return {
        success: true,
        data: { items: enrichMarketItems(items, installedPairs), source },
      };
    } catch (err) {
      return { success: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle(`${methodBase}.installLocal`, async (_event, _arg) => {
    try {
      const picked = await dialog.showOpenDialog({
        title: "选择插件包 (zip)",
        filters: [{ name: "插件包", extensions: ["zip"] }],
        properties: ["openFile"],
      });
      if (picked.canceled || !picked.filePaths.length) {
        return { success: false, error: "CANCELED" };
      }
      const { stageId, manifest } = stagePluginZip(picked.filePaths[0]);
      return { success: true, data: { stageId, manifest } };
    } catch (err) {
      return { success: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle(
    `${methodBase}.installFromUrl`,
    /**
     * @param {import("electron").IpcMainInvokeEvent} _event
     * @param {{ url?: string, reportTo?: string }} arg
     */
    async (_event, arg) => {
      const url = arg && typeof arg.url === "string" ? arg.url.trim() : "";
      const expectedSha256 =
        arg && typeof arg.sha256 === "string" ? arg.sha256 : "";
      const reportTo = (arg && arg.reportTo) || "assistant";
      const report = (payload) => {
        try {
          ipcMain.send(reportTo, INSTALL_PROGRESS_CHANNEL, payload);
        } catch (err) {
          console.warn("[HugoAura / Plugin] Failed to report install progress:", err);
        }
      };

      let zipPath = null;
      try {
        if (!url) throw new Error("URL_REQUIRED");

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-plugin-dl-"));
        zipPath = path.join(tmpDir, "plugin.zip");
        report({ stage: "download", progress: 0, curBytes: 0, totalBytes: 0 });

        await downloadWithRedirects(url, zipPath, (p) =>
          report({
            stage: "download",
            progress: p.totalBytes
              ? Math.round((p.curBytes / p.totalBytes) * 100)
              : 0,
            curBytes: p.curBytes,
            totalBytes: p.totalBytes,
          })
        );

        // 清单声明了 sha256 时做完整性校验 (CDN 缓存污染 / 下载截断防护)
        verifyFileSha256(zipPath, expectedSha256);

        report({ stage: "extract", progress: 0 });
        const { stageId, manifest } = stagePluginZip(zipPath);
        removePathRecursive(path.dirname(zipPath));
        report({ stage: "staged", progress: 100, manifest });
        return { success: true, data: { stageId, manifest } };
      } catch (err) {
        try {
          if (zipPath) removePathRecursive(path.dirname(zipPath));
        } catch (_cleanupErr) {
          /* 忽略清理失败 */
        }
        report({ stage: "failed", message: String(err) });
        return { success: false, error: String(err && err.message ? err.message : err) };
      }
    }
  );

  // 市场本地兜底安装: 只允许安装包内 market/packages/ 目录里的 zip
  ipcMain.handle(`${methodBase}.installFromPath`, async (_event, arg) => {
    try {
      const p = arg && typeof arg.path === "string" ? arg.path.trim() : "";
      if (!p) throw new Error("PATH_REQUIRED");
      const packagesDir = path.resolve(marketPackagesDir());
      const resolved = path.resolve(p);
      if (
        !resolved.startsWith(packagesDir + path.sep) ||
        !resolved.toLowerCase().endsWith(".zip")
      ) {
        throw new Error("PATH_OUTSIDE_MARKET");
      }
      if (!fs.existsSync(resolved)) throw new Error("FILE_NOT_FOUND");
      const { stageId, manifest } = stagePluginZip(resolved);
      return { success: true, data: { stageId, manifest } };
    } catch (err) {
      return { success: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle(`${methodBase}.confirmInstall`, async (_event, arg) => {    try {
      const stageId = arg && typeof arg.stageId === "string" ? arg.stageId : "";
      const manifest = installStaged(stageId);
      return { success: true, data: { manifest } };
    } catch (err) {
      return { success: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle(`${methodBase}.cancelInstall`, async (_event, arg) => {
    const stageId = arg && typeof arg.stageId === "string" ? arg.stageId : "";
    return discardStage(stageId);
  });

  ipcMain.handle(`${methodBase}.enable`, async (_event, arg) => {
    const id = arg && typeof arg.id === "string" ? arg.id : "";
    if (!pluginManager.ID_PATTERN.test(id)) {
      return { success: false, error: "ID_INVALID" };
    }
    try {
      pluginManager.enablePlugin(id);
      return setPluginEnabled(id, true);
    } catch (err) {
      return { success: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle(`${methodBase}.disable`, async (_event, arg) => {
    const id = arg && typeof arg.id === "string" ? arg.id : "";
    if (!pluginManager.ID_PATTERN.test(id)) {
      return { success: false, error: "ID_INVALID" };
    }
    try {
      pluginManager.disablePlugin(id);
      return setPluginEnabled(id, false);
    } catch (err) {
      return { success: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle(`${methodBase}.remove`, async (_event, arg) => {
    const id = arg && typeof arg.id === "string" ? arg.id : "";
    if (!pluginManager.ID_PATTERN.test(id) || id.includes("..")) {
      return { success: false, error: "ID_INVALID" };
    }
    try {
      pluginManager.disablePlugin(id);
      const target = path.join(pluginsRoot(), id);
      if (fs.existsSync(target)) {
        removePathRecursive(target);
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle(`${methodBase}.openDir`, async (_event, _arg) => {
    try {
      const root = pluginsRoot();
      fs.mkdirSync(root, { recursive: true });
      shell.openPath(root);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ---- 配置界面 / 权限开关 (v1.1) ----

  ipcMain.handle(`${methodBase}.getConfig`, async (_event, arg) => {
    try {
      const id = arg && typeof arg.id === "string" ? arg.id : "";
      if (!pluginManager.ID_PATTERN.test(id)) {
        return { success: false, error: "ID_INVALID" };
      }
      const pluginDir = path.join(pluginsRoot(), id);
      const manifest = pluginManager.readManifest(pluginDir, id);
      return {
        success: true,
        data: {
          schema: Array.isArray(manifest.configUI) ? manifest.configUI : [],
          values: pluginManager.readPluginSettings(pluginDir),
        },
      };
    } catch (err) {
      return { success: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle(`${methodBase}.saveConfig`, async (_event, arg) => {
    try {
      const id = arg && typeof arg.id === "string" ? arg.id : "";
      const values = arg && typeof arg.values === "object" && arg.values ? arg.values : {};
      if (!pluginManager.ID_PATTERN.test(id)) {
        return { success: false, error: "ID_INVALID" };
      }
      const pluginDir = path.join(pluginsRoot(), id);
      const manifest = pluginManager.readManifest(pluginDir, id);
      pluginManager.writePluginSettings(pluginDir, values);
      void manifest;

      // 运行中的 main 插件可通过事件总线订阅设置变化:
      //   eventBus.on("$aura.plugin.<id>.settingsChanged", (values) => {})
      if (global.__HUGO_AURA_EVENT_BUS__?.emit) {
        global.__HUGO_AURA_EVENT_BUS__.emit(`$aura.plugin.${id}.settingsChanged`, values);
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle(`${methodBase}.setPermission`, async (_event, arg) => {
    try {
      const id = arg && typeof arg.id === "string" ? arg.id : "";
      const key = arg && typeof arg.key === "string" ? arg.key : "";
      const enabled = Boolean(arg && arg.enabled);
      if (!pluginManager.ID_PATTERN.test(id) || !key.trim()) {
        return { success: false, error: "ID_INVALID" };
      }
      const mgr = global.__HUGO_AURA_CONFIG_MGR__;
      if (!mgr) return { success: false, error: "CONFIG_MANAGER_UNAVAILABLE" };
      const config = mgr.loadConfig();
      if (!config.auraSettings.plugins) config.auraSettings.plugins = { enabled: {} };
      if (!config.auraSettings.plugins.permissions) {
        config.auraSettings.plugins.permissions = {};
      }
      if (!config.auraSettings.plugins.permissions[id]) {
        config.auraSettings.plugins.permissions[id] = {};
      }
      config.auraSettings.plugins.permissions[id][key] = enabled;
      mgr.writeConfig(config);
      // 注意: v1 权限开关为声明式展示, 运行时强制执行将随插件 API v2 提供
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
};

module.exports = {
  applyPluginIpcHandler,
  verifyFileSha256,
  // 测试导出: 暂存清理与暂存表 (锁定 "只删暂存目录本身" 的回归语义)
  pruneStaleStages,
  stagedInstalls,
};
