// @ts-check

/**
 * 插件市场子页 (Plugins / Beta) —— 浅色主题 (与审计 / 关于子页同一设计语言)。
 *
 * 页面结构 (plugins.html): 页头 (数量概览) → 警示横幅 → 本地/在线导入
 * → 已安装/插件市场 双 tab → 插件卡片网格 → 页脚。本文件负责: 列表加载渲染、
 * 导入 (两段式: 下载/解压出 manifest → 用户确认 → 落盘)、启停/卸载、插件详情
 * 弹窗 (权限/能力/信息)、插件配置弹窗 (渲染 manifest.configUI 声明的设置行,
 * 保存到插件私有存储)。
 *
 * 约定:
 *   - 主进程通道 $aura.plugin.* (见 pluginIpcHandler.js);
 *   - 弹窗 absolute 挂 .aura-config-page-root (fixed 会被外层 transform 劫持);
 *   - 所有动态字符串必须过 escapeMarketHtml (manifest 来自第三方)。
 */

(() => {
  const IPC_BASE = "$aura.plugin";
  const REPORT_CHANNEL = "$aura.plugin.post.installProgress";
  const REPO_URL = "https://github.com/blingbling-bow/HugoAura-Enhanced";

  const TYPE_NAMES = { main: "主进程", ui: "界面" };

  const state = {
    items: [],
    selectedId: null,
    stageId: null,
    listenerInstalled: false,
    busy: false,
    market: { items: [], loaded: false, loading: false },
  };

  const escapeMarketHtml = (value) =>
    String(value === undefined || value === null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const findItem = (id) => state.items.find((i) => i.id === id) || null;

  // >>> 内联线条图标 (feather 风格, stroke=currentColor, 不用 emoji) <<<

  const svg = (inner, cls = "aura-market-svg") =>
    `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;

  const ICONS = {
    checkCircle: svg(
      '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
      "aura-market-svg aura-market-svg-sm"
    ),
    sliders: svg(
      '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
      "aura-market-svg aura-market-svg-sm"
    ),
    user: svg(
      '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
      "aura-market-svg aura-market-svg-sm"
    ),
    globe: svg(
      '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'
    ),
    shield: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
    externalLink: svg(
      '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
      "aura-market-svg aura-market-svg-sm"
    ),
    link: svg(
      '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
      "aura-market-svg aura-market-svg-sm"
    ),
    download: svg(
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
      "aura-market-svg aura-market-svg-sm"
    ),
    alertTriangle: svg(
      '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'
    ),
  };

  // >>> 渲染模板 (纯函数, 便于预览/单测) <<<

  const cardHtml = (item) => {
    const on = item.enabled === true;
    const selected = state.selectedId === item.id ? " is-selected" : "";
    const home = item.homepage
      ? `<a class="aura-market-card-home" data-action="home" href="${escapeMarketHtml(
          item.homepage
        )}" title="访问插件主页" target="_blank">${ICONS.externalLink}</a>`
      : "";
    return `
      <div class="aura-market-card${selected}" data-plugin-id="${escapeMarketHtml(item.id)}" data-on="${on}">
        <div class="aura-market-card-head">
          <p class="aura-market-card-name" title="${escapeMarketHtml(item.name)}">${escapeMarketHtml(item.name)}</p>
          ${home}
          <span class="aura-market-card-version">v${escapeMarketHtml(item.version)}</span>
          <span class="aura-market-state-pill" data-on="${on}">${on ? "已激活" : "未启用"}</span>
        </div>
        <p class="aura-market-card-desc" title="${escapeMarketHtml(item.description)}">${escapeMarketHtml(item.description)}</p>
        <div class="aura-market-card-author">${ICONS.user} ${escapeMarketHtml(item.author)}</div>
        <div class="aura-market-card-actions">
          <button
            type="button"
            class="aura-audit-btn aura-market-btn-toggle"
            data-action="toggle"
            data-on="${on}"
          >${on ? ICONS.checkCircle + " 已启用" : "已停用"}</button>
          <button
            type="button"
            class="aura-audit-btn"
            data-action="config"
            ${item.configUI && item.configUI.length ? "" : "disabled"}
            title="${item.configUI && item.configUI.length ? "打开插件配置" : "该插件未提供配置界面"}"
          >${ICONS.sliders} 配置</button>
          <button
            type="button"
            class="aura-audit-btn aura-market-btn-more"
            data-bs-toggle="dropdown"
            aria-expanded="false"
          >··· 更多</button>
          <ul class="dropdown-menu aura-market-card-menu">
            <li><a class="dropdown-item" data-action="details">查看详情</a></li>
            <li><a class="dropdown-item" data-action="openDir">打开插件目录</a></li>
            <li><a class="dropdown-item" data-action="remove">卸载插件</a></li>
          </ul>
        </div>
      </div>`;
  };

  const cardsHtml = (items) => items.map((item) => cardHtml(item)).join("");

  /** 在线导入弹窗 (URL 输入 → 进度 → manifest 确认, 三态复用同一弹窗) */
  const urlModalHtml = () => `
    <div class="aura-market-modal" id="auraMarketModal">
      <div class="aura-market-modal-card">
        <button type="button" class="aura-market-modal-close" data-modal-action="close">×</button>
        <p class="aura-market-modal-title">在线导入插件</p>
        <p class="aura-market-modal-subtitle">安装前往意安全风险, 请仅从可信来源安装</p>
        <div class="aura-market-modal-body" id="auraMarketModalBody">
          <p>输入插件包 (zip) 的直链地址:</p>
          <input
            type="text"
            class="aura-market-url-input"
            id="auraMarketUrlInput"
            placeholder="https://example.com/path/to/plugin.zip"
            spellcheck="false"
          />
          <div class="aura-market-progress-track" id="auraMarketProgressTrack" style="display: none">
            <div class="aura-market-progress-bar" id="auraMarketProgressBar"></div>
          </div>
          <p id="auraMarketProgressText" style="display: none; margin-top: 6px;"></p>
        </div>
        <div class="aura-market-modal-foot">
          <button type="button" class="aura-audit-btn" data-modal-action="cancel">取消</button>
          <button
            type="button"
            class="aura-audit-btn aura-market-btn-light"
            id="auraMarketUrlStartBtn"
            data-modal-action="start"
          >开始下载</button>
        </div>
      </div>
    </div>`;

  /** 权限 key → 展示信息 (manifest 未提供 label/description 时的兜底) */
  const PERMISSION_INFO = {
    storage: { label: "私有存储", desc: "读写插件自己的持久化设置 (≤256KB)" },
    events: { label: "事件总线", desc: "订阅/发布插件自己命名空间内的事件" },
    network: { label: "联网请求", desc: "经安全校验的 HTTP GET (禁内网/localhost, ≤1MB/10s)" },
    notify: { label: "全局通知", desc: "弹出 Aura 置顶提醒小窗" },
    shortcuts: { label: "全局快捷键", desc: "注册系统级快捷键 (≤8 个, 卸载自动注销)" },
  };

  /** 安装确认弹窗的权限清单 (main 按声明, ui 为类型内建能力) */
  const permRowsHtml = (manifest) => {
    if (manifest.type === "ui") {
      return `
        <div class="aura-market-perm-row">
          <span class="aura-market-perm-icon">${ICONS.checkCircle}</span>
          <div class="aura-market-perm-info">
            <p class="aura-market-perm-name">页面悬浮元素 (声明式 DOM 桥)</p>
          </div>
        </div>
        <div class="aura-market-perm-row">
          <span class="aura-market-perm-icon">${ICONS.checkCircle}</span>
          <div class="aura-market-perm-info">
            <p class="aura-market-perm-name">$aura.plugin.* 白名单 IPC</p>
          </div>
        </div>`;
    }
    const perms = Array.isArray(manifest.permissions) ? manifest.permissions : [];
    if (!perms.length) {
      return '<p class="aura-market-perm-desc" style="padding:2px 0;">该插件未申请额外权限。</p>';
    }
    return perms
      .map((p) => {
        const info = PERMISSION_INFO[p.key] || {
          label: `${p.key} (未识别, 默认不授予)`,
          desc: "",
        };
        const desc = p.description || info.desc || "";
        return `
          <div class="aura-market-perm-row">
            <span class="aura-market-perm-icon">${ICONS.checkCircle}</span>
            <div class="aura-market-perm-info">
              <p class="aura-market-perm-name">${escapeMarketHtml(info.label)}${desc ? ` — ${escapeMarketHtml(desc)}` : ""}</p>
            </div>
          </div>`;
      })
      .join("");
  };

  /** manifest 摘要确认弹窗 (本地导入 / 在线导入共用的第二段):
   *  权限清单 + 风险确认勾选 (未勾选时确认按钮禁用) */
  const confirmModalHtml = (manifest) => `
    <div class="aura-market-modal" id="auraMarketModal">
      <div class="aura-market-modal-card">
        <button type="button" class="aura-market-modal-close" data-modal-action="close">×</button>
        <p class="aura-market-modal-title">确认安装插件</p>
        <p class="aura-market-modal-subtitle">安装前请核对插件信息与权限</p>
        <div class="aura-market-modal-body">
          <div class="aura-market-manifest-meta">
            <p class="meta-key">名称</p><p class="meta-val">${escapeMarketHtml(manifest.name)}</p>
            <p class="meta-key">版本</p><p class="meta-val">v${escapeMarketHtml(manifest.version)}</p>
            <p class="meta-key">作者</p><p class="meta-val">${escapeMarketHtml(manifest.author)}</p>
            <p class="meta-key">类型</p><p class="meta-val">${TYPE_NAMES[manifest.type] || "未知"}</p>
            <p class="meta-key">标识</p><p class="meta-val">${escapeMarketHtml(manifest.id)}</p>
          </div>
          <div class="aura-market-detail-section">
            <p class="aura-market-detail-label">插件将获得的权限</p>
            ${permRowsHtml(manifest)}
          </div>
          <div class="aura-market-perm-ack">
            <input class="form-check-input" type="checkbox" id="auraPluginRiskAck" />
            <label for="auraPluginRiskAck">我已知悉上述权限与风险, 同意安装</label>
          </div>
        </div>
        <div class="aura-market-modal-foot">
          <button type="button" class="aura-audit-btn" data-modal-action="cancel">取消</button>
          <button
            type="button"
            class="aura-audit-btn aura-market-btn-light"
            data-modal-action="confirm-install"
            disabled
          >确认安装</button>
        </div>
      </div>
    </div>`;

  const PERMISSION_ICONS = { network: ICONS.globe, storage: ICONS.shield };
  const PERMISSION_ICON_DEFAULT = ICONS.shield;

  /** 插件详情弹窗 (简介 / 权限 / 能力 / 信息) */
  const detailsModalHtml = (item) => {
    const permRows = (item.permissions || [])
      .map((perm) => {
        const on = item.permissionState ? item.permissionState[perm.key] !== false : true;
        const icon = PERMISSION_ICONS[perm.key] || PERMISSION_ICON_DEFAULT;
        return `
          <div class="aura-market-perm-row">
            <span class="aura-market-perm-icon">${icon}</span>
            <div class="aura-market-perm-info">
              <p class="aura-market-perm-name">${escapeMarketHtml(perm.label)}</p>
              <p class="aura-market-perm-desc">${escapeMarketHtml(
                perm.description || "允许插件使用该能力"
              )}（停用并重新启用后生效）</p>
            </div>
            <div class="form-check form-switch">
              <input
                class="form-check-input"
                type="checkbox"
                role="switch"
                data-perm-key="${escapeMarketHtml(perm.key)}"
                data-perm-on="${on}"
                ${on ? "checked" : ""}
              />
            </div>
          </div>`;
      })
      .join("");

    const caps = item.capabilities || {};
    const capRows = [];
    if (Array.isArray(caps.events) && caps.events.length) {
      capRows.push(
        `<div class="aura-market-cap-row"><span class="aura-market-cap-key">事件</span><span class="aura-market-cap-val">${escapeMarketHtml(
          caps.events.join("、")
        )}</span></div>`
      );
    }
    if (item.configUI && item.configUI.length) {
      capRows.push(
        `<div class="aura-market-cap-row"><span class="aura-market-cap-key">设置项</span><span class="aura-market-cap-val">${item.configUI.length}</span></div>`
      );
    }

    const time = item.installedAt
      ? new Date(item.installedAt).toLocaleDateString("zh-CN")
      : "—";

    return `
      <div class="aura-market-modal" id="auraMarketModal">
        <div class="aura-market-modal-card">
          <button type="button" class="aura-market-modal-close" data-modal-action="close">×</button>
          <p class="aura-market-modal-title">插件详情</p>
          <div class="aura-market-modal-body">
            <div class="aura-market-detail-section">
              <p class="aura-market-card-name">${escapeMarketHtml(item.name)}
                <span class="aura-market-card-version" style="margin-left: 6px;">v${escapeMarketHtml(item.version)}</span>
              </p>
              ${item.homepage ? `<a class="aura-market-link" data-action="home" href="${escapeMarketHtml(item.homepage)}" target="_blank">${ICONS.link} 插件主页</a>` : ""}
            </div>
            <div class="aura-market-detail-section">
              <p class="aura-market-detail-label">简介</p>
              <p class="aura-market-detail-desc">${escapeMarketHtml(item.description)}</p>
            </div>
            ${
              item.permissions && item.permissions.length
                ? `<div class="aura-market-detail-section">
                     <p class="aura-market-detail-label">权限</p>
                     ${permRows}
                   </div>`
                : ""
            }
            ${
              capRows.length
                ? `<div class="aura-market-detail-section">
                     <p class="aura-market-detail-label">能力</p>
                     ${capRows.join("")}
                   </div>`
                : ""
            }
            <div class="aura-market-detail-section">
              <p class="aura-market-detail-label">信息</p>
              <div class="aura-market-info-grid">
                <div><span class="aura-market-cap-key">ID</span><span class="aura-market-cap-val" title="${escapeMarketHtml(item.id)}">${escapeMarketHtml(item.id)}</span></div>
                <div><span class="aura-market-cap-key">作者</span><span class="aura-market-cap-val">${escapeMarketHtml(item.author)}</span></div>
                <div><span class="aura-market-cap-key">API 等级</span><span class="aura-market-cap-val">${escapeMarketHtml(item.apiLevel)}</span></div>
                <div><span class="aura-market-cap-key">安装</span><span class="aura-market-cap-val">${escapeMarketHtml(time)}</span></div>
                <div><span class="aura-market-cap-key">更新</span><span class="aura-market-cap-val">—</span></div>
              </div>
            </div>
          </div>
          <div class="aura-market-modal-foot">
            <button type="button" class="aura-audit-btn" data-modal-action="close">关闭</button>
          </div>
        </div>
      </div>`;
  };

  /**
   * 插件配置弹窗: 渲染 manifest.configUI 声明的设置行。
   * @param {any} item 列表项
   * @param {any[]} schema configUI 声明
   * @param {any} values 已保存的设置值
   */
  const configModalHtml = (item, schema, values) => {
    const rows = schema
      .map((row) => {
        const value = values ? values[row.key] : undefined;
        const desc = row.description
          ? `<p class="aura-market-config-row-desc">${escapeMarketHtml(row.description)}</p>`
          : row.placeholder && row.type === "input"
            ? `<p class="aura-market-config-row-desc">占位符: ${escapeMarketHtml(row.placeholder)}</p>`
            : "";

        let control = "";
        if (row.type === "select") {
          const options = (row.options || [])
            .map(
              (opt) =>
                `<option value="${escapeMarketHtml(opt)}" ${
                  String(value) === String(opt) ? "selected" : ""
                }>${escapeMarketHtml(opt)}</option>`
            )
            .join("");
          control = `<select class="aura-market-config-select" data-config-key="${escapeMarketHtml(row.key)}">${options}</select>`;
        } else if (row.type === "switch") {
          control = `<div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" role="switch" data-config-key="${escapeMarketHtml(row.key)}" ${value ? "checked" : ""} />
          </div>`;
        } else {
          control = `<input
            type="text"
            class="aura-market-config-input"
            data-config-key="${escapeMarketHtml(row.key)}"
            value="${escapeMarketHtml(value !== undefined ? value : row.defaultValue !== undefined ? row.defaultValue : "")}"
            placeholder="${escapeMarketHtml(row.placeholder || "")}"
            spellcheck="false"
          />`;
        }

        return `
          <div class="aura-market-config-row">
            <div class="aura-market-config-row-info">
              <p class="aura-market-config-row-label">${escapeMarketHtml(row.label)}</p>
              ${desc}
            </div>
            <div class="aura-market-config-row-control">${control}</div>
          </div>`;
      })
      .join("");

    return `
      <div class="aura-market-modal" id="auraMarketModal">
        <div class="aura-market-modal-card">
          <button type="button" class="aura-market-modal-close" data-modal-action="close">×</button>
          <p class="aura-market-modal-title">${escapeMarketHtml(item.name)}</p>
          <p class="aura-market-modal-subtitle">插件配置</p>
          <div class="aura-market-modal-body">
            ${rows || '<p>该插件未提供配置项。</p>'}
          </div>
          <div class="aura-market-modal-foot">
            <button type="button" class="aura-audit-btn" data-modal-action="close">关闭</button>
            <button
              type="button"
              class="aura-audit-btn aura-market-btn-light"
              data-modal-action="save-config"
            >保存</button>
          </div>
        </div>
      </div>`;
  };

  // >>> 插件市场 (在线清单) 模板 <<<

  /**
   * 市场卡片: 与已安装卡片同构, 动作区为 安装/更新/已安装。
   * entry 来自市场清单 (主进程已校验), installState: available | upgradable | installed
   */
  const marketCardHtml = (entry) => {
    const statePill =
      entry.installState === "installed"
        ? '<span class="aura-market-state-pill" data-on="true">已安装</span>'
        : entry.installState === "upgradable"
          ? '<span class="aura-market-state-pill" data-tone="warning">可更新</span>'
          : "";
    const home = entry.homepage
      ? `<a class="aura-market-card-home" data-action="home" href="${escapeMarketHtml(
          entry.homepage
        )}" title="访问插件主页" target="_blank">${ICONS.externalLink}</a>`
      : "";
    const installBtn =
      entry.installState === "installed"
        ? `<button
            type="button"
            class="aura-audit-btn"
            disabled
            title="已安装相同版本 (v${escapeMarketHtml(entry.installedVersion)})"
          >${ICONS.checkCircle} 已安装</button>`
        : `<button
            type="button"
            class="aura-audit-btn aura-about-btn-accent"
            data-action="market-install"
          >${ICONS.download} ${entry.installState === "upgradable" ? "更新" : "安装"}</button>`;
    return `
      <div class="aura-market-card" data-market-id="${escapeMarketHtml(entry.id)}">
        <div class="aura-market-card-head">
          <p class="aura-market-card-name" title="${escapeMarketHtml(entry.name)}">${escapeMarketHtml(entry.name)}</p>
          ${home}
          <span class="aura-market-card-version">${TYPE_NAMES[entry.type] || "未知"}</span>
          <span class="aura-market-card-version">v${escapeMarketHtml(entry.version)}</span>
          ${statePill}
        </div>
        <p class="aura-market-card-desc" title="${escapeMarketHtml(entry.description)}">${escapeMarketHtml(entry.description)}</p>
        <div class="aura-market-card-author">${ICONS.user} ${escapeMarketHtml(entry.author || "未知作者")}</div>
        <div class="aura-market-card-actions">${installBtn}</div>
      </div>`;
  };

  /** 市场安装进度弹窗 (下载阶段无法中断, 暂存完成后进入确认弹窗) */
  const marketProgressModalHtml = (name) => `
    <div class="aura-market-modal" id="auraMarketModal">
      <div class="aura-market-modal-card">
        <button type="button" class="aura-market-modal-close" data-modal-action="close">×</button>
        <p class="aura-market-modal-title">安装插件</p>
        <p class="aura-market-modal-subtitle">${escapeMarketHtml(name)}</p>
        <div class="aura-market-modal-body">
          <p>正在从插件市场下载插件包...</p>
          <div class="aura-market-progress-track" id="auraMarketProgressTrack">
            <div class="aura-market-progress-bar" id="auraMarketProgressBar"></div>
          </div>
          <p id="auraMarketProgressText" style="margin-top: 6px;"></p>
        </div>
      </div>
    </div>`;

  /** 卸载确认弹窗 */
  const removeModalHtml = (item) => `
    <div class="aura-market-modal" id="auraMarketModal" data-remove-id="${escapeMarketHtml(item.id)}">
      <div class="aura-market-modal-card">
        <button type="button" class="aura-market-modal-close" data-modal-action="close">×</button>
        <p class="aura-market-modal-title">卸载插件</p>
        <div class="aura-market-modal-body">
          <p>确定卸载 <b>${escapeMarketHtml(item.name)}</b> (v${escapeMarketHtml(item.version)}) 吗？</p>
          <p>插件目录与其数据将被删除, 该操作不可恢复。</p>
        </div>
        <div class="aura-market-modal-foot">
          <button type="button" class="aura-audit-btn" data-modal-action="cancel">取消</button>
          <button
            type="button"
            class="aura-audit-btn aura-audit-btn-danger"
            data-modal-action="confirm-remove"
          >卸载</button>
        </div>
      </div>
    </div>`;

  /** 错误提示弹窗 */
  const errorModalHtml = (message) => `
    <div class="aura-market-modal" id="auraMarketModal">
      <div class="aura-market-modal-card">
        <button type="button" class="aura-market-modal-close" data-modal-action="close">×</button>
        <p class="aura-market-modal-title">导入失败</p>
        <div class="aura-market-modal-body">
          <p>${escapeMarketHtml(message)}</p>
          <p>请确认插件包为合法的 zip (内含 manifest.json), 在线导入时确认 URL 可直连下载。</p>
        </div>
        <div class="aura-market-modal-foot">
          <button type="button" class="aura-audit-btn" data-modal-action="close">知道了</button>
        </div>
      </div>
    </div>`;

  // >>> DOM 辅助 <<<

  const rootEl = () => document.getElementById("acs-plugins-root-el");

  const openModal = (html) => {
    const host = document.querySelector(".aura-config-page-root") || document.body;
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    const modal = wrap.firstElementChild;
    host.appendChild(modal);
    if (!document.querySelector(".aura-config-page-root")) {
      // 兜底: 挂在 body 上时 transform 劫持不存在, fixed 也可用
      modal.style.position = "fixed";
    }
    return modal;
  };

  /** 关闭弹窗并作废当前暂存的安装 (stageId)。调用方若需继续安装流程,
   *  必须在此之后重新赋值 state.stageId, 否则「确认安装」会静默返回。 */
  const closeModal = () => {
    document.querySelectorAll(".aura-market-modal").forEach((el) => el.remove());
    state.stageId = null;
  };

  const setStatus = (text) => {
    const el = document.getElementById("auraMarketProgressText");
    if (el) el.textContent = text;
  };

  // >>> 数据操作 <<<

  const refreshList = async () => {
    const emptyTitleEl = document.querySelector(
      "#auraMarketEmpty .aura-market-empty-title"
    );
    const emptyDescEl = document.querySelector(
      "#auraMarketEmpty .aura-market-empty-desc"
    );
    try {
      const res = await global.ipcRenderer.invoke(`${IPC_BASE}.list`);
      state.items = res && res.success ? res.data || [] : [];
      if (emptyTitleEl) {
        emptyTitleEl.textContent = "还没有安装任何插件";
        if (emptyDescEl) {
          emptyDescEl.textContent =
            "点击上方「本地导入」选择插件 zip 包，或使用「在线导入」从 URL 安装。";
        }
      }
    } catch (err) {
      console.error("[HugoAura / Market] Failed to load plugin list:", err);
      state.items = [];
      // 典型场景: 更新 aura 包后未重启管家, 主进程仍跑旧代码 (无插件 IPC)
      if (emptyTitleEl) emptyTitleEl.textContent = "插件服务不可用";
      if (emptyDescEl) {
        emptyDescEl.textContent = `与主进程通信失败 (${String(
          err && err.message ? err.message : err
        )}), 请重启希沃管家后重试`;
      }
    }
    renderCards();
  };

  const renderCards = () => {
    const cardsEl = document.getElementById("auraMarketCards");
    const emptyEl = document.getElementById("auraMarketEmpty");
    if (!cardsEl || !emptyEl) return;
    cardsEl.innerHTML = cardsHtml(state.items);
    emptyEl.style.display = state.items.length ? "none" : "";

    // 页头数量概览
    const installedEl = document.getElementById("auraMarketStatInstalled");
    const enabledEl = document.getElementById("auraMarketStatEnabled");
    if (installedEl) installedEl.textContent = String(state.items.length);
    if (enabledEl) {
      enabledEl.textContent = String(
        state.items.filter((item) => item.enabled === true).length
      );
    }
  };

  // >>> 插件市场 (在线清单) <<<

  const renderMarketCards = () => {
    const cardsEl = document.getElementById("auraMarketMarketCards");
    if (!cardsEl) return;
    cardsEl.innerHTML = state.market.items
      .map((entry) => marketCardHtml(entry))
      .join("");
  };

  /**
   * 市场区状态条 (加载中 / 失败 / 空清单); kind=hidden 时隐藏并显示卡片。
   */
  const setMarketStatus = (kind, message) => {
    const wrap = document.getElementById("auraMarketMarketStatus");
    const cardsEl = document.getElementById("auraMarketMarketCards");
    const iconEl = document.getElementById("auraMarketMarketStatusIcon");
    const titleEl = document.getElementById("auraMarketMarketStatusTitle");
    const descEl = document.getElementById("auraMarketMarketStatusDesc");
    const retryBtn = document.getElementById("auraMarketRetryBtn");
    if (!wrap || !cardsEl) return;
    if (kind === "hidden") {
      wrap.style.display = "none";
      return;
    }
    cardsEl.innerHTML = "";
    wrap.style.display = "";
    if (iconEl) {
      iconEl.innerHTML = kind === "error" ? ICONS.alertTriangle : ICONS.globe;
    }
    if (titleEl) {
      titleEl.textContent =
        kind === "loading"
          ? "正在获取插件市场清单..."
          : kind === "error"
            ? "插件市场加载失败"
            : "市场暂无上架插件";
    }
    if (descEl) {
      descEl.textContent =
        message ||
        (kind === "loading"
          ? "清单从 GitHub 及其镜像拉取, 首次加载可能较慢"
          : kind === "empty"
            ? "可以先用「本地导入 / 在线导入」安装插件, 或稍后再来看看"
            : "");
    }
    if (retryBtn) retryBtn.style.display = kind === "error" ? "" : "none";
  };

  /**
   * 拉取并渲染市场清单。首次加载显示状态条; 已加载后的静默刷新
   * (安装完成后同步安装状态) 失败时保留旧卡片不打断用户。
   */
  const loadMarketList = async (force = false) => {
    if (state.market.loading) return;
    state.market.loading = true;
    const isFirstLoad = !state.market.loaded;
    if (isFirstLoad) setMarketStatus("loading");
    try {
      const res = await global.ipcRenderer.invoke(`${IPC_BASE}.marketList`, {
        force,
      });
      if (res && res.success) {
        state.market.items = res.data.items || [];
        state.market.loaded = true;
        if (state.market.items.length) {
          setMarketStatus("hidden");
          renderMarketCards();
        } else {
          setMarketStatus("empty");
        }
      } else if (isFirstLoad) {
        setMarketStatus("error", String((res && res.error) || "网络不可用"));
      } else {
        console.warn(
          "[HugoAura / Market] Market refresh failed:",
          res && res.error
        );
      }
    } catch (err) {
      if (isFirstLoad) setMarketStatus("error", String(err));
      else console.warn("[HugoAura / Market] Market refresh failed:", err);
    } finally {
      state.market.loading = false;
    }
  };

  const togglePlugin = async (id, enabled) => {
    if (state.busy) return;
    state.busy = true;
    try {
      const res = await global.ipcRenderer.invoke(
        `${IPC_BASE}.${enabled ? "enable" : "disable"}`,
        { id }
      );
      if (!res || !res.success) {
        console.error("[HugoAura / Market] Toggle failed:", res && res.error);
      }
    } catch (err) {
      console.error("[HugoAura / Market] Toggle failed:", err);
    } finally {
      state.busy = false;
      await refreshList();
    }
  };

  const removePlugin = async (id) => {
    if (state.busy) return;
    state.busy = true;
    try {
      await global.ipcRenderer.invoke(`${IPC_BASE}.remove`, { id });
    } catch (err) {
      console.error("[HugoAura / Market] Remove failed:", err);
    } finally {
      state.busy = false;
      await refreshList();
    }
  };

  /** 打开插件详情弹窗 */
  const openDetails = (item) => {
    closeModal();
    openModal(detailsModalHtml(item));
  };

  /** 打开插件配置弹窗 (拉取 schema + 已存值) */
  const openConfig = async (item) => {
    if (state.busy) return;
    state.busy = true;
    try {
      const res = await global.ipcRenderer.invoke(`${IPC_BASE}.getConfig`, { id: item.id });
      if (res && res.success) {
        closeModal();
        openModal(configModalHtml(item, res.data.schema || [], res.data.values || {}));
      } else {
        console.error("[HugoAura / Market] Get config failed:", res && res.error);
      }
    } catch (err) {
      console.error("[HugoAura / Market] Get config failed:", err);
    } finally {
      state.busy = false;
    }
  };

  /** 收集配置弹窗里的控件值并保存 */
  const savePluginConfig = async (id) => {
    const modal = document.querySelector(".aura-market-modal");
    if (!modal) return;
    const values = {};
    modal.querySelectorAll("[data-config-key]").forEach((control) => {
      const key = control.getAttribute("data-config-key");
      if (control.type === "checkbox") values[key] = control.checked;
      else values[key] = control.value;
    });
    try {
      const res = await global.ipcRenderer.invoke(`${IPC_BASE}.saveConfig`, { id, values });
      if (!res || !res.success) {
        console.error("[HugoAura / Market] Save config failed:", res && res.error);
      }
    } catch (err) {
      console.error("[HugoAura / Market] Save config failed:", err);
    }
  };

  /** 保存权限开关 */
  const savePermission = async (id, key, enabled) => {
    try {
      await global.ipcRenderer.invoke(`${IPC_BASE}.setPermission`, { id, key, enabled });
      const item = findItem(id);
      if (item) {
        item.permissionState = item.permissionState || {};
        item.permissionState[key] = enabled;
      }
    } catch (err) {
      console.error("[HugoAura / Market] Set permission failed:", err);
    }
  };

  /** 确认安装当前暂存 (两段式的第二段) */
  const confirmInstall = async () => {
    if (!state.stageId || state.busy) return;
    state.busy = true;
    try {
      const res = await global.ipcRenderer.invoke(`${IPC_BASE}.confirmInstall`, {
        stageId: state.stageId,
      });
      if (res && res.success) {
        closeModal();
        await refreshList();
        // 市场卡片的 已安装/可更新 状态同步 (走主进程缓存, 无网络开销)
        loadMarketList(false);
      } else {
        // 确认弹窗里没有进度文本元素, 失败必须用错误弹窗呈现
        closeModal();
        openModal(
          errorModalHtml(`安装失败: ${(res && res.error) || "未知错误"}`)
        );
      }
    } catch (err) {
      closeModal();
      openModal(errorModalHtml(`安装失败: ${String(err)}`));
    } finally {
      state.busy = false;
    }
  };

  const startUrlInstall = async () => {
    if (state.busy) return;
    const input = document.getElementById("auraMarketUrlInput");
    const url = input ? input.value.trim() : "";
    if (!url) {
      setStatus("请先输入插件包 URL");
      return;
    }

    const track = document.getElementById("auraMarketProgressTrack");
    const bar = document.getElementById("auraMarketProgressBar");
    const startBtn = document.getElementById("auraMarketUrlStartBtn");
    if (track) track.style.display = "";
    if (startBtn) startBtn.disabled = true;
    state.busy = true;

    try {
      const res = await global.ipcRenderer.invoke(`${IPC_BASE}.installFromUrl`, {
        url,
        reportTo: "assistant",
      });
      if (res && res.success) {
        // 同上: closeModal 置空 stageId, 顺序必须是先关弹窗再暂存
        closeModal();
        state.stageId = res.data.stageId;
        openModal(confirmModalHtml(res.data.manifest));
      } else {
        setStatus(`导入失败: ${(res && res.error) || "未知错误"}`);
        if (startBtn) startBtn.disabled = false;
      }
    } catch (err) {
      setStatus(`导入失败: ${String(err)}`);
      if (startBtn) startBtn.disabled = false;
    } finally {
      state.busy = false;
    }
  };

  /** 从市场安装: 在线包走 installFromUrl, 包内本地包走 installFromPath,
   *  两者都进入相同的两段式流程 (暂存 → 确认弹窗 → 落盘) */
  const startMarketInstall = async (entry) => {
    if (state.busy) return;
    state.busy = true;
    const isLocal = entry.local || !/^https?:\/\//i.test(entry.downloadUrl || "");
    try {
      closeModal();
      openModal(marketProgressModalHtml(entry.name));
      const res = await global.ipcRenderer.invoke(
        `${IPC_BASE}.${isLocal ? "installFromPath" : "installFromUrl"}`,
        isLocal
          ? { path: entry.downloadUrl }
          : {
              url: entry.downloadUrl,
              sha256: entry.sha256,
              reportTo: "assistant",
            }
      );
      if (res && res.success) {
        // 同上: closeModal 置空 stageId, 顺序必须是先关弹窗再暂存
        closeModal();
        state.stageId = res.data.stageId;
        openModal(confirmModalHtml(res.data.manifest));
      } else {
        closeModal();
        openModal(
          errorModalHtml(
            `从市场安装失败: ${(res && res.error) || "未知错误"}`
          )
        );
      }
    } catch (err) {
      closeModal();
      openModal(errorModalHtml(`从市场安装失败: ${String(err)}`));
    } finally {
      state.busy = false;
    }
  };

  // >>> 事件绑定 <<<

  const bindEvents = () => {
    const root = rootEl();
    if (!root) return;

    const importLocalBtn = document.getElementById("auraMarketImportLocalBtn");
    const importUrlBtn = document.getElementById("auraMarketImportUrlBtn");
    if (importLocalBtn) {
      importLocalBtn.addEventListener("click", async () => {
        if (state.busy) return;
        try {
          const res = await global.ipcRenderer.invoke(`${IPC_BASE}.installLocal`);
          if (res && res.success) {
            // closeModal 会清空 state.stageId: 必须先卸载旧弹窗再暂存 stageId,
            // 否则「确认安装」会因 stageId 为空而静默返回 (点了没反应)。
            closeModal();
            state.stageId = res.data.stageId;
            openModal(confirmModalHtml(res.data.manifest));
          } else if (res && res.error !== "CANCELED") {
            closeModal();
            openModal(errorModalHtml(String((res && res.error) || "未知错误")));
          }
        } catch (err) {
          // invoke 抛错 (典型: 主进程未含插件 IPC, 需重启管家) 必须可见
          closeModal();
          openModal(errorModalHtml(`本地导入失败: ${String(err)}`));
        }
      });
    }

    if (importUrlBtn) {
      importUrlBtn.addEventListener("click", () => {
        closeModal();
        openModal(urlModalHtml());
      });
    }

    // 卡片区事件委托: 有 data-action 的走动作; 否则点卡片空白处 = 查看详情
    const cardsEl = document.getElementById("auraMarketCards");
    if (cardsEl) {
      cardsEl.addEventListener("click", (event) => {
        const cardEl =
          event.target && typeof event.target.closest === "function"
            ? event.target.closest("[data-plugin-id]")
            : null;
        if (!cardEl) return;
        const id = cardEl.getAttribute("data-plugin-id");
        const item = findItem(id);
        if (!item) return;

        const actionEl =
          event.target && typeof event.target.closest === "function"
            ? event.target.closest("[data-action]")
            : null;

        if (!actionEl) {
          state.selectedId = item.id;
          renderCards();
          openDetails(item);
          return;
        }

        const action = actionEl.getAttribute("data-action");
        if (action === "toggle") {
          togglePlugin(item.id, !item.enabled);
        } else if (action === "config") {
          openConfig(item);
        } else if (action === "details") {
          openDetails(item);
        } else if (action === "openDir") {
          global.ipcRenderer.invoke(`${IPC_BASE}.openDir`).catch(() => {});
        } else if (action === "remove") {
          closeModal();
          openModal(removeModalHtml(item));
        }
      });
    }

    // 市场卡片区: 只处理安装/更新动作 (主页外链由全局 openExternal 兜住)
    const marketCardsEl = document.getElementById("auraMarketMarketCards");
    if (marketCardsEl) {
      marketCardsEl.addEventListener("click", (event) => {
        const actionEl =
          event.target && typeof event.target.closest === "function"
            ? event.target.closest("[data-action]")
            : null;
        if (!actionEl) return;
        if (actionEl.getAttribute("data-action") !== "market-install") return;
        const cardEl = actionEl.closest("[data-market-id]");
        const id = cardEl ? cardEl.getAttribute("data-market-id") : "";
        const entry = state.market.items.find((i) => i.id === id);
        if (entry) startMarketInstall(entry);
      });
    }

    // 切到市场 tab 时拉取清单 (主进程侧有缓存, 重复切 tab 无网络开销)
    const marketTabBtn = document.getElementById("aura-market-market-tab");
    if (marketTabBtn) {
      marketTabBtn.addEventListener("click", () => {
        loadMarketList(false);
      });
    }

    const retryBtn = document.getElementById("auraMarketRetryBtn");
    if (retryBtn) {
      retryBtn.addEventListener("click", () => {
        loadMarketList(true);
      });
    }

    // 弹窗内交互 (统一委托): 关闭/开始下载/确认安装/保存配置/卸载/权限开关
    document.addEventListener("click", (event) => {
      const modal = document.querySelector(".aura-market-modal");
      if (!modal) return;

      // 权限开关 (details 弹窗)
      const permSwitch =
        event.target && typeof event.target.closest === "function"
          ? event.target.closest("[data-perm-key]")
          : null;
      if (permSwitch && modal.contains(permSwitch)) {
        const id = state.selectedId || "";
        const key = permSwitch.getAttribute("data-perm-key");
        savePermission(id, key, permSwitch.checked);
        return;
      }

      const actionEl =
        event.target && typeof event.target.closest === "function"
          ? event.target.closest("[data-modal-action]")
          : null;
      if (!actionEl || !modal.contains(actionEl)) return;
      const action = actionEl.getAttribute("data-modal-action");

      if (action === "close" || action === "cancel") {
        if (action === "cancel" && state.stageId) {
          global.ipcRenderer.invoke(`${IPC_BASE}.cancelInstall`, { stageId: state.stageId }).catch(() => {});
        }
        closeModal();
      } else if (action === "start") {
        startUrlInstall();
      } else if (action === "confirm-install") {
        // 风险确认勾选保护: 未勾选时确认按钮本已禁用, 此处再兜底一层
        const ackEl = document.getElementById("auraPluginRiskAck");
        if (ackEl && !ackEl.checked) {
          console.warn("[HugoAura / Market] 请先勾选风险确认后再安装");
          return;
        }
        confirmInstall();
      } else if (action === "confirm-remove") {
        const targetId = modal.getAttribute("data-remove-id") || "";
        if (targetId) removePlugin(targetId);
        closeModal();
      } else if (action === "save-config") {
        const item = findItem(state.selectedId);
        if (item) savePluginConfig(item.id);
        closeModal();
      }
    });

    // Esc 关闭弹窗
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && document.querySelector(".aura-market-modal")) {
        if (state.stageId) {
          global.ipcRenderer.invoke(`${IPC_BASE}.cancelInstall`, { stageId: state.stageId }).catch(() => {});
        }
        closeModal();
      }
    });

    // 外链 (插件文档 / 前往发布 / 插件主页): 经主进程安全校验后用系统浏览器打开
    root.addEventListener("click", (event) => {
      const linkEl =
        event.target && typeof event.target.closest === "function"
          ? event.target.closest("a[href^='http']")
          : null;
      if (!linkEl) return;
      const url = linkEl.getAttribute("href") || "";
      if (!url) return;
      event.preventDefault();
      global.ipcRenderer
        .invoke("$aura.base.openExternal", { url: url || REPO_URL })
        .catch(() => {});
    });

    // 安装进度订阅 (只装一次)
    if (!state.listenerInstalled && global.ipcRenderer && global.ipcRenderer.on) {
      state.listenerInstalled = true;
      global.ipcRenderer.on(REPORT_CHANNEL, (_event, payload) => {
        if (!payload || !document.querySelector(".aura-market-modal")) return;
        if (payload.stage === "download") {
          const bar = document.getElementById("auraMarketProgressBar");
          const track = document.getElementById("auraMarketProgressTrack");
          if (track) track.style.display = "";
          if (bar && payload.totalBytes) {
            bar.style.width = `${Math.min(100, payload.progress || 0)}%`;
          } else if (bar) {
            bar.style.width = "50%"; // 无 content-length: 不确定进度
          }
          setStatus(`下载中 ${payload.curBytes || 0} / ${payload.totalBytes || "?"} 字节`);
        } else if (payload.stage === "extract") {
          setStatus("正在解压插件包...");
        } else if (payload.stage === "failed") {
          setStatus(`导入失败: ${payload.message || "未知错误"}`);
        }
      });
    }
  };

  const onMounted = () => {
    if (!rootEl()) return;
    if (!global.ipcRenderer) {
      global.ipcRenderer = require("electron").ipcRenderer;
    }
    bindEvents();
    refreshList();
    setTimeout(() => {
      const el = rootEl();
      if (el) el.classList.remove("acs-plugins-root-hidden");
    }, 500);
  };

  // 浏览器 (注入页) 环境立即初始化; Node (离线预览/单测 require 本文件) 无
  // document, 跳过自执行只取模板函数
  if (typeof document !== "undefined") {
    onMounted();
  }

  // 纯渲染函数导出 (离线预览 / 单测复用, 与 auditLog 同法)
  module.exports = {
    cardHtml,
    cardsHtml,
    urlModalHtml,
    confirmModalHtml,
    detailsModalHtml,
    configModalHtml,
    removeModalHtml,
    errorModalHtml,
    marketCardHtml,
    marketProgressModalHtml,
    escapeMarketHtml,
  };
})();
