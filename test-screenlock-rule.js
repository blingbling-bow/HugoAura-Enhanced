const fs = require("fs");
const ruleFn = require("./src/aura/jsRewrite/network/appearance/customScreenLockBg.js").ruleFn;

const originalPath = "C:\\Users\\Administrator\\AppData\\Local\\Temp\\hugoaura-asar-extract\\public\\screenLock.js";
const original = fs.readFileSync(originalPath, "utf8");

console.log("===== Original segment (should find both anchors) =====");
const beginAnchor = "t.handleListenScreenLockSource=function(e){var n=";
const endAnchor = ";Object(S.a)(n,function(e){var n=P(e||{})";
const beginIdx = original.indexOf(beginAnchor);
const endIdx = original.indexOf(endAnchor, beginIdx);
console.log("beginIdx:", beginIdx, "(expected ~9686)");
console.log("endIdx:", endIdx, "(expected ~9812)");
if (beginIdx !== -1 && endIdx !== -1) {
  console.log("Original expr:", original.slice(beginIdx + beginAnchor.length, endIdx));
}

console.log("\n===== Run ruleFn with enabled=true, backgroundPath=C:\\test.png =====");
const result = ruleFn(original, { enabled: true, backgroundPath: "C:\\test.png" });

const newBeginIdx = result.indexOf(beginAnchor);
const newEndIdx = result.indexOf(endAnchor, newBeginIdx);
const injected = result.slice(newBeginIdx + beginAnchor.length, newEndIdx);
console.log("Injected expr length:", injected.length);
console.log("Injected expr (first 400 chars):\n", injected.slice(0, 400));

console.log("\n===== Syntax check (should not throw) =====");
try {
  new Function("e", "S", "P", "window", "return " + injected);
  console.log("✓ Syntax valid");
} catch (err) {
  console.error("✗ Syntax error:", err.message);
  process.exit(1);
}

console.log("\n===== File size delta =====");
console.log("Original:", original.length, "bytes");
console.log("Result:", result.length, "bytes");
console.log("Delta:", result.length - original.length);
