// @ts-check

/**
 * "关于项目" 页面内容 (About / Info)
 *
 * 说明: 该 tab 在 preferences.html 中早已声明 (#about-subpage),
 * 但 preferences.js 从未初始化它, 导致界面空白。本文件提供内容并修复初始化。
 *
 * 贡献者数据: 头像 URL 硬编码为 GitHub 官方头像地址,
 * 加载失败时自动降级为用户名首字母占位 (避免网络不佳导致空白)。
 */

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
          <img src="${c.avatar}" alt="${c.name}" loading="lazy" onerror="this.style.display='none'"/>
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
            HugoAura: v${versions.aura}<br/>
            Electron: v${versions.electron}<br/>
            Node.js: v${versions.node}
          </p>
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

module.exports = { aboutContent };
