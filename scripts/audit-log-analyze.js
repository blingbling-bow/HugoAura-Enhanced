// @ts-check

/**
 * 审计日志分析器 (只读)
 *
 * 用法: node scripts/audit-log-analyze.js <cloudCommandAudit.log>
 *
 * 目的: 把真机日志里的指令按键聚合出来, 并标出**指令表 (KNOWN_COMMANDS) 尚未
 * 收录**的键 —— 这些就是审计页上显示「未识别」的指令。据此补表。
 *
 * 只读文件, 不修改任何内容; 样本字段截断输出, 便于快速判读。
 */

const fs = require("fs");

const SAMPLE_LIMIT = 110;

const truncate = (v, n = SAMPLE_LIMIT) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
};

const loadKnownCommands = () => {
  try {
    // 复用审计页里的指令表, 保证"未收录"判定与界面完全一致
    const ui = require("../src/aura/ui/pages/configSubPages/preferences/settings/auditLog.js");
    return {
      table: ui.KNOWN_COMMANDS || {},
      normalize: ui.normalizeHttpPath || ((p) => p),
    };
  } catch (err) {
    console.error("(无法加载指令表, 将全部视为未收录):", err.message);
    return { table: {}, normalize: (p) => p };
  }
};

const main = () => {
  const file = process.argv[2];
  if (!file) {
    console.error("用法: node scripts/audit-log-analyze.js <cloudCommandAudit.log>");
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.error("文件不存在: " + file);
    process.exit(2);
  }

  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());

  const byLogType = new Map();
  /** @type {Map<string, { count: number, channel: string, sample: any }>} */
  const byKey = new Map();
  let broken = 0;

  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      broken++;
      continue;
    }
    const logType = rec._logType || "(none)";
    byLogType.set(logType, (byLogType.get(logType) || 0) + 1);

    const key = rec.key || rec.url || "(无 key)";
    const slot = byKey.get(key) || { count: 0, channel: rec.channel || "-", sample: rec };
    slot.count++;
    byKey.set(key, slot);
  }

  const { table, normalize } = loadKnownCommands();
  // 与审计页 isUnknownCommand 完全一致的判定:
  //   只有"云端指令"(_logType 为 cloud 或缺失) 才谈得上未识别;
  //   窥屏/锁屏/关机/解锁/出站 HTTP 记录各有自己的语义, 不计入。
  const isCloud = (rec) => !rec._logType || rec._logType === "cloud";
  const isKnown = (rec) => {
    if (!isCloud(rec)) return true; // 非云端指令不参与"未收录"统计
    const key = rec.key;
    if (!key) return true;
    if (key === "(unidentified)") return false;
    if (Object.prototype.hasOwnProperty.call(table, key)) return true;
    return Object.prototype.hasOwnProperty.call(table, normalize(key));
  };

  console.log("=".repeat(78));
  console.log("文件      : " + file);
  console.log("总记录    : " + lines.length + " (损坏行 " + broken + ")");
  console.log(
    "按类型    : " +
      [...byLogType.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join("  ")
  );

  const unknown = [];
  const rows = [...byKey.entries()].sort((a, b) => b[1].count - a[1].count);

  console.log("\n--- 全部指令键 (按出现次数) ---");
  for (const [key, info] of rows) {
    const known = isKnown(info.sample);
    if (!known) unknown.push([key, info]);
    console.log(
      [
        String(info.count).padStart(5),
        known ? " 已知 " : "★未收录",
        String(info.sample._logType || "cloud").padEnd(11),
        key.padEnd(42).slice(0, 42),
        String(info.channel).padEnd(20).slice(0, 20),
        truncate(info.sample.data !== undefined ? info.sample.data : info.sample, 60),
      ].join(" ")
    );
  }

  console.log("\n--- 未收录 (" + unknown.length + " 种) ---");
  if (unknown.length === 0) {
    console.log("  无 —— 指令表已覆盖日志中的全部指令");
  }
  for (const [key, info] of unknown) {
    console.log(`  ${key}   ×${info.count}`);
    console.log(`      样本: ${truncate(info.sample, 200)}`);
  }
};

main();
