// @ts-check

/**
 * 特征串定位器 (只读)
 *
 * 用法: node scripts/audit-needle-probe.js [main.js] <needle> [needle...]
 *
 * 回答"这个字面量出现在哪个 webpack 模块里", 用于给真机日志里冒出来的
 * 陌生指令/通道定性 —— 只取模块源码做特征匹配, 不执行任何模块工厂。
 */

const fs = require("fs");

const argv = process.argv.slice(2);
const bundlePath = argv[0] && argv[0].endsWith(".js") ? argv[0] : "app_unpacked/main.js";
const needles = (argv[0] && argv[0].endsWith(".js") ? argv.slice(1) : argv);

const src = fs.readFileSync(bundlePath, "utf8");
const start = src.indexOf("([function");
const end = src.lastIndexOf("])");
const modules = eval(src.slice(start + 1, end + 1));

const contextAt = (s, i, len, radius = 130) =>
  s.slice(Math.max(0, i - radius), i + len + radius).replace(/\s+/g, " ");

for (const needle of needles) {
  console.log("\n" + "=".repeat(76));
  console.log("特征串: " + JSON.stringify(needle));
  let hits = 0;
  for (let id = 0; id < modules.length; id++) {
    const body = String(modules[id]);
    let from = 0;
    let shown = 0;
    while (true) {
      const i = body.indexOf(needle, from);
      if (i < 0) break;
      hits++;
      if (shown < 2) {
        console.log(`  [模块 ${id}] …${contextAt(body, i, needle.length)}…`);
        shown++;
      }
      from = i + needle.length;
    }
  }
  if (hits === 0) console.log("  (无命中)");
}
