const fs = require("fs");
const s = fs.readFileSync(process.argv[2] || "app_unpacked/main.js", "utf8");

const show = (p, rad, max) => {
  let i = 0;
  let n = 0;
  while ((i = s.indexOf(p, i)) !== -1 && n < (max || 5)) {
    console.log("=== " + p + " @" + i + " ===");
    console.log(s.slice(Math.max(0, i - rad), i + rad).replace(/\n/g, "\\n"));
    i += p.length;
    n++;
  }
};

show("listen(", 200, 3);
show('on("request"', 120, 3);
show("on('request'", 120, 3);
show("createServer", 60, 5);

const api = [];
let i = 0;
while ((i = s.indexOf("/api/", i)) !== -1) {
  api.push(s.slice(i, i + 70));
  i += 5;
}
console.log("--- /api/ occurrences: " + api.length);
console.log([...new Set(api)].slice(0, 30).join("\n"));
