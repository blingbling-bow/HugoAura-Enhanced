const fs = require("fs");
const s = fs.readFileSync(process.argv[2] || "app_unpacked/main.js", "utf8");
const start = Number(process.argv[3] || 28897);
const before = Number(process.argv[4] || 1800);
const after = Number(process.argv[5] || 200);
console.log(s.slice(Math.max(0, start - before), start + after).replace(/\n/g, "\\n"));

// shouldRelink 出现的位置
let i = 0;
let n = 0;
while ((i = s.indexOf("shouldRelink", i)) !== -1 && n < 8) {
  console.log("\n=== shouldRelink @" + i + " ===");
  console.log(s.slice(Math.max(0, i - 160), i + 160).replace(/\n/g, "\\n"));
  i += 12;
  n++;
}
