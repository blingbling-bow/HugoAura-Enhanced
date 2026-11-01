// @ts-check

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const zip = require("../src/aura/utils/zip.js");

/** DOS 时间戳占位 (解压器不读时间, 填 0 即可) */
const DOS_TIME = 0;
const DOS_DATE = 0;

/**
 * 手工构造一个 ZIP (本测试同时验证构造器与解析器互为镜像)。
 * @param {{name: string, data: Buffer | string, method?: 0 | 8}[]} entries
 * @returns {Buffer}
 */
const makeZip = (entries) => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const method = entry.method === 8 ? 8 : 0;
    const payload = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0; // 解压器不校验 crc, 占位即可

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len

    localParts.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }

  const cdStart = offset;
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
};

/** 建临时目录 */
const makeTmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "aura-zip-test-"));

test("unzipToDir: 存储与 deflate 条目、多级目录、中文文件名", () => {
  const tmp = makeTmpDir();
  try {
    const zipPath = path.join(tmp, "plugin.zip");
    const dest = path.join(tmp, "out");
    fs.writeFileSync(
      zipPath,
      makeZip([
        { name: "manifest.json", data: '{"id":"demo"}' },
        { name: "main.js", data: 'module.exports = { onLoad() {} };', method: 8 },
        { name: "assets/子目录/说明.txt", data: "你好, HugoAura", method: 8 },
      ])
    );

    const res = zip.unzipToDir(zipPath, dest);
    assert.strictEqual(res.files.length, 3);
    assert.strictEqual(
      fs.readFileSync(path.join(dest, "manifest.json"), "utf8"),
      '{"id":"demo"}'
    );
    assert.strictEqual(
      fs.readFileSync(path.join(dest, "main.js"), "utf8"),
      "module.exports = { onLoad() {} };"
    );
    assert.strictEqual(
      fs.readFileSync(path.join(dest, "assets", "子目录", "说明.txt"), "utf8"),
      "你好, HugoAura"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("unzipToDir: 兼容带单层顶层文件夹的插件包 (Telegram 式 zip)", () => {
  const tmp = makeTmpDir();
  try {
    const zipPath = path.join(tmp, "plugin.zip");
    const dest = path.join(tmp, "out");
    fs.writeFileSync(
      zipPath,
      makeZip([
        { name: "com.demo.plugin/", data: Buffer.alloc(0) },
        { name: "com.demo.plugin/manifest.json", data: '{"id":"com.demo.plugin"}' },
        { name: "com.demo.plugin/main.js", data: "exported", method: 8 },
      ])
    );

    const res = zip.unzipToDir(zipPath, dest);
    assert.deepStrictEqual(res.files.map((f) => f.name), [
      "com.demo.plugin/manifest.json",
      "com.demo.plugin/main.js",
    ]);
    assert.strictEqual(
      fs.readFileSync(path.join(dest, "com.demo.plugin", "main.js"), "utf8"),
      "exported"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("unzipToDir: 拒绝路径穿越条目", () => {
  const tmp = makeTmpDir();
  try {
    const zipPath = path.join(tmp, "evil.zip");
    const dest = path.join(tmp, "out");
    fs.writeFileSync(
      zipPath,
      makeZip([
        { name: "manifest.json", data: "{}" },
        { name: "../evil.txt", data: "pwned" },
      ])
    );

    assert.throws(() => zip.unzipToDir(zipPath, dest), /ZIP_UNSAFE_ENTRY_NAME/);
    assert.strictEqual(fs.existsSync(path.join(tmp, "evil.txt")), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("unzipToDir: 拒绝绝对路径与盘符条目", () => {
  const tmp = makeTmpDir();
  try {
    const zipPath = path.join(tmp, "evil.zip");
    fs.writeFileSync(
      zipPath,
      makeZip([{ name: "C:/Windows/evil.txt", data: "x" }])
    );

    assert.throws(() => zip.unzipToDir(zipPath, path.join(tmp, "out")), /ZIP_UNSAFE_ENTRY_NAME/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("unzipToDir: 拒绝损坏文件与条目数/体积超限", () => {
  const tmp = makeTmpDir();
  try {
    // 损坏: 没有 EOCD
    fs.writeFileSync(path.join(tmp, "broken.zip"), Buffer.from("not a zip at all"));
    assert.throws(
      () => zip.unzipToDir(path.join(tmp, "broken.zip"), path.join(tmp, "o1")),
      /ZIP_EOCD_NOT_FOUND/
    );

    // 条目数超限
    const many = [];
    for (let i = 0; i < 5; i++) many.push({ name: `f${i}.txt`, data: "x" });
    fs.writeFileSync(path.join(tmp, "many.zip"), makeZip(many));
    assert.throws(
      () => zip.unzipToDir(path.join(tmp, "many.zip"), path.join(tmp, "o2"), { maxEntries: 3 }),
      /ZIP_TOO_MANY_ENTRIES/
    );

    // 解压体积超限
    fs.writeFileSync(
      path.join(tmp, "big.zip"),
      makeZip([{ name: "blob.bin", data: "A".repeat(1024) }])
    );
    assert.throws(
      () =>
        zip.unzipToDir(path.join(tmp, "big.zip"), path.join(tmp, "o3"), {
          maxBytes: 512,
        }),
      /ZIP_DECOMPRESSED_TOO_LARGE/
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
