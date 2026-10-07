// @ts-check

/**
 * "关于项目" 页面内容 (About / Info)
 *
 * 说明: 该 tab 在 preferences.html 中早已声明 (#about-subpage)。
 * 视觉与指令审计页同一套设计语言 (复用 --audit-* 变量与面板样式)。
 *
 * 贡献者头像: GitHub 官方头像地址, 加载失败时降级为用户名首字母占位。
 * 检查更新: 调用主进程 $aura.update.check 查询 GitHub Releases 最新版本,
 * 有更新时提供 $aura.update.openRelease 打开官方发布页。实际替换文件由
 * HugoAura-Enhanced-Install 的 AuraInstaller.exe 完成, 不在本页执行。
 */

const UPDATE_IPC_BASE = "$aura.update";
const FALLBACK_RELEASES_URL =
  "https://github.com/blingbling-bow/HugoAura-Enhanced/releases";
const REPO_URL = "https://github.com/blingbling-bow/HugoAura-Enhanced";

const getEnvVersions = () => {
  try {
    return {
      node: window.process ? window.process.versions.node : "unknown",
      electron: window.process ? window.process.versions.electron : "unknown",
      aura:
        global.__HUGO_AURA__ && global.__HUGO_AURA__.version
          ? global.__HUGO_AURA__.version
          : "unknown",
    };
  } catch (_err) {
    return { node: "unknown", electron: "unknown", aura: "unknown" };
  }
};

/**
 * 贡献者名单 (兜底数据)
 *
 * 这份内置名单只是**离线回退**: 有网络时会从 GitHub API 拉取最新的
 * 贡献者列表并缓存 24 小时 (localStorage), 拉取失败 (离线 / 限流) 时
 * 才使用这里的数据。数据取自 2026-10-07 的 GitHub Contributors API,
 * 按贡献次数排序。
 */
const CONTRIBUTORS_FALLBACK = [
  { name: "blingbling-bow", avatar: "https://avatars.githubusercontent.com/u/311448541?v=4" },
  { name: "Minoricew", avatar: "https://avatars.githubusercontent.com/u/154642983?v=4" },
  { name: "CreeperAWA", avatar: "https://avatars.githubusercontent.com/u/134939494?v=4" },
  { name: "MF-Dust", avatar: "https://avatars.githubusercontent.com/u/128943330?v=4" },
  { name: "Akiyama-Mizuki-44", avatar: "https://avatars.githubusercontent.com/u/63501294?v=4" },
  { name: "tianmiao8152", avatar: "https://avatars.githubusercontent.com/u/83683108?v=4" },
  { name: "Koharu-Mizuki", avatar: "https://avatars.githubusercontent.com/u/123185656?v=4" },
  { name: "mstouk57g", avatar: "https://avatars.githubusercontent.com/u/65524880?v=4" },
  { name: "sunhaoming665", avatar: "https://avatars.githubusercontent.com/u/139680946?v=4" },
];

const CONTRIBUTORS_API =
  "https://api.github.com/repos/blingbling-bow/HugoAura-Enhanced/contributors";
const CONTRIBUTORS_CACHE_KEY = "auraAboutContributors";
const CONTRIBUTORS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 小时

const contributorHtml = (c) => `
      <a
        class="aura-about-contributor"
        href="https://github.com/${escapeAboutHtml(c.name)}"
        target="_blank"
        title="@${escapeAboutHtml(c.name)}"
      >
        <span class="aura-about-avatar">
          <span class="aura-about-avatar-fallback">${escapeAboutHtml(
            String(c.name).slice(0, 1).toUpperCase()
          )}</span>
          <img
            src="${escapeAboutHtml(c.avatar)}"
            alt="${escapeAboutHtml(c.name)}"
            loading="lazy"
            onerror="this.style.display='none';this.previousElementSibling.style.display='flex'"
          />
        </span>
      </a>
    `;

const buildContributorsHtml = (list) => list.map(contributorHtml).join("");

/** 功能清单 (与项目 README 保持一致) */
const FEATURES = [
  { done: true, text: "修改希沃管家密码认证组件 (自定义密码 / 解除密码 / 重设认证方式)" },
  { done: true, text: "阻止希沃管家前端 Audit 上报行为" },
  { done: true, text: "屏蔽屏幕锁 / 自定义屏幕锁行为" },
  { done: true, text: "禁用屏幕保护" },
  { done: true, text: "禁止希沃管家自动更新" },
  { done: true, text: "阻止远程关机" },
  { done: true, text: "阻止远程锁屏" },
  { done: true, text: "禁止开机自动锁屏 (开机后 90 秒窗口期)" },
  { done: true, text: "指令审计 (全通道云端指令留痕 / 未知指令高亮 / 导出 JSONL)" },
  { done: false, text: "Aura 代理层服务 (篡改上报数据 / 欺骗冰冻状态)" },
  { done: false, text: "窥屏提醒 (检测方式在部分环境无法识别窥屏进程, 当前版本已停用)" },
  { done: false, text: "插件功能" },
];

const buildFeaturesHtml = () =>
  FEATURES.map(
    (f) => `
      <div class="aura-about-feature ${f.done ? "aura-about-feature-done" : "aura-about-feature-todo"}">
        <span class="aura-about-feature-mark">${f.done ? "✓" : "○"}</span>
        <span class="aura-about-feature-text">${escapeAboutHtml(f.text)}</span>
      </div>`
  ).join("");

/** 社群与链接 */
const ABOUT_LINKS = [
  ["文档与安装教程", "https://hugoaura.pages.dev/"],
  ["反馈 / Issues", "https://github.com/blingbling-bow/HugoAura-Enhanced/issues"],
  ["Telegram 群组", "https://t.me/HugoAura_Chat"],
  ["Telegram 频道", "https://t.me/HugoAuraEn"],
];

const buildLinksHtml = () =>
  ABOUT_LINKS.map(
    ([name, url]) =>
      `<a class="aura-about-link" href="${escapeAboutHtml(url)}" target="_blank">${escapeAboutHtml(name)}</a>`
  ).join("");

/** 有缓存 (24 小时内) 用缓存 */
const readContributorsCache = () => {
  try {
    const raw = global.localStorage.getItem(CONTRIBUTORS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.list) || !parsed.ts) return null;
    if (Date.now() - parsed.ts > CONTRIBUTORS_CACHE_TTL) return null;
    const list = parsed.list.filter(
      (c) => c && typeof c.name === "string" && typeof c.avatar === "string"
    );
    return list.length > 0 ? list : null;
  } catch (_err) {
    return null;
  }
};

const writeContributorsCache = (list) => {
  try {
    global.localStorage.setItem(
      CONTRIBUTORS_CACHE_KEY,
      JSON.stringify({ ts: Date.now(), list })
    );
  } catch (_err) {
    // 隐私模式 / 存储满: 缓存失败不影响页面
  }
};

/** 在线拉取最新贡献者 (GitHub Contributors API, 按贡献次数排序) */
const fetchContributors = async () => {
  const res = await fetch(CONTRIBUTORS_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("unexpected payload");
  return data
    .map((u) => ({ name: u.login, avatar: u.avatar_url }))
    .filter((u) => u.name && u.avatar);
};

// 首屏渲染: 优先用 24 小时内的缓存, 否则用内置兜底名单 (在线刷新随后覆盖)
const initialContributors = readContributorsCache() || CONTRIBUTORS_FALLBACK;

/** 版本信息磁贴 (复用审计页统计卡样式) */
const buildVersionTile = (label, value, sev) => `
      <div class="aura-audit-stat" data-sev="${sev}">
        <div class="aura-audit-stat-head">
          <span class="aura-audit-stat-label">${escapeAboutHtml(label)}</span>
          <span class="aura-audit-stat-dot"></span>
        </div>
        <div class="aura-audit-stat-value aura-about-ver">${escapeAboutHtml(value)}</div>
      </div>`;

const escapeAboutHtml = (value) => {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
};

const buildAboutHtml = () => {
  const versions = getEnvVersions();
  return `
    <div class="aura-settings-form aura-about-form">
      <header class="aura-about-hero">
        <div class="aura-about-brand">
          <span class="aura-about-logo">
            <img
              class="aura-about-logo-img"
              src="../../aura/ui/static/aura.svg"
              alt=""
              onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'"
            />
            <span class="aura-about-logo-fallback" style="display: none">H</span>
          </span>
          <div class="aura-about-brand-text">
            <p class="aura-about-name">HugoAura <span>Enhanced</span></p>
            <p class="aura-about-tagline">
              面向希沃管家 (SeewoServiceAssistant) 的注入式增强方案,
              旨在探索与学习 Electron 应用的可扩展性
            </p>
          </div>
        </div>
        <span class="aura-about-version">${escapeAboutHtml(versions.aura)}</span>
      </header>

      <section class="aura-audit-stats aura-about-stats">
        ${buildVersionTile("HugoAura", versions.aura, "primary")}
        ${buildVersionTile("Electron", `v${versions.electron}`, "info")}
        ${buildVersionTile("Node.js", `v${versions.node}`, "secondary")}
      </section>

      <section class="aura-audit-panel">
        <div class="aura-about-row">
          <div class="aura-about-row-text">
            <p class="aura-about-row-title">版本更新</p>
            <p class="aura-about-row-desc" id="auraUpdateStatus">
              点击「检查更新」, 查询 GitHub Releases 是否已有新版本。
            </p>
          </div>
          <div class="aura-about-row-actions">
            <button id="auraUpdateCheckBtn" type="button" class="aura-audit-btn">
              检查更新
            </button>
            <button
              id="auraUpdateOpenBtn"
              type="button"
              class="aura-audit-btn aura-about-btn-accent"
              style="display: none"
            >前往下载</button>
          </div>
        </div>
      </section>

      <section class="aura-audit-panel">
        <div class="aura-about-panel-head">
          <p class="aura-about-panel-title">功能</p>
          <span class="aura-about-panel-hint">与项目 README 保持一致</span>
        </div>
        <div class="aura-about-features">${buildFeaturesHtml()}</div>
      </section>

      <section class="aura-audit-panel">
        <div class="aura-about-panel-head">
          <p class="aura-about-panel-title">社群与链接</p>
        </div>
        <div class="aura-about-links">${buildLinksHtml()}</div>
      </section>

      <section class="aura-audit-panel">
        <div class="aura-about-panel-head">
          <p class="aura-about-panel-title">贡献者</p>
          <a class="aura-audit-btn" href="${REPO_URL}" target="_blank" title="在 GitHub 上查看项目">GitHub</a>
        </div>
        <div class="aura-about-contributors" id="auraAboutContributors">${buildContributorsHtml(
          initialContributors
        )}</div>
      </section>

      <section class="aura-audit-panel">
        <div class="aura-about-panel-head">
          <p class="aura-about-panel-title">许可与声明</p>
          <span class="aura-about-license-badge">GPL-3.0</span>
        </div>
        <div class="aura-about-license-text">
          本项目仅供学习与研究使用, 请勿用于任何违反学校 / 机构管理规定或当地法律法规的场合。
          使用本项目造成的一切后果由使用者自行承担。
        </div>
      </section>
    </div>
  `;
};

const aboutContent = buildAboutHtml();

/**
 * 初始化"关于项目"子页: 写入内容并绑定检查更新事件。
 */
const initAboutSubPage = () => {
  const aboutSubPageEl = document.getElementById("about-subpage");
  if (!aboutSubPageEl) return;

  aboutSubPageEl.innerHTML = aboutContent;

  const statusEl = document.getElementById("auraUpdateStatus");
  const checkBtn = document.getElementById("auraUpdateCheckBtn");
  const openBtn = document.getElementById("auraUpdateOpenBtn");
  if (!statusEl || !checkBtn || !openBtn) return;

  let latestHtmlUrl = FALLBACK_RELEASES_URL;

  const setStatus = (text, cls = "") => {
    statusEl.textContent = text;
    statusEl.className = `aura-about-row-desc${cls ? " " + cls : ""}`;
  };

  const checkUpdate = async () => {
    checkBtn.disabled = true;
    openBtn.style.display = "none";
    setStatus("正在检查更新...");

    try {
      const res = await global.ipcRenderer.invoke(`${UPDATE_IPC_BASE}.check`);
      if (!res || !res.success) {
        setStatus(`检查失败: ${(res && res.error) || "未知错误"}`, "ase-desc-error-hint");
        return;
      }

      const data = res.data || {};
      if (data.hasUpdate) {
        latestHtmlUrl = data.htmlUrl || FALLBACK_RELEASES_URL;
        setStatus(`发现新版本 ${data.remoteVersion}, 请前往下载安装。`);
        openBtn.style.display = "";
      } else {
        setStatus(`已是最新版本 (当前 ${data.currentVersion || "unknown"})。`);
      }
    } catch (err) {
      console.error("[HugoAura / About / Update] Check failed:", err);
      setStatus(`检查失败: ${String(err)}`, "ase-desc-error-hint");
    } finally {
      checkBtn.disabled = false;
    }
  };

  const openRelease = async () => {
    try {
      const res = await global.ipcRenderer.invoke(`${UPDATE_IPC_BASE}.openRelease`, {
        htmlUrl: latestHtmlUrl,
      });
      if (!res || !res.success) {
        setStatus(`打开下载页失败: ${(res && res.error) || "未知错误"}`, "ase-desc-error-hint");
      }
    } catch (err) {
      console.error("[HugoAura / About / Update] Open release failed:", err);
      setStatus(`打开下载页失败: ${String(err)}`, "ase-desc-error-hint");
    }
  };

  checkBtn.addEventListener("click", checkUpdate);
  openBtn.addEventListener("click", openRelease);

  // 贡献者: 有网时在线拉取最新名单 (并缓存 24 小时), 无网时保留当前渲染
  const refreshContributors = async () => {
    try {
      const list = await fetchContributors();
      if (!list.length) return;
      writeContributorsCache(list);
      renderContributors(list);
    } catch (_err) {
      // 离线 / 限流: 保留兜底渲染, 不打扰用户
      console.debug("[HugoAura / About] Contributors fetch skipped (offline?)");
    }
  };
  refreshContributors();
};

module.exports = { aboutContent, initAboutSubPage };
