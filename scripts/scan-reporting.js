const fs = require("fs");
const path = require("path");

const files = [
  "app_unpacked/public/assistant.js",
  "app_unpacked/public/deviceLink.js",
  "app_unpacked/public/nfcAuthResult.js",
  "app_unpacked/main.js",
];

// 1. 枚举所有 http(s) 端点
const urlRe = /https?:\/\/[a-zA-Z0-9.\-_]+(?:\.com|\.cn|\.net|\.ooo|\.moe|\.site|\.org|\.dpdns\.org|\.top|\.vip)[a-zA-Z0-9.\/\-_]*/g;

// 2. 上报行为特征
const reportKeys = [
  "buryPoint", "buried", "trackEvent", "track(", "sensors", "analytics",
  "telemetry", "reportData", "uploadLog", "logReport", "report(",
  "collectData", "userBehavior", "打点", "埋点", "统计", "monitor",
  "/collect", "/report", "/track", "/log/", "/event", "/behavior",
];

for (const f of files) {
  const s = fs.readFileSync(f, "utf8");
  console.log("\n########", f, "########");
  const urls = new Set();
  let m;
  while ((m = urlRe.exec(s)) !== null) urls.add(m[0]);
  console.log("--- URLs (" + urls.size + ") ---");
  [...urls].sort().forEach((u) => console.log(" ", u));
  console.log("--- 上报特征 ---");
  for (const k of reportKeys) {
    let idx = 0,
      count = 0;
    const first = [];
    while ((idx = s.indexOf(k, idx)) !== -1) {
      count++;
      if (first.length < 2) first.push(idx);
      idx += k.length;
    }
    if (count) console.log("  [" + k + "] x" + count + " @", first.join(","));
  }
}
