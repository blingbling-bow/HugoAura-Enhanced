const fs = require("fs");

function ctx(file, word, before = 300, after = 350, max = 4) {
  const s = fs.readFileSync(file, "utf8");
  let idx = 0,
    count = 0;
  while ((idx = s.indexOf(word, idx)) !== -1 && count < max) {
    console.log("=== " + file + " [" + word + "] @" + idx + " ===");
    console.log(s.slice(Math.max(0, idx - before), idx + after).replace(/\n/g, "\\n"));
    console.log("");
    idx += word.length;
    count++;
  }
}

ctx("app_unpacked/main.js", "/friday/agent/api/app/v2/report", 400, 400, 2);
ctx("app_unpacked/main.js", "bugly/api/v1/electron", 400, 500, 2);
ctx("app_unpacked/main.js", "/report", 300, 400, 3);
ctx("app_unpacked/public/assistant.js", "统计", 300, 350, 2);
ctx("app_unpacked/public/assistant.js", "monitor", 250, 300, 3);
