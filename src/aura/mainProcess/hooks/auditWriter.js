// @ts-check

/**
 * 共享审计写入器 (Shared Audit Writer)
 *
 * 背景: cloudUpdateInterceptor / powerOffInterceptor / lockScreenInterceptor
 * 此前各自用 createWriteStream 打开同一个 cloudCommandAudit.log, 并各自做
 * "超限 5MB → rename 轮转"。同一文件被多个句柄持有 + 各自 rename, 在 Windows
 * 下会互相打架: 先轮转者把文件改名后, 其余句柄仍继续往已改名的文件里写, 且
 * 后续轮转的 unlink(.old) 可能删掉别人正在写的文件, 造成审计记录丢失或轮转
 * 失效。
 *
 * 这里把写入收敛为"按文件名统一入口":
 *   - 每次写入用 appendFileSync, 不做长连接句柄, 因此不存在句柄冲突, 也不会有
 *     退出时未 flush 的丢记录;
 *   - 轮转 (rename → .old) 只在写入前惰性执行, 统一由本模块负责。
 * 审计写入频率很低 (每事件一条), 同步写带来的开销可忽略。
 *
 * 用法:
 *   const auditWriter = require("./auditWriter");
 *   auditWriter.writeAudit("cloudCommandAudit.log", record);
 */

const fs = require("fs");
const path = require("path");

const MAX_SIZE = 5 * 1024 * 1024; // 5 MB

/**
 * 解析 <auraDir>/logs/<fileName> 的绝对路径 (目录不存在时创建)
 * @param {string} fileName
 * @returns {string|null}
 */
const resolveFilePath = (fileName) => {
  try {
    const auraDir = global.__HUGO_AURA__ && global.__HUGO_AURA__.auraDir;
    if (!auraDir) return null;
    const logDir = path.join(auraDir, "logs");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    return path.join(logDir, fileName);
  } catch (err) {
    console.error(`[HugoAura / Audit] Failed to resolve ${fileName}:`, err);
    return null;
  }
};

/**
 * 超过上限时把当前文件滚动为 <name>.old
 * @param {string} fileName
 * @param {string} filePath
 */
const rotateIfNeeded = (fileName, filePath) => {
  try {
    // 文件尚不存在 (首次写入) 不等于轮转失败, 不能打成轮转错误日志
    if (!fs.existsSync(filePath)) return;
    if (fs.statSync(filePath).size <= MAX_SIZE) return;
    const oldFile = filePath + ".old";
    // 多个窗口进程可能同时越过上限而一起轮转: 任一环节的目标被别的进程
    // 动过 (ENOENT) 都只跳过本次轮转 —— 下次写入会重试, 不能打成错误日志
    try {
      if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
      fs.renameSync(filePath, oldFile);
    } catch (err) {
      if (err && err.code === "ENOENT") return;
      throw err;
    }
    console.log(`[HugoAura / Audit] ${fileName} rotated.`);
  } catch (err) {
    console.error(`[HugoAura / Audit] Rotate error (${fileName}):`, err);
  }
};

/**
 * 追加一条审计记录 (JSON Lines)
 * @param {string} fileName 日志文件名, 如 "cloudCommandAudit.log"
 * @param {any} record
 * @returns {boolean} 是否写入成功
 */
const writeAudit = (fileName, record) => {
  try {
    const filePath = resolveFilePath(fileName);
    if (!filePath) return false;
    rotateIfNeeded(fileName, filePath);
    fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
    return true;
  } catch (err) {
    console.error(`[HugoAura / Audit] Write error (${fileName}):`, err);
    return false;
  }
};

/**
 * 重写整个审计文件 (供按保留天数清理使用)
 * @param {string} fileName
 * @param {string} content
 * @returns {boolean}
 */
const rewriteAudit = (fileName, content) => {
  try {
    const filePath = resolveFilePath(fileName);
    if (!filePath) return false;
    fs.writeFileSync(filePath, content, "utf8");
    return true;
  } catch (err) {
    console.error(`[HugoAura / Audit] Rewrite error (${fileName}):`, err);
    return false;
  }
};

/**
 * 读取审计文件内容 (不存在时返回空串)
 * @param {string} fileName
 * @returns {string}
 */
const readAudit = (fileName) => {
  try {
    const filePath = resolveFilePath(fileName);
    if (!filePath || !fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    console.error(`[HugoAura / Audit] Read error (${fileName}):`, err);
    return "";
  }
};

module.exports = { writeAudit, rewriteAudit, readAudit };
