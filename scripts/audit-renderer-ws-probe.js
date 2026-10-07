const fs = require("fs");
const path = require("path");

const root = process.argv[2] || "app_unpacked";
const skipDirs = new Set(["node_modules", ".git"]);
const exts = new Set([".js", ".mjs", ".cjs", ".html", ".json"]);
const pats = ["new WebSocket", "new window.WebSocket", "WebSocket("];

let files = 0;
const hits = [];

const walk = (dir) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (skipDirs.has(e.name)) continue;
      walk(full);
      continue;
    }
    if (!exts.has(path.extname(e.name))) continue;
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (st.size > 30 * 1024 * 1024) continue;
    files++;
    let s;
    try {
      s = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    for (const p of pats) {
      let i = 0;
      while ((i = s.indexOf(p, i)) !== -1) {
        hits.push({ file: full, pat: p, ctx: s.slice(Math.max(0, i - 60), i + 80) });
        i += p.length;
      }
    }
  }
};

walk(root);
console.log("scanned files:", files);
console.log("hits:", hits.length);
for (const h of hits.slice(0, 20)) {
  console.log("--- " + h.file + " [" + h.pat + "]");
  console.log("    " + h.ctx.replace(/\n/g, "\\n"));
}
