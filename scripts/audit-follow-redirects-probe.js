const fs = require("fs");
const src = fs.readFileSync(process.argv[2] || "app_unpacked/main.js", "utf8");
const start = src.indexOf("([function");
const end = src.lastIndexOf("])");
const arr = eval(src.slice(start + 1, end + 1));

const id = Number(process.argv[3] || 281);
const needle = process.argv[4] || "_performRequest";
const rad = Number(process.argv[5] || 700);

const body = String(arr[id]);
const i = body.indexOf(needle);
console.log("module " + id + " len=" + body.length + " needle@" + i);
if (i >= 0) {
  console.log(body.slice(Math.max(0, i - rad), i + rad).replace(/\n/g, "\\n"));
}
console.log("\n--- exports tail ---");
console.log(body.slice(-600).replace(/\n/g, "\\n"));
