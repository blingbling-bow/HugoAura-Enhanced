// @ts-check

/**
 * 共享审计写入器 (Shared Audit Writer)
 *
 * 背景: cloudUpdateInterceptor / powerOffInterceptor / lockScreenInterceptor
 * 此前各自用 createWriteStream 打开同一个 cloudCommandAudit.log, 并各自做
 * "超限 5MB → rename 轮转"。同一文件被多个句柄持有 + 各自 rename, 在 Windows
 * 下会互相打架: 先轮转者把文件改名后, 其余句柄仍继续往已改名的文件里写, 且
 * 后续轮转的 unlink(.old) 可能删掉别人正在写的文件, 造成审计记录丢失或轮转
 * 失效。这里把写入收敛为"按文件名统一入口"。
 *
 * 性能 (真机优化): 钩子按 "云端消息粒度" 写审计, 且每个管理器窗口都是独立
 * 主进程 —— 同步磁盘追加在弱机 + 杀毒实时扫描下每次可达几十毫秒, 消息密集
 * 时表现为界面有概率卡死。现在写入进入内存队列, 由 400ms 的合并刷盘定时器
 * 用 **异步 appendFile** 批量落盘; 轮转/保留清理同样异步化。
 * 代价: 进程崩溃时可能丢失最后 400ms 内的审计记录 (诊断日志, 可接受)。
 *
 * 用法:
 *   auditWriter.writeAudit("cloudCommandAudit.log", record, { retentionDays: 7 });
 *   auditWriter.flushAudit("cloudCommandAudit.log");   // 可选: 立即刷盘 (测试用)
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const FLUSH_DELAY_MS = 400;
// 按保留天数清理的节流间隔: 距离上次清理不足该时长则跳过, 避免频繁读盘
const CLEANUP_INTERVAL_MS = 3600 * 1000;
// fileName -> 上次清理时间
const lastCleanupAt = {};

/** fileName -> { records: string[], retentionDays: number } */
const pendingQueues = {};
/** fileName -> flush 定时器 */
const flushTimers = {};

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
 * 超过上限时把当前文件滚动为 <name>.old (异步)
 * @param {string} fileName
 * @param {string} filePath
 */
const rotateIfNeeded = async (fileName, filePath) => {
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
 * 追加一条审计记录 (JSON Lines)。
 * 记录进入内存队列, 由合并刷盘器异步批量落盘 (立即返回, 不阻塞调用方)。
 *
 * @param {string} fileName 日志文件名, 如 "cloudCommandAudit.log"
 * @param {any} record
 * @param {{ retentionDays?: number }} [options] 传入 retentionDays 时, 刷盘后
 *        惰性按保留天数清理 (节流 1 小时, 见 cleanupExpired)
 * @returns {boolean} 是否成功入队
 */
const writeAudit = (fileName, record, options = {}) => {
  try {
    const filePath = resolveFilePath(fileName);
    if (!filePath) return false;
    if (!pendingQueues[fileName]) {
      pendingQueues[fileName] = { records: [], retentionDays: 0 };
    }
    const queue = pendingQueues[fileName];
    queue.records.push(JSON.stringify(record));
    const days = Number(options && options.retentionDays);
    if (Number.isFinite(days) && days > queue.retentionDays) {
      queue.retentionDays = days;
    }
    if (!flushTimers[fileName]) {
      const timer = setTimeout(() => flushAudit(fileName), FLUSH_DELAY_MS);
      if (typeof timer.unref === "function") timer.unref();
      flushTimers[fileName] = timer;
    }
    return true;
  } catch (err) {
    console.error(`[HugoAura / Audit] Enqueue error (${fileName}):`, err);
    return false;
  }
};

/**
 * 立即刷盘: 轮转 → 异步批量追加 → 保留清理。flush 定时器与测试调用。
 * @param {string} fileName
 */
const flushAudit = async (fileName) => {
  const queue = pendingQueues[fileName];
  if (!queue) return;
  delete pendingQueues[fileName];
  if (flushTimers[fileName]) {
    clearTimeout(flushTimers[fileName]);
    delete flushTimers[fileName];
  }
  if (!queue.records.length) return;

  try {
    const filePath = resolveFilePath(fileName);
    if (!filePath) return;
    await rotateIfNeeded(fileName, filePath);
    const joined = queue.records.join("\n") + "\n";
    await fsp.appendFile(filePath, joined, "utf8");
    // 写完再清理: 刚写入的这些时间最新, 不会被自己删掉
    if (queue.retentionDays) {
      await cleanupExpired(fileName, queue.retentionDays);
    }
  } catch (err) {
    console.error(`[HugoAura / Audit] Flush error (${fileName}):`, err);
  }
};

/** 立即刷出所有排队中的审计文件 (测试与退出前调用) */
const flushAll = async () => {
  for (const fileName of Object.keys(pendingQueues)) {
    await flushAudit(fileName);
  }
};

/**
 * 过滤出未过期的行 (纯函数, 便于单测)。
 *
 * 解析 JSON Lines 内容, 保留 ts >= cutoffTs 的行; 损坏行一律保留 (宁可留着
 * 也不能因为一行解析失败就删掉整段历史)。
 *
 * @param {string} content 日志文件完整内容
 * @param {number} cutoffTs 时间戳下限 (早于该时间的条目视为过期)
 * @returns {{ kept: string[], removed: number }}
 */
const filterExpired = (content, cutoffTs) => {
  const kept = [];
  let removed = 0;
  for (const line of String(content).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed);
      const ts = rec.ts ? new Date(rec.ts).getTime() : NaN;
      if (!isNaN(ts) && ts < cutoffTs) {
        removed++;
        continue;
      }
    } catch {
      // 损坏行保留, 不删除
    }
    kept.push(trimmed);
  }
  return { kept, removed };
};

/**
 * 按保留天数清理指定审计文件 (节流 1 小时, 多进程/多 hook 调用安全)。
 * 异步读写: 最多 5MB 的整文件重写不再阻塞主进程事件循环。
 *
 * @param {string} fileName
 * @param {number} retentionDays
 * @param {number} [now] 便于单测注入
 * @returns {Promise<number>} 删除的条目数
 */
const cleanupExpired = async (fileName, retentionDays, now = Date.now()) => {
  try {
    const days = Number(retentionDays);
    if (!Number.isFinite(days) || days <= 0) return 0;
    if (now - (lastCleanupAt[fileName] || 0) < CLEANUP_INTERVAL_MS) return 0;
    lastCleanupAt[fileName] = now;

    const content = await readAuditAsync(fileName);
    if (!content) return 0;
    const { kept, removed } = filterExpired(
      content,
      now - days * 24 * 3600 * 1000
    );
    if (removed > 0) {
      await rewriteAudit(fileName, kept.length ? kept.join("\n") + "\n" : "");
      console.log(
        `[HugoAura / Audit] ${fileName}: cleaned ${removed} expired entries (>${days}d).`
      );
    }
    return removed;
  } catch (err) {
    console.error(`[HugoAura / Audit] Cleanup error (${fileName}):`, err);
    return 0;
  }
};

/**
 * 重写整个审计文件 (供按保留天数清理使用; 异步)
 * @param {string} fileName
 * @param {string} content
 * @returns {Promise<boolean>}
 */
const rewriteAudit = async (fileName, content) => {
  try {
    const filePath = resolveFilePath(fileName);
    if (!filePath) return false;
    await fsp.writeFile(filePath, content, "utf8");
    return true;
  } catch (err) {
    console.error(`[HugoAura / Audit] Rewrite error (${fileName}):`, err);
    return false;
  }
};

/**
 * 读取审计文件内容 (不存在时返回空串; 同步 —— 仅供导出/低频路径使用)
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

const readAuditAsync = async (fileName) => {
  try {
    const filePath = resolveFilePath(fileName);
    if (!filePath || !fs.existsSync(filePath)) return "";
    return await fsp.readFile(filePath, "utf8");
  } catch (err) {
    console.error(`[HugoAura / Audit] Read error (${fileName}):`, err);
    return "";
  }
};

module.exports = {
  writeAudit,
  flushAudit,
  flushAll,
  rewriteAudit,
  readAudit,
  readAuditAsync,
  filterExpired,
  cleanupExpired,
  CLEANUP_INTERVAL_MS,
  MAX_SIZE,
};
