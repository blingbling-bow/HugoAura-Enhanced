// @ts-check

/**
 * 插件市场页离线预览 (只读, 仅用于设计评审)。
 *
 * 用法:
 *   node scripts/plugins-preview.js [输出目录] [宽] [高] [模式]
 *
 * 模式:
 *   installed    已安装 tab + 卡片网格 (默认)
 *   market       插件市场 tab (占位态)
 *   url-modal    在线导入弹窗 (URL 输入态)
 *   confirm-modal 安装确认弹窗 (manifest 摘要)
 *   remove-modal 卸载确认弹窗
 *
 * 与 audit-preview.js 同一思路: 把**真实的**样式表与**真实的**渲染函数
 * (plugins.js 导出的模板) 拼成静态页面, 再用无头 Chrome 截图。
 */

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const market = require("../src/aura/ui/pages/configSubPages/plugins/plugins.js");

const cssFiles = [
  "src/aura/ui/bootstrap/bootstrap.min.css",
  "src/aura/ui/css/form.css",
  "src/aura/ui/pages/configSubPages/plugins/plugins.css",
];

/** 与用户参考截图同风格的模拟数据 */
const MOCK_PLUGINS = [
  {
    id: "com.splayer.nowplaying",
    name: "Now Playing 推送",
    version: "1.0.1",
    author: "SPlayer",
    description: "切歌时把当前播放信息推送到 Webhook，支持 Discord 与通用 JSON。",
    type: "main",
    enabled: true,
    homepage: "https://github.com/splayer/nowplaying",
    apiLevel: 1,
    installedAt: "2026-07-23T02:00:00.000Z",
    configUI: [
      { key: "webhook", label: "Webhook 地址", type: "input", placeholder: "https://discord.com/api/" },
      { key: "mode", label: "推送模式", type: "select", options: ["Discord Webhook", "通用 JSON"] },
      { key: "template", label: "消息模板", type: "input", placeholder: "{title} {artists} {album}" },
    ],
    permissions: [
      { key: "network", label: "联网", description: "插件可发起网络请求" },
    ],
    capabilities: { events: ["trackChange"] },
    permissionState: { network: true },
  },
  {
    id: "com.winddrift.asus",
    name: "ASUS 键盘背光联动",
    version: "1.0.0",
    author: "WindDrift",
    description: "监听当前播放歌曲封面变化，通过本地桥接服务将封面主题色应用到华硕键盘背光。",
    type: "main",
    enabled: true,
    apiLevel: 1,
    installedAt: "2026-07-23T02:00:00.000Z",
    configUI: [],
    permissions: [],
    capabilities: {},
    permissionState: {},
  },
  {
    id: "com.imsyy.classland",
    name: "Classland 联动",
    version: "1.0.5",
    author: "imsyy & WindDrift",
    description: "把当前歌词推送到 Classland 主界面。",
    type: "ui",
    enabled: true,
    apiLevel: 1,
    installedAt: "2026-07-24T02:00:00.000Z",
    configUI: [],
    permissions: [],
    capabilities: {},
    permissionState: {},
  },
  {
    id: "com.apple.ttml",
    name: "AM TTML Fetch",
    version: "1.0.5",
    author: "1412",
    description: "搜索 Apple Music 并获取 TTML 逐字歌词（含翻译/音译）。",
    type: "main",
    enabled: true,
    apiLevel: 1,
    installedAt: "2026-07-24T02:00:00.000Z",
    configUI: [],
    permissions: [
      { key: "network", label: "联网", description: "插件可发起网络请求" },
    ],
    capabilities: { events: ["trackChange"] },
    permissionState: { network: true },
  },
  {
    id: "com.hsij.banchen",
    name: "ChKsS 音源",
    version: "0.8.2",
    author: "HSI-BanFan",
    description: "为 SPlayer-Next 解析网易云 / QQ 音乐 音源：超清母带、Hi-Res、无损，无版权歌曲自动跨平台兜底。",
    type: "main",
    enabled: false,
    apiLevel: 1,
    installedAt: "2026-07-25T02:00:00.000Z",
    configUI: [],
    permissions: [],
    capabilities: {},
    permissionState: {},
  },
  {
    id: "com.guailie.lx",
    name: "洛雪音乐(扊扅听歌)",
    version: "1.0.0",
    author: "Guailie",
    description: "从 @UnlockNeteaseMusic/server 移植而来 音质仅 Lossless(低无损)和320K(较高)。",
    type: "ui",
    enabled: false,
    apiLevel: 1,
    installedAt: "2026-07-25T02:00:00.000Z",
    configUI: [],
    permissions: [],
    capabilities: {},
    permissionState: {},
  },
  {
    id: "com.ltruth.osu",
    name: "osu! 谱面搜索",
    version: "1.0.0",
    author: "LTruth",
    description: "在歌曲菜单里一键搜索当前歌曲的 osu! 谱面。",
    type: "main",
    enabled: false,
    apiLevel: 1,
    installedAt: "2026-07-26T02:00:00.000Z",
    configUI: [],
    permissions: [],
    capabilities: {},
    permissionState: {},
  },
];

const DEMO_MANIFEST = {
  id: "com.splayer.nowplaying",
  name: "Now Playing 推送",
  version: "1.0.1",
  author: "SPlayer",
  type: "main",
};

const MOCK_SETTINGS = {
  webhook: "https://discord.com/api/",
  mode: "Discord Webhook",
  template: "🎵 正在收听：{title} - {artists}",
};

const main = () => {
  const outDir = process.argv[2] || path.join(root, "Artifacts", "preview");
  const width = Number(process.argv[3] || 864);
  const height = Number(process.argv[4] || 580);
  const mode = process.argv[5] || "installed";

  // 真实页面 DOM (plugins.html), 预览复用同一份
  let page = fs.readFileSync(
    path.join(root, "src/aura/ui/pages/configSubPages/plugins/plugins.html"),
    "utf8"
  );

  // 入场淡入由 JS 延时移除 hidden 类, 静态预览直接摘掉, 否则截到透明中间态
  page = page.replace(" acs-plugins-root-hidden", "");

  /** 页头数量概览: 静态预览按 mock 数据填, 真实环境由 plugins.js 渲染 */
  const fillStats = (installed, enabled) => {
    page = page
      .replace(
        '<b id="auraMarketStatInstalled">—</b>',
        `<b id="auraMarketStatInstalled">${installed}</b>`
      )
      .replace(
        '<b id="auraMarketStatEnabled">—</b>',
        `<b id="auraMarketStatEnabled">${enabled}</b>`
      );
  };
  fillStats(
    MOCK_PLUGINS.length,
    MOCK_PLUGINS.filter((item) => item.enabled === true).length
  );

  if (mode === "market") {
    // 切换到插件市场 tab: 挪 active 类 + 注入市场卡片 (三种安装状态)
    page = page
      .replace(
        'class="nav-link active"\n            id="aura-market-installed-tab"',
        'class="nav-link"\n            id="aura-market-installed-tab"'
      )
      .replace(
        'class="tab-pane fade show active"\n          id="aura-market-installed-pane"',
        'class="tab-pane fade"\n          id="aura-market-installed-pane"'
      )
      .replace(
        'class="tab-pane fade"\n          id="aura-market-market-pane"',
        'class="tab-pane fade show active"\n          id="aura-market-market-pane"'
      );
    const MARKET_ITEMS = [
      {
        id: "com.splayer.nowplaying",
        name: "Now Playing 推送",
        version: "1.0.1",
        author: "SPlayer",
        description: "把正在收听的音乐推送到 Discord / Webhook, 支持自定义消息模板。",
        type: "main",
        homepage: "https://github.com/blingbling-bow/HugoAura-Enhanced",
        installState: "available",
      },
      {
        id: "com.aura.test.main",
        name: "Aura 测试插件 (主进程)",
        version: "1.1.0",
        author: "HugoAura",
        description: "验证主进程插件运行时: 配置 / 存储 / 事件总线 / 心跳 / 卸载清理。",
        type: "main",
        homepage: "",
        installState: "upgradable",
        installedVersion: "1.0.0",
      },
      {
        id: "com.aura.test.ui",
        name: "Aura 测试插件 (界面)",
        version: "1.0.0",
        author: "HugoAura",
        description: "验证渲染层插件运行时: 注入页面加载徽章 + IPC 调用测试。",
        type: "ui",
        homepage: "",
        installState: "installed",
        installedVersion: "1.0.0",
      },
    ];
    page = page.replace(
      '<div class="aura-market-cards" id="auraMarketMarketCards"></div>',
      `<div class="aura-market-cards" id="auraMarketMarketCards">${MARKET_ITEMS.map(
        (entry) => market.marketCardHtml(entry)
      ).join("")}</div>`
    );
    page = page.replace(
      '<div\n            class="aura-market-empty"\n            id="auraMarketMarketStatus"\n            style="display: none"\n          >',
      '<div class="aura-market-empty" id="auraMarketMarketStatus" style="display: none">'
    );
  } else if (mode === "empty") {
    // 已安装 tab 空状态: 不注入卡片, 只把空状态块显示出来
    page = page.replace(
      '<div\n            class="aura-market-empty"\n            id="auraMarketEmpty"\n            style="display: none"\n          >',
      '<div\n            class="aura-market-empty"\n            id="auraMarketEmpty"\n          >'
    );
  } else {
    // 已安装 tab: 注入卡片数据
    page = page.replace(
      '<div\n            class="aura-market-cards"\n            id="auraMarketCards"\n          ></div>',
      `<div class="aura-market-cards" id="auraMarketCards">${market.cardsHtml(
        MOCK_PLUGINS
      )}</div>`
    );
    page = page.replace(
      '<div\n            class="aura-market-empty"\n            id="auraMarketEmpty"\n            style="display: none"\n          >',
      '<div class="aura-market-empty" id="auraMarketEmpty" style="display: none">'
    );
  }

  let modal = "";
  if (mode === "url-modal") modal = market.urlModalHtml();
  if (mode === "confirm-modal")
    modal = market.confirmModalHtml(DEMO_MANIFEST);
  if (mode === "remove-modal")
    modal = market.removeModalHtml(MOCK_PLUGINS[0]);
  if (mode === "details-modal") modal = market.detailsModalHtml(MOCK_PLUGINS[0]);
  if (mode === "config-modal")
    modal = market.configModalHtml(MOCK_PLUGINS[0], MOCK_PLUGINS[0].configUI, MOCK_SETTINGS);

  const css = cssFiles
    .map(
      (f) =>
        `<style>\n/* ${f} */\n${fs.readFileSync(path.join(root, f), "utf8")}\n</style>`
    )
    .join("\n");

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>插件市场预览 ${width}x${height} (${mode})</title>
${css}
<style>
  /* 模拟管家窗口: 固定尺寸、不可拉伸 */
  html, body { margin: 0; padding: 0; background: #fff; }
  body {
    width: ${width}px;
    height: ${height}px;
    overflow: hidden;
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  #acs-plugins-root-el { width: 100%; height: 100%; overflow-y: auto; overflow-x: hidden; }
  .aura-market-modal, .aura-market-modal-card { animation: none !important; }
</style>
</head>
<body>
<div
  id="preview-root"
  style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: linear-gradient(180deg, #4a9fe8 0%, #79bdf1 55%, #a8d8f8 100%)"
>
  <div
    id="acs-plugins-root-el"
    style="width: 100%; height: 100%; overflow-y: auto; overflow-x: hidden"
  >${page}</div>
  ${modal}
</div>
</body>
</html>`;

  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(
    outDir,
    `plugins-preview-${width}x${height}${mode === "installed" ? "" : `-${mode}`}.html`
  );
  fs.writeFileSync(outFile, html, "utf8");
  console.log(`已生成: ${outFile}`);
};

main();
