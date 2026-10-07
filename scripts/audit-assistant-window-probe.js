const fs = require("fs");
const src = fs.readFileSync(process.argv[2] || "app_unpacked/main.js", "utf8");
const needle = process.argv[3] || "zoomFactor:1},beforeCreate";
const maxLen = Number(process.argv[4] || 4000);

const start = src.indexOf("([function");
const end = src.lastIndexOf("])");
const arr = eval(src.slice(start + 1, end + 1));

for (let i = 0; i < arr.length; i++) {
  const body = String(arr[i]);
  if (!body.includes(needle)) continue;
  console.log("===== module " + i + " (len=" + body.length + ") =====");
  console.log(body.slice(0, maxLen).replace(/\n/g, "\\n"));
  break;
}
