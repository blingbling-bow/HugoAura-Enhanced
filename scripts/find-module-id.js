// 按 webpack 数组式打包切分 main.js, 定位模块 ID
const fs = require("fs");
const s = fs.readFileSync("app_unpacked/main.js", "utf8");

// 模块边界: 模块间以 },function(e,t[,n]){ 或 },(function... 分隔
// 保守起见, 只按 "},function(e,t" 和文件开头 "function(e,t" 切分
const parts = [];
let depth = 0; // 无法完美解析, 改用正则统计所有模块起点

// 用启发式: 找所有 "},function(e,t" / "},function(e,t,n" / "},function(e){"
const re = /\}\s*,\s*function\s*\(\s*e\s*,\s*t\s*(?:,\s*n\s*)?\)\s*\{/g;
const starts = [0]; // 第一个模块从 0 开始 (module.exports= 在前面)
let m;
while ((m = re.exec(s)) !== null) starts.push(m.index + m[0].length);

// 找包含目标特征的模块
function findModuleId(marker) {
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : s.length;
    const body = s.slice(starts[i], end);
    if (body.includes(marker)) return { id: i, start: starts[i], end };
  }
  return null;
}

for (const marker of ["GET_COUNTDOWN_MES", "./countdown.js"]) {
  const r = findModuleId(marker);
  if (r) {
    console.log("marker:", marker, "-> module id:", r.id, "@", r.start);
    console.log(s.slice(r.start, r.start + 400).replace(/\n/g, "\\n"));
    console.log("");
  } else {
    console.log("marker:", marker, "-> not found");
  }
}

// 验证: 模块 193 应为 countdown 窗口创建模块
console.log("验证模块 193:", s.slice(starts[193], starts[193] + 200).replace(/\n/g, "\\n"));
