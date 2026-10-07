// @ts-check

/**
 * 提取管家 WS 通道表 (只读)
 *
 * 用法: node scripts/audit-ws-channel-map.js [main.js]
 *
 * 背景: 真机审计日志里「通道」列显示成
 *   wss://127.0.0.1:51270/forward/SeewoHugoHttp/SeewoWindowBlock
 * 这样的长 URL —— 因为 WS 客户端实例上没有 label/name 字段, 探针只能退化到 host。
 * 但管家自己的配置表里就有「通道名 -> {ip,url}」的映射 (模块 0/174),
 * 据此可以把 URL 还原成通道名 (如 ADBlockWebSocket)。
 *
 * 只读: 只取模块源码做正则提取, 不执行任何模块工厂。
 */

const fs = require("fs");

const bundlePath = process.argv[2] || "app_unpacked/main.js";
const src = fs.readFileSync(bundlePath, "utf8");
const start = src.indexOf("([function");
const end = src.lastIndexOf("])");
const modules = eval(src.slice(start + 1, end + 1));

// 形如: ChannelName:{ip:"wss://...",url:"/forward/..."}
const PAIR_RE = /([A-Za-z_$][\w$]*)\s*:\s*\{\s*ip\s*:\s*"([^"]*)"\s*,\s*url\s*:\s*"([^"]*)"/g;

const seen = new Map();

for (let id = 0; id < modules.length; id++) {
  const body = String(modules[id]);
  if (!body.includes("proxyHttp") && !body.includes("Websocket") && !body.includes("WebSocket")) {
    continue;
  }
  PAIR_RE.lastIndex = 0;
  let m;
  let found = 0;
  while ((m = PAIR_RE.exec(body)) !== null) {
    const [, name, ip, url] = m;
    const key = `${name}|${ip}|${url}`;
    if (!seen.has(key)) {
      seen.set(key, { moduleId: id, name, ip, url });
      found++;
    }
  }
  if (found > 0) {
    console.log(`模块 ${id}: 提取到 ${found} 条通道配置`);
  }
}

console.log("\n--- 通道名 -> URL ---");
const rows = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
for (const r of rows) {
  console.log(
    `  ${r.name.padEnd(30)} ${(r.ip + r.url).padEnd(60)} (模块 ${r.moduleId})`
  );
}
console.log("\n共 " + rows.length + " 条");
