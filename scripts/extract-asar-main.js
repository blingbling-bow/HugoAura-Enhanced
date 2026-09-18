const fs = require("fs");

// 简易解析 asar 头, 提取 main.js (只读, 不执行)
function extractMain(asarPath, outPath) {
  const fd = fs.openSync(asarPath, "r");
  const sizeBuf = Buffer.alloc(16);
  fs.readSync(fd, sizeBuf, 0, 16, 0);
  const headerSize = sizeBuf.readUInt32LE(4) - 8;
  const headerBuf = Buffer.alloc(headerSize);
  fs.readSync(fd, headerBuf, 0, headerSize, 16);
  const headerStr = headerBuf.toString("utf8");
  const m = headerStr.match(/"main\.js":\{[^}]*?"size":(\d+)[^}]*?"offset":"(\d+)"/);
  if (!m) {
    console.log("main.js not found in", asarPath);
    return false;
  }
  const baseOffset = 8 + sizeBuf.readUInt32LE(4) + 4;
  const buf = Buffer.alloc(+m[1]);
  fs.readSync(fd, buf, 0, buf.length, baseOffset + +m[2]);
  fs.writeFileSync(outPath, buf);
  console.log(asarPath, "-> main.js", buf.length, "bytes");
  return true;
}

const ok = extractMain("app.asar.bak", "main_4008.js");
if (ok) {
  const s = fs.readFileSync("main_4008.js", "utf8");
  let idx = 0;
  let found = 0;
  while ((idx = s.indexOf("openDevTools", idx)) !== -1 && found < 5) {
    console.log("=== @", idx, "===");
    console.log(s.slice(Math.max(0, idx - 450), idx + 200).replace(/\n/g, "\\n"));
    console.log("");
    idx += 10;
    found++;
  }
  // 也找 canOpenDevTool 的解构用法
  let i2 = 0;
  while ((i2 = s.indexOf("canOpenDevTool:", i2)) !== -1) {
    console.log("=== canOpenDevTool destructure @", i2, "===");
    console.log(s.slice(Math.max(0, i2 - 200), i2 + 300).replace(/\n/g, "\\n"));
    console.log("");
    i2 += 10;
  }
}
