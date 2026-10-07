const fs = require("fs");
const s = fs.readFileSync(process.argv[2] || "app_unpacked/main.js", "utf8");

const count = (p) => {
  let c = 0;
  let i = 0;
  while ((i = s.indexOf(p, i)) !== -1) {
    c++;
    i += p.length;
  }
  return c;
};

const report = [
  ['register(["SeewoProxyHTTP"]', count('register(["SeewoProxyHTTP"]')],
  ['class extends s', count("class extends s")],
  ["createConnect", count("createConnect")],
  ["shouldRelink", count("shouldRelink")],
];

// 每个 onMessage(e){ ... } 是否含 JSON.parse (粗略: 到下一个 "}" 为止)
const re = /onMessage\(e\)\{([^}]*)/g;
let m;
let withParse = 0;
let withoutParse = 0;
const withoutSamples = [];
while ((m = re.exec(s)) !== null) {
  if (m[1].includes("JSON.parse")) withParse++;
  else {
    withoutParse++;
    if (withoutSamples.length < 6) withoutSamples.push(m[1].slice(0, 80));
  }
}
report.push(["onMessage 含 JSON.parse", withParse]);
report.push(["onMessage 不含 JSON.parse", withoutParse]);

for (const [k, v] of report) console.log(String(k).padEnd(30), v);
console.log("\n--- 不含 JSON.parse 的 onMessage 样本 ---");
for (const x of withoutSamples) console.log("  " + x);
