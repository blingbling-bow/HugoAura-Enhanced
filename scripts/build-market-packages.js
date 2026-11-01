// @ts-check

/**
 * 构建市场插件包: 把 src/aura/market/src/<id>/ 打包为
 * src/aura/market/packages/<id>.zip 并输出 sha256 (登记进 plugins.json 用)。
 *
 * 用法: node scripts/build-market-packages.js [pluginId ...]
 *       不带参数 = 构建全部。
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const MARKET_DIR = path.join(__dirname, "..", "src", "aura", "market");
const SRC_DIR = path.join(MARKET_DIR, "src");
const OUT_DIR = path.join(MARKET_DIR, "packages");

/** 与 test/zip.test.js 相同的 zip 构造 (deflate + 中央目录 + EOCD) */
const buildZip = (entries) => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data, "utf8");
    const payload = zlib.deflateRawSync(raw);
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
};

const collectEntries = (dir, prefix = "") => {
  const entries = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.isDirectory()) {
      entries.push(...collectEntries(full, rel));
    } else {
      entries.push({ name: rel, data: fs.readFileSync(full) });
    }
  }
  return entries;
};

const main = () => {
  const wanted = process.argv.slice(2);
  const ids = fs
    .readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((id) => (wanted.length ? wanted.includes(id) : true))
    .sort();

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const id of ids) {
    const entries = collectEntries(path.join(SRC_DIR, id));
    if (!entries.some((e) => e.name === "manifest.json")) {
      console.warn(`跳过 ${id}: 缺少 manifest.json`);
      continue;
    }
    const zip = buildZip(entries);
    const outPath = path.join(OUT_DIR, `${id}.zip`);
    fs.writeFileSync(outPath, zip);
    const sha = require("crypto")
      .createHash("sha256")
      .update(zip)
      .digest("hex");
    console.log(`${id}.zip  (${zip.length} bytes)  sha256: ${sha}`);
  }
  console.log("输出目录:", OUT_DIR);
};

main();
