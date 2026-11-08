// @ts-check

/**
 * 自研 ZIP 解压器 (零依赖)。
 *
 * 为什么自己写: HugoAura 注入包刻意保持零运行时依赖 (package.json 无
 * dependencies), 管家宿主的 node_modules 也没有任何 zip 库。插件市场需要
 * "下载 zip -> 解压 -> 安装", 因此这里基于 Node 内置 zlib 实现一个最小
 * 但足够安全的 ZIP 读取器。
 *
 * 支持范围 (够用即可, 插件包由本生态约定生成):
 *   - 无加密、无 zip64、无分卷的常规 ZIP;
 *   - 存储 (method 0) 与 Deflate (method 8) 两种压缩方式;
 *   - 文件名按 UTF-8 解读 (zip 生成方需置 UTF-8 标志或使用 ASCII 名)。
 *
 * 安全防护 (插件包来自网络/他人, 不可信):
 *   - 条目数上限 (maxEntries) 与解压总字节上限 (maxBytes), 防 zip 炸弹;
 *   - 条目名路径穿越防护: 拒绝 ".."、绝对路径、盘符, 解压结果必须落在
 *     目标目录内;
 *   - 严格校验签名与边界, 解压失败即整体放弃 (不落半截文件)。
 *
 * 实现: 读中央目录 (EOCD 定位) 拿每个条目的真实压缩/原始尺寸与本地头
 * 偏移, 再按本地头 (文件名/额外字段长度可能与中央目录不同) 定位数据段。
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIG_LOCAL = 0x04034b50; // PK\x03\x04
const SIG_CENTRAL = 0x02014b50; // PK\x01\x02
const SIG_EOCD = 0x06054b50; // PK\x05\x06

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

// 防护默认值: 插件包不是数据库, 远用不了这么多
const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * 在缓冲区尾部搜索 EOCD 签名 (允许最多 64KB 注释)。
 * @param {Buffer} buf
 * @returns {number} EOCD 签名的绝对偏移; 找不到返回 -1
 */
const findEocd = (buf) => {
  const minPos = Math.max(0, buf.length - (0xffff + 22));
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
};

/**
 * 解析中央目录, 返回条目信息列表。
 * @param {Buffer} buf
 * @returns {{ entries: {name: string, method: number, compressedSize: number, uncompressedSize: number, localOffset: number}[] }}
 */
const readCentralDirectory = (buf) => {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("ZIP_EOCD_NOT_FOUND");

  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > buf.length) throw new Error("ZIP_CENTRAL_DIR_OUT_OF_RANGE");

  /** @type {{name: string, method: number, compressedSize: number, uncompressedSize: number, localOffset: number}[]} */
  const entries = [];
  let pos = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== SIG_CENTRAL) {
      throw new Error("ZIP_CENTRAL_DIR_CORRUPTED");
    }
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString("utf8");

    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return { entries };
};

/**
 * 按中央目录信息提取单个条目的原始数据。
 * @param {Buffer} buf
 * @param {{name: string, method: number, compressedSize: number, uncompressedSize: number, localOffset: number}} entry
 * @returns {Buffer}
 */
const extractEntryData = (buf, entry) => {
  const off = entry.localOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== SIG_LOCAL) {
    throw new Error("ZIP_LOCAL_HEADER_CORRUPTED");
  }
  // 本地头的文件名/额外字段长度可能与中央目录不同, 必须以本地头为准
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  if (dataStart + entry.compressedSize > buf.length) {
    throw new Error("ZIP_ENTRY_DATA_OUT_OF_RANGE");
  }
  const compressed = buf.slice(dataStart, dataStart + entry.compressedSize);

  if (entry.method === METHOD_STORED) return compressed;
  if (entry.method === METHOD_DEFLATE) {
    return zlib.inflateRawSync(compressed);
  }
  throw new Error(`ZIP_UNSUPPORTED_METHOD_${entry.method}`);
};

/**
 * 校验条目名并换算成目标目录内的安全绝对路径。
 * 拒绝: 绝对路径 / 盘符 / ".." 穿越 / 空名。
 *
 * @param {string} destDir
 * @param {string} entryName
 * @returns {string | null} 安全目标路径; 目录条目返回 null (由调用方 mkdir)
 */
const safeJoinEntry = (destDir, entryName) => {
  if (!entryName || entryName.endsWith("/")) return null;
  const parts = entryName.split("/");
  for (const part of parts) {
    if (part === ".." || part === "" || /^[A-Za-z]:$/.test(part)) {
      throw new Error(`ZIP_UNSAFE_ENTRY_NAME: ${entryName}`);
    }
  }
  const joined = path.join(destDir, ...parts);
  const resolved = path.resolve(joined);
  if (
    resolved !== path.resolve(destDir) &&
    !resolved.startsWith(path.resolve(destDir) + path.sep)
  ) {
    throw new Error(`ZIP_UNSAFE_ENTRY_NAME: ${entryName}`);
  }
  return resolved;
};

/**
 * 解压 zip 文件到目标目录。
 *
 * @param {string} zipPath zip 文件路径
 * @param {string} destDir 目标目录 (不存在则递归创建; 解压前不清空, 调用方保证)
 * @param {{ maxEntries?: number, maxBytes?: number }} [options]
 * @returns {{ files: {name: string, size: number}[] }} 解压出的文件清单 (相对名)
 */
const unzipToDir = (zipPath, destDir, options = {}) => {
  const maxEntries = options.maxEntries || DEFAULT_MAX_ENTRIES;
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;

  const buf = fs.readFileSync(zipPath);
  fs.mkdirSync(destDir, { recursive: true });

  const { entries } = readCentralDirectory(buf);
  if (entries.length > maxEntries) {
    throw new Error(`ZIP_TOO_MANY_ENTRIES: ${entries.length} > ${maxEntries}`);
  }

  let totalBytes = 0;
  /** @type {{name: string, size: number}[]} */
  const files = [];

  for (const entry of entries) {
    const target = safeJoinEntry(destDir, entry.name);
    if (!target) continue; // 目录条目

    if (entry.uncompressedSize > maxBytes - totalBytes) {
      throw new Error("ZIP_DECOMPRESSED_TOO_LARGE");
    }

    const data = extractEntryData(buf, entry);
    if (data.length !== entry.uncompressedSize) {
      throw new Error(`ZIP_SIZE_MISMATCH: ${entry.name}`);
    }
    totalBytes += data.length;

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    files.push({ name: entry.name, size: data.length });
  }

  return { files };
};

module.exports = { unzipToDir };
