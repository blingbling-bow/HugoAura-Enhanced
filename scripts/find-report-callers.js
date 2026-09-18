const fs = require("fs");
const s = fs.readFileSync("app_unpacked/main.js", "utf8");

// webpack 数组式打包: 统计 "function(e,t,n){" 模块起点, 确定埋点模块 ID
const modStarts = [];
let idx = 0;
const re = /\}\s*,\s*function\s*\(\s*e\s*,\s*t\s*,\s*n\s*\)\s*\{/g;
// 从第一个模块开始粗略扫描: 直接找所有 "function(e,t,n){" 且前面是 "},{" 或文件头
const cand = [];
const re2 = /function\s*\(\s*e\s*,\s*t\s*,\s*n\s*\)\s*\{/g;
let m;
while ((m = re2.exec(s)) !== null) cand.push(m.index);

// 埋点模块定义在 @136288-136682 之间
const reportModIdx = cand.filter((i) => i < 136300).length - 1;
console.log("report 模块可能是第", reportModIdx, "号模块 (函数出现次序)");

// 搜索对该模块的引用: n(ID) 形式
const refRe = new RegExp("n\\((" + reportModIdx + ")\\)", "g");
let refIdx = 0,
  refs = [];
while ((refIdx = s.indexOf("n(" + reportModIdx + ")", refIdx)) !== -1) {
  refs.push(refIdx);
  refIdx += 1;
}
console.log("引用位置:", refs.length);
for (const r of refs.slice(0, 5)) {
  console.log("=== @" + r + " ===");
  console.log(s.slice(Math.max(0, r - 300), r + 300).replace(/\n/g, "\\n"));
  console.log("");
}
