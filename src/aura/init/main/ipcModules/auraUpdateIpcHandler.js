// @ts-check

/**
 * HugoAura 自身更新 (主进程 IPC)。
 *
 * 架构说明: HugoAura 不是独立程序, 而是注入到 SeewoServiceAssistant 的
 * app.asar (含 hook.js / zeron.js / preload.js) 与 resources/aura/ 目录。
 * 真正的"替换注入文件"涉及卸载 SeewoKeLiteLady 驱动、杀掉管家进程、
 * 从 app.asar.bak 重新 patch app.asar, 这些已由 HugoAura-Install 的
 * AuraInstaller.exe 完成, 且 AuraInstaller.exe 是用户自行下载的便携程序,
 * 没有可信的固定落点。
 *
 * 因此本模块刻意不在 Electron 进程内执行任何外部可执行文件:
 *   1. check:       查询 GitHub Releases 最新版本并比较 (纯逻辑 + SSRF 校验);
 *   2. openRelease: 用默认浏览器打开官方 Release 页 (校验 https 公网域名)。
 *
 * 完整自动安装需要先解决"可信安装器路径"来源 (随 aura.zip 捆绑, 或由
 * 用户显式配置并做完整性校验), 在此之前只提供"检查更新 + 引导到下载页"。
 */

const nodeHttp = require("http");
const nodeHttps = require("https");

const { compareVersion } = require("../../../utils/auraVersion");
const { validateUrl, validateUrlResolved } = require("../../../utils/urlSafety");

// 与 HugoAura-Install 保持一致: 以 GitHub Releases 作为版本事实来源。
const RELEASE_API_URL =
  "https://api.github.com/repos/blingbling-bow/HugoAura-Enhanced/releases";

/**
 * 选取"最新可用版本", 语义与安装器 select_release_source 的 --latest 一致:
 * 优先非预发布, 其次非 CI 预发布, 最后 CI 构建。
 * @param {any[]} releases
 * @returns {any | null}
 */
const pickLatestRelease = (releases) => {
  if (!Array.isArray(releases)) return null;
  const stable = releases.filter((r) => r && !r.prerelease);
  const pre = releases.filter(
    (r) => r && r.prerelease && r.name && !String(r.name).startsWith("[CI")
  );
  const ci = releases.filter(
    (r) => r && r.name && String(r.name).startsWith("[CI")
  );
  return stable[0] || pre[0] || ci[0] || null;
};

/**
 * 纯函数: 根据 release 判断是否比当前版本新。
 * @param {any} release
 * @param {string} currentVersion
 * @returns {{ ok: boolean, error?: string, hasUpdate?: boolean, remoteVersion?: string, name?: string, htmlUrl?: string }}
 */
const evaluateRelease = (release, currentVersion) => {
  const tag =
    release && typeof release.tag_name === "string" ? release.tag_name : "";
  if (!tag) return { ok: false, error: "INVALID_RELEASE" };
  return {
    ok: true,
    hasUpdate: compareVersion(tag, currentVersion) > 0,
    remoteVersion: tag,
    name: typeof release.name === "string" ? release.name : tag,
    htmlUrl: typeof release.html_url === "string" ? release.html_url : "",
  };
};

const FETCH_TIMEOUT_MS = 15000;

/**
 * 请求 JSON (仅 http/https)。
 *
 * 安全与健壮性:
 *   - 先做同步 URL 校验: 仅允许 http/https, 拒绝内嵌内网地址;
 *     DNS 层的 SSRF 校验由调用方 validateUrlResolved 完成。
 *   - 根据 URL 协议自动选择 http 或 https 传输模块。
 *   - 带超时控制, 超时后主动销毁请求并 reject, 避免永久挂起。
 *
 * @param {string} url
 * @returns {Promise<any>}
 */
const fetchJson = (url) => {
  return new Promise((resolve, reject) => {
    const safety = validateUrl(url);
    if (!safety.ok) {
      reject(new Error(`UNSAFE_URL: ${safety.reason}`));
      return;
    }

    const parsedUrl = safety.url;
    const transport = parsedUrl.protocol === "https:" ? nodeHttps : nodeHttp;

    let req;
    const timeout = setTimeout(() => {
      if (req) req.destroy(new Error("FETCH_TIMEOUT"));
    }, FETCH_TIMEOUT_MS);

    req = transport.get(
      parsedUrl,
      {
        headers: {
          "User-Agent": "HugoAura-Updater",
          Accept: "application/vnd.github+json",
        },
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          clearTimeout(timeout);
          reject(new Error(`HTTP_${res.statusCode}`));
          res.resume();
          return;
        }
        let chunk = "";
        res.on("data", (d) => {
          chunk += d;
        });
        res.on("end", () => {
          clearTimeout(timeout);
          try {
            resolve(JSON.parse(chunk));
          } catch (err) {
            reject(err);
          }
        });
      }
    );

    req.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
};

/**
 * 获取最新 release (带 SSRF 校验)。
 * @returns {Promise<{ ok: boolean, error?: string, release?: any }>}
 */
const fetchLatestRelease = async () => {
  const safety = await validateUrlResolved(RELEASE_API_URL);
  if (!safety.ok) {
    return { ok: false, error: safety.reason };
  }
  try {
    const releases = await fetchJson(RELEASE_API_URL);
    const release = pickLatestRelease(releases);
    if (!release) return { ok: false, error: "NO_RELEASE" };
    return { ok: true, release };
  } catch (err) {
    console.warn("[HugoAura / Update] Failed to fetch releases:", err);
    return { ok: false, error: "FETCH_FAILED" };
  }
};

/**
 * 用默认浏览器打开 Release 页。
 * 先做 URL 形态 + DNS 校验, 再交给 Electron shell.openExternal,
 * 不执行任何外部进程。
 *
 * @param {string} htmlUrl
 * @param {{ openExternal?: (url: string) => Promise<void> }} [shell]
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
const openReleasePage = async (htmlUrl, shell) => {
  const safety = await validateUrlResolved(htmlUrl);
  if (!safety.ok) {
    return { success: false, error: safety.reason };
  }
  try {
    const opener = shell && typeof shell.openExternal === "function"
      ? shell.openExternal
      : require("electron").shell.openExternal;
    await opener(safety.url.href);
    return { success: true };
  } catch (err) {
    console.error("[HugoAura / Update] Failed to open release page:", err);
    return { success: false, error: "OPEN_FAILED" };
  }
};

/**
 * @param {import("electron").IpcMain} ipcMain
 */
const applyAuraUpdateIpcHandler = (ipcMain) => {
  const methodBase = "$aura.update";

  ipcMain.handle(`${methodBase}.check`, async (_event, _arg) => {
    const currentVersion = global.__HUGO_AURA__.version || "0.0.0";
    const result = await fetchLatestRelease();
    if (!result.ok) {
      return { success: false, error: result.error };
    }
    return {
      success: true,
      data: {
        currentVersion,
        ...evaluateRelease(result.release, currentVersion),
      },
    };
  });

  ipcMain.handle(`${methodBase}.openRelease`, async (_event, arg) => {
    const htmlUrl = arg && typeof arg.htmlUrl === "string" ? arg.htmlUrl : "";
    if (!htmlUrl) {
      return { success: false, error: "RELEASE_URL_REQUIRED" };
    }
    return openReleasePage(htmlUrl);
  });
};

module.exports = {
  applyAuraUpdateIpcHandler,
  pickLatestRelease,
  evaluateRelease,
  fetchLatestRelease,
  openReleasePage,
};
