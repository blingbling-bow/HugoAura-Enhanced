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
  console.log("");
};

show("setHost(", 500, 2);
show("sendMessage(", 300, 2);

// 找出所有 "JSON.parse" 附近含 onMessage 的位置
let i = 0;
let n = 0;
while ((i = s.indexOf("onMessage", i)) !== -1 && n < 12) {
  const seg = s.slice(i, i + 220);
  if (seg.includes("JSON.parse")) {
    console.log("=== onMessage+JSON.parse @" + i + " ===");
    console.log(s.slice(Math.max(0, i - 320), i + 320).replace(/\n/g, "\\n"));
    console.log("");
    n++;
  }
  i += 9;
}
console.log("onMessage+JSON.parse hits: " + n);
