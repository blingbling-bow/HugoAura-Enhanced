const fs = require("fs");
const path = require("path");
const baseDir = process.cwd();
const targetPath = path.resolve(baseDir, process.argv[2] || "app_unpacked/main.js");
if (targetPath !== baseDir && !targetPath.startsWith(baseDir + path.sep)) {
  throw new Error("Refusing to read path outside of working directory: " + targetPath);
}
const s = fs.readFileSync(targetPath, "utf8");
const rad = Number(process.argv[3] || 220);

const show = (p, max) => {
  let i = 0;
  let n = 0;
  console.log("\n########## " + p + " ##########");
  while ((i = s.indexOf(p, i)) !== -1 && n < (max || 6)) {
    console.log("--- @" + i + " ---");
    console.log(s.slice(Math.max(0, i - rad), i + rad).replace(/\n/g, "\\n"));
    i += p.length;
    n++;
  }
  console.log("hits shown:", n);
};

show("resizable", 8);
show("assistant\":{", 4);
