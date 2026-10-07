// @ts-check

/**
 * 提取管家 bundle 里所有"路径型"字符串字面量 (只读)
 *
 * 用法: node scripts/audit-path-literals.js [main.js]
 *
 * 目的: 一次性找出所有 WS 下行指令的 url 字面量 (如 "/tipConfirm"),
 * 供指令表 (KNOWN_COMMANDS) 补全, 避免真机上一条条撞见。
 */

const fs = require("fs");

const bundlePath = process.argv[2] || "app_unpacked/main.js";
const src = fs.readFileSync(bundlePath, "utf8");

// 形如 "/xxx/yyy" 的路径字面量: 以 / 开头、由字母数字_/组成、至少两段
const RE = /"\/(?!\/)(?!api\/|forward\/)[A-Za-z][A-Za-z0-9_]*(?:\/[A-Za-z][A-Za-z0-9_]*)+"/g;

let m;
const found = new Map(); // literal -> Set(模块号)
while ((m = RE.exec(src)) !== null) {
  const literal = m[1] ? "/" + m[1] : m[0];
  const moduleId = src.slice(0, m.index).split("function(e,t,n)").length - 1;
  if (!found.has(literal)) found.set(literal, new Set());
  found.get(literal).add(moduleId);
}

const rows = [...found.entries()].sort((a, b) => a[0].localeCompare(b[0]));
console.log("路径型字面量共 " + rows.length + " 个:\n");
for (const [literal, ids] of rows) {
  console.log(`  ${literal.padEnd(52)} [模块 ${[...ids].join(",")}]`);
}
