// @ts-check

/**
 * "关于项目" 页面内容 (About / Info)
 *
 * 说明: 该 tab 在 preferences.html 中早已声明 (#about-subpage),
 * 但 preferences.js 从未初始化它, 导致界面空白。本文件提供内容并修复初始化。
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

const buildAboutHtml = () => {
  const versions = getEnvVersions();
  return `
    <div class="aura-settings-category-header">项目信息</div>
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
    <div class="aura-settings-entry">
      <div class="aura-settings-entry-info-container">
        <p class="aura-settings-entry-title">贡献者名单</p>
        <p class="aura-settings-entry-desc">
          <a href="https://github.com/Minoricew" target="_blank">Minoricew</a><br/>
          <a href="https://github.com/blingbling-bow" target="_blank">blingbling-bow</a><br/>
          <a href="https://github.com/CreeperAWA" target="_blank">CreeperAWA</a><br/>
          <a href="https://github.com/Akiyama-Mizuki-44" target="_blank">Akiyama-Mizuki-44</a><br/>
          <a href="https://github.com/MF-Dust" target="_blank">MF-Dust</a><br/>
          <a href="https://github.com/tianmiao8152" target="_blank">tianmiao8152</a><br/>
          <a href="https://github.com/Koharu-Mizuki" target="_blank">Koharu-Mizuki</a><br/>
          <a href="https://github.com/mstouk57g" target="_blank">mstouk57g</a>
        </p>
      </div>
    </div>
    <hr class="aura-settings-hr-horizontal"/>
    <div class="aura-settings-category-header">免责声明</div>
    <div class="aura-settings-entry">
      <div class="aura-settings-entry-info-container">
        <p class="aura-settings-entry-desc">
          本项目仅供学习与研究使用, 请勿用于任何违反学校 / 机构管理规定或当地法律法规的场合。<br/>
          使用本项目造成的一切后果由使用者自行承担。<br/>
          本项目采用 GPL-3.0 许可证开源。
        </p>
      </div>
    </div>
  `;
};

const aboutContent = buildAboutHtml();

module.exports = { aboutContent };
