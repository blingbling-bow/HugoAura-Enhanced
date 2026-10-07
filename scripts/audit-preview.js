// @ts-check

/**
 * 审计页离线预览 (只读, 仅用于设计评审)
 *
 * 用法:
 *   node scripts/audit-preview.js [日志路径] [输出目录] [宽] [高]
 *
 * 为什么需要它: 管家窗口固定 880x600 且不可拉伸, 而仓库里没有前端测试框架,
 * 光靠读 CSS 无法判断"到底好不好看、会不会溢出"。本脚本把**真实的**样式表
 * (bootstrap + form.css + preferences.css) 与**真实的**渲染函数
 * (auditPageTemplate / buildStats / statsHtml / rowHtml) 拼成一个静态页面,
 * 再用无头 Chrome 截图, 就能在改代码前先看到结果。
 *
 * 渲染函数直接从源码 require —— 预览与线上页面不会出现两套 HTML。
 */

const fs = require("fs");
const path = require("path");

const ui = require("../src/aura/ui/pages/configSubPages/preferences/settings/auditLog.js");

const root = path.join(__dirname, "..");
const cssFiles = [
  "src/aura/ui/bootstrap/bootstrap.min.css",
  "src/aura/ui/css/form.css",
  "src/aura/ui/pages/configSubPages/preferences/preferences.css",
];

const DEFAULT_LOG = "C:\\Users\\Administrator\\Desktop\\cloudCommandAudit.log";

/** 读真机日志; 读不到就用内置样本, 保证预览永远可生成 */
const loadEntries = (logPath) => {
  try {
    if (logPath && fs.existsSync(logPath)) {
      const entries = fs
        .readFileSync(logPath, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      if (entries.length > 0) {
        console.log(`样本: 真机日志 ${logPath} (${entries.length} 条)`);
        return entries;
      }
    }
  } catch (err) {
    console.error("读取日志失败, 改用内置样本:", err.message);
  }
  console.log("样本: 内置");
  return [
    {
      ts: new Date().toISOString(),
      source: "wss://127.0.0.1/forward/SeewoHugoHttp/SeewoHugoService",
      channel: "hugoServiceWebsocket",
      channelId: 399,
      url: "/serviceUpgrade/status",
      key: "/serviceUpgrade/status",
      data: { latestVersion: "", localVersion: "1.6.7.4010", status: 0 },
      action: "blocked",
      blocked: true,
      durationMs: 0.14,
      _logType: "cloud",
    },
    {
      ts: new Date(Date.now() - 4000).toISOString(),
      source: "wss://127.0.0.1:51270/forward/SeewoHugoHttp/SeewoWindowBlock",
      channel: "ADBlockWebSocket",
      channelId: 397,
      url: "/record",
      key: "/record",
      data: { blockList: [], suspiciousList: [{ displayName: "LingYun_Class_Widgets" }] },
      action: "logged",
      durationMs: 0.09,
      _logType: "cloud",
    },
    {
      ts: new Date(Date.now() - 9000).toISOString(),
      source: "wss://127.0.0.1/SeewoProxy",
      channel: "proxyWebsocketHost",
      channelId: 390,
      url: null,
      messageType: 1211,
      key: "messageType:1211",
      data: { operationLogId: "1332203055344435200", screenLockStatus: 0 },
      action: "blocked",
      blocked: true,
      durationMs: 0.11,
      _logType: "cloud",
    },
    {
      ts: new Date(Date.now() - 15000).toISOString(),
      source: "wss://127.0.0.1/forward/SeewoHugoHttp/SeewoHugoService",
      channel: "hugoServiceWebsocket",
      channelId: 399,
      url: null,
      messageType: 1004,
      key: "messageType:1004",
      data: { vaildType: 0 },
      action: "logged",
      durationMs: 0.07,
      _logType: "cloud",
    },
    {
      ts: new Date(Date.now() - 21000).toISOString(),
      channel: "screenPeek",
      source: "screenCapture.exe",
      action: "peek_start",
      blocked: false,
      durationMs: 0.06,
      _logType: "peek",
    },
    {
      ts: new Date(Date.now() - 30000).toISOString(),
      source: "screenLockController",
      channel: "screenLockController",
      action: "unlock",
      method: "remote",
      actionOperator: 1,
      operationLogId: "1332203055344435200",
      hadLock: false,
      durationMs: 0.05,
      _logType: "unlock",
    },
    {
      ts: new Date(Date.now() - 45000).toISOString(),
      source: "127.0.0.1:8899",
      channel: "SeewoProxyHTTP",
      url: "/forward/SeewoHugoHttp/api/v1/device/id",
      key: "/forward/SeewoHugoHttp/api/v1/device/id",
      method: "GET",
      httpStatus: 200,
      data: { code: "000000", data: { deviceId: "1202005298766430208" } },
      action: "logged",
      durationMs: 142.35,
      _logType: "http",
    },
    {
      ts: new Date(Date.now() - 60000).toISOString(),
      source: "wss://127.0.0.1/forward/SeewoHugoHttp/SeewoHugoLightAudio",
      channel: "audioWebsocket",
      channelId: 407,
      url: "/lightAudio/device",
      key: "/lightAudio/device",
      data: null,
      action: "logged",
      durationMs: 0.04,
      _logType: "cloud",
    },
  ];
};

const main = () => {
  const logPath = process.argv[2] || DEFAULT_LOG;
  const outDir = process.argv[3] || path.join(root, "Artifacts", "preview");
  const width = Number(process.argv[4] || 864);
  const height = Number(process.argv[5] || 580);

  const entries = loadEntries(logPath);
  // 与线上一致: 旧记录的 URL 形态通道名先归一化
  for (const e of entries) e.channel = ui.shortChannelOf(e.channel);
  entries.sort((a, b) => (new Date(b.ts).getTime() || 0) - (new Date(a.ts).getTime() || 0));

  const shown = entries.slice(0, 60);
  // 行 key 与线上同一规则
  const rows = shown
    .map((e, i) => ui.rowHtml(e, `preview|${i}`))
    .join("");

  // 第 6 个参数传 "modal" 时, 额外渲染一份"弹窗打开"的状态, 便于截图评审
  const modal =
    entries[1] && process.argv[6] === "modal" ? ui.detailModalHtml(entries[1]) : "";

  const channels = Array.from(
    new Set(entries.map((e) => e.channel || e._logType).filter(Boolean))
  ).sort();

  const page = ui
    .auditPageTemplate()
    .replace(
      '<select id="auditChannelFilter" class="aura-audit-select" title="按通道筛选">\n            <option value="all">全部通道</option>\n          </select>',
      `<select id="auditChannelFilter" class="aura-audit-select" title="按通道筛选">
            <option value="all">全部通道</option>
            ${channels
              .map((c) => `<option value="${c}">${c}</option>`)
              .join("")}
          </select>`
    )
    .replace(
      '<section id="auditStatsContainer" class="aura-audit-stats"></section>',
      `<section id="auditStatsContainer" class="aura-audit-stats">${ui.statsHtml(
        ui.buildStats(entries, entries)
      )}</section>`
    )
    .replace(
      '<tbody id="auditTableBody"></tbody>',
      `<tbody id="auditTableBody">${rows || ui.emptyStateHtml()}</tbody>`
    )
    .replace(
      '<span id="auditCountHint" class="aura-audit-count">共 0 条</span>',
      `<span id="auditCountHint" class="aura-audit-count">共 ${entries.length} 条</span>`
    );

  const css = cssFiles
    .map((f) => `<style>\n/* ${f} */\n${fs.readFileSync(path.join(root, f), "utf8")}\n</style>`)
    .join("\n");

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>审计页预览 ${width}x${height}${modal ? " (弹窗打开)" : ""}</title>
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
  #audit-subpage { width: 100%; height: 100%; overflow-y: auto; overflow-x: hidden; }
  /* 静态截图: 关掉入场动画, 否则会截到半透明中间态 */
  .aura-audit-modal, .aura-audit-modal-card { animation: none !important; }
</style>
</head>
<body>
<div
  id="preview-root"
  style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: linear-gradient(180deg, #4a9fe8 0%, #79bdf1 55%, #a8d8f8 100%)"
>
  <div
    id="audit-subpage"
    style="width: 100%; height: 100%; overflow-y: auto; overflow-x: hidden"
  >${page}</div>
  ${modal}
</div>
</body>
</html>`;

  fs.mkdirSync(outDir, { recursive: true });
  const suffix = process.argv[6] === "modal" ? "-modal" : "";
  const outFile = path.join(
    outDir,
    `audit-preview-${width}x${height}${suffix}.html`
  );
  fs.writeFileSync(outFile, html, "utf8");
  console.log(`已生成: ${outFile}`);
};

main();
