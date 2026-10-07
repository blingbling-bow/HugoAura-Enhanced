const fs = require("fs");
const s = fs.readFileSync(process.argv[2] || "app_unpacked/main.js", "utf8");
const rad = Number(process.argv[3] || 260);
const max = Number(process.argv[4] || 40);

let i = 0;
let n = 0;
while ((i = s.indexOf("SeewoProxyHTTP", i)) !== -1 && n < max) {
  console.log("=== @" + i + " ===");
  console.log(s.slice(Math.max(0, i - rad), i + rad).replace(/\n/g, "\\n"));
  console.log("");
  i += 14;
  n++;
}
console.log("total shown:", n);
