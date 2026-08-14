// @ts-check

/**
 * "关于项目" 页面内容 (About / Info)
 *
 * 说明: 该 tab 在 preferences.html 中早已声明 (#about-subpage),
 * 但 preferences.js 从未初始化它, 导致界面空白。本文件提供内容并修复初始化。
 *
 * 贡献者数据: 头像 URL 硬编码为 GitHub 官方头像地址,
 * 加载失败时自动降级为用户名首字母占位 (避免网络不佳导致空白)。
 *
 * 检查更新: 调用主进程 $aura.update.check 查询 GitHub Releases 最新版本,
 * 有更新时提供 $aura.update.openRelease 打开官方发布页。实际替换文件由
 * HugoAura-Install 的 AuraInstaller.exe 完成, 不在本页执行。
 */

const UPDATE_IPC_BASE = "$aura.update";
const FALLBACK_RELEASES_URL =
  "https://github.com/blingbling-bow/HugoAura-Enhanced/releases";

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

/** 贡献者名单 (取自 GitHub Contributors) */
const CONTRIBUTORS = [
  { name: "Minoricew", avatar: "https://avatars.githubusercontent.com/u/154642983?v=4" },
  { name: "blingbling-bow", avatar: "https://avatars.githubusercontent.com/u/311448541?v=4" },
  { name: "CreeperAWA", avatar: "https://avatars.githubusercontent.com/u/134939494?v=4" },
  { name: "Akiyama-Mizuki-44", avatar: "https://avatars.githubusercontent.com/u/63501294?v=4" },
  { name: "MF-Dust", avatar: "https://avatars.githubusercontent.com/u/128943330?v=4" },
  { name: "tianmiao8152", avatar: "https://avatars.githubusercontent.com/u/83683108?v=4" },
  { name: "Koharu-Mizuki", avatar: "https://avatars.githubusercontent.com/u/123185656?v=4" },
  { name: "mstouk57g", avatar: "https://avatars.githubusercontent.com/u/65524880?v=4" },
];

const buildContributorsHtml = () => {
  return CONTRIBUTORS.map(
    (c) => `
      <a class="aura-about-contributor" href="https://github.com/${c.name}" target="_blank">
        <span class="aura-about-avatar">
          <span class="aura-about-avatar-fallback">${c.name.slice(0, 1).toUpperCase()}</span>
          <img
            src="${c.avatar}"
            alt="${c.name}"
            loading="lazy"
            onerror="this.style.display='none';this.previousElementSibling.style.display='flex'"
          />
        </span>
        <span class="aura-about-contributor-name">${c.name}</span>
      </a>
    `
  ).join("");
};

const buildAboutHtml = () => {
  const versions = getEnvVersions();
  return `
    <div class="aura-settings-form aura-about-form">
      <p class="aura-settings-category-header">项目信息</p>
      <div class="aura-settings-entry">
        <div class="aura-settings-entry-info-container">
          <p class="aura-settings-entry-title">HugoAura Enhanced</p>
          <p class="aura-settings-entry-desc">
            面向希沃管家 (SeewoServiceAssistant) 的注入式增强方案。<br/>
            基于 Electron 注入实现, 旨在探索与学习 Electron 应用的可扩展性。
          </p>
        </div>
      </div>
      <div class="aura-settings-entry">
        <div class="aura-settings-entry-info-container">
          <p class="aura-settings-entry-title">版本信息</p>
          <p class="aura-settings-entry-desc">
            HugoAura: ${versions.aura}<br/>
            Electron: v${versions.electron}<br/>
            Node.js: v${versions.node}
          </p>
        </div>
      </div>
      <hr class="aura-settings-hr-horizontal"/>
      <p class="aura-settings-category-header">检查更新</p>
      <div class="aura-settings-entry">
        <div class="aura-settings-entry-info-container">
          <p class="aura-settings-entry-title">HugoAura 版本更新</p>
          <p class="aura-settings-entry-desc" id="auraUpdateStatus">
            点击检查更新, 查询是否已有新版本。
          </p>
        </div>
        <div class="aura-settings-entry-operation-area">
          <button id="auraUpdateCheckBtn" type="button" class="btn btn-sm btn-outline-primary">
            检查更新
          </button>
          <button id="auraUpdateOpenBtn" type="button" class="btn btn-sm btn-primary" style="display: none;">
            前往下载
          </button>
        </div>
      </div>
      <hr class="aura-settings-hr-horizontal"/>
      <p class="aura-settings-category-header">贡献者名单</p>
      <div class="aura-settings-entry">
        <div class="aura-settings-entry-info-container">
          <div class="aura-about-contributors">${buildContributorsHtml()}</div>
        </div>
      </div>
      <hr class="aura-settings-hr-horizontal"/>
      <p class="aura-settings-category-header">免责声明</p>
      <div class="aura-settings-entry">
        <div class="aura-settings-entry-info-container">
          <p class="aura-settings-entry-desc">
            本项目仅供学习与研究使用, 请勿用于任何违反学校 / 机构管理规定或当地法律法规的场合。<br/>
            使用本项目造成的一切后果由使用者自行承担。<br/>
            本项目采用 GPL-3.0 许可证开源。
          </p>
        </div>
      </div>
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
    statusEl.className = `aura-settings-entry-desc${cls ? " " + cls : ""}`;
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
};

module.exports = { aboutContent, initAboutSubPage };
