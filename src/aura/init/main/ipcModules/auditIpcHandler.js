// @ts-check

const __SCOPE = "main";

const fs = require("fs");
const path = require("path");

/**
 * 指令审计日志可视化 IPC (Audit Log Viewer)
 *
 * 提供审计日志的读取 / 导出 / 清空能力:
 *   - $aura.audit.getLogs    : 读取 cloudCommandAudit.log / screenPeekAudit.log
 *                              (JSON Lines), 按时间倒序返回, 支持 limit 参数
 *   - $aura.audit.exportLogs : 导出为 JSONL 文本 (按时间正序), 供渲染层复制/下载
 *   - $aura.audit.clearLogs  : 清空指定审计日志文件
 *
 * 实时事件推送由各 hook (cloudUpdateInterceptor / screenPeekDetector)
 * 通过 ipcMain.send("*", "$aura.audit.onLog", { record }) 完成。
 */

// 每个来源默认返回的条目数 (防止大文件拖慢渲染); 渲染层可用 limit 覆盖
const DEFAULT_ENTRIES_PER_SOURCE = 300;
// limit 上限: 再大也会拖慢渲染进程
const MAX_ENTRIES_LIMIT = 1000;

/**
 * 归一化 limit 参数 (纯函数, 便于单测)
 * @param {any} raw
 * @returns {number}
 */
const normalizeLimit = (raw) => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ENTRIES_PER_SOURCE;
  return Math.min(MAX_ENTRIES_LIMIT, Math.floor(n));
};

const getLogsDir = () => {
  try {
    const auraDir = global.__HUGO_AURA__ && global.__HUGO_AURA__.auraDir;
    if (!auraDir) return null;
    const logDir = path.join(auraDir, "logs");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    return logDir;
  } catch (err) {
    console.error("[HugoAura / Audit / Error] Failed to resolve log dir:", err);
    return null;
  }
};

/**
 * 解析 JSON Lines 日志文件, 返回按时间倒序的条目 (最多 limit 条)
 * @param {string} filePath
 * @param {number} limit
 */
const parseJsonlFile = (filePath, limit) => {
  const entries = [];
  if (!filePath || !fs.existsSync(filePath)) return entries;

  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    console.error(
      `[HugoAura / Audit / Error] Failed to read ${filePath}:`,
      err
    );
    return entries;
  }

  // 从文件末尾向前解析, 保留最近的 limit 条
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // 跳过损坏行
    }
  }
  return entries;
};

/**
 * @param {import("electron").IpcMain} ipcMain
 */
const applyAuditIpcHandler = (ipcMain) => {
  const methodBase = "$aura.audit";

  ipcMain.handle(
    `${methodBase}.getLogs`,
    /**
     * @param {import("electron").IpcMainInvokeEvent} _evt
     * @param {{ limit?: number }} [arg]
     * @returns {{ success: boolean, error: string | null, data: { cloud: any[], peek: any[] } | null }}
     */
    (_evt, arg) => {
      const logDir = getLogsDir();
      if (!logDir) {
        return { success: false, error: "LOG_DIR_UNAVAILABLE", data: null };
      }

      const limit = normalizeLimit(arg && arg.limit);
      const cloudEntries = parseJsonlFile(
        path.join(logDir, "cloudCommandAudit.log"),
        limit
      );
      const peekEntries = parseJsonlFile(
        path.join(logDir, "screenPeekAudit.log"),
        limit
      );

      return {
        success: true,
        error: null,
        data: {
          // 保留记录自带的 _logType (lockScreen / powerOff / peek / cloud),
          // 仅在缺失时兜底 —— 覆写会让渲染端的锁屏 / 关机徽标与统计全部失效
          cloud: cloudEntries.map((e) => ({
            ...e,
            _logType: e._logType || "cloud",
          })),
          peek: peekEntries.map((e) => ({ ...e, _logType: e._logType || "peek" })),
        },
      };
    }
  );

  ipcMain.handle(
    `${methodBase}.exportLogs`,
    /**
     * 导出审计日志为 JSONL 文本 (按时间正序, 便于保存或贴出来分析)。
     * 不落盘 —— 由渲染层决定是复制到剪贴板还是下载成文件。
     * @param {import("electron").IpcMainInvokeEvent} _evt
     * @param {{ limit?: number }} [arg]
     * @returns {{ success: boolean, error: string | null, data: { text: string, count: number } | null }}
     */
    (_evt, arg) => {
      const logDir = getLogsDir();
      if (!logDir) {
        return { success: false, error: "LOG_DIR_UNAVAILABLE", data: null };
      }

      const limit = normalizeLimit(arg && arg.limit);
      const merged = [
        ...parseJsonlFile(path.join(logDir, "cloudCommandAudit.log"), limit),
        ...parseJsonlFile(path.join(logDir, "screenPeekAudit.log"), limit),
      ];
      // parseJsonlFile 返回倒序, 这里按时间正序排好再导出
      merged.sort(
        (a, b) =>
          (new Date(a.ts).getTime() || 0) - (new Date(b.ts).getTime() || 0)
      );

      const text =
        merged.map((e) => JSON.stringify(e)).join("\n") +
        (merged.length > 0 ? "\n" : "");

      return { success: true, error: null, data: { text, count: merged.length } };
    }
  );

  ipcMain.handle(
    `${methodBase}.clearLogs`,
    /**
     * @param {import("electron").IpcMainInvokeEvent} _evt
     * @param {{ target: "cloud" | "peek" | "all" }} arg
     * @returns {{ success: boolean, error: string | null }}
     */
    (_evt, arg) => {
      const logDir = getLogsDir();
      if (!logDir) {
        return { success: false, error: "LOG_DIR_UNAVAILABLE" };
      }

      const target = arg && arg.target ? arg.target : "all";
      const targets =
        target === "cloud"
          ? ["cloudCommandAudit.log"]
          : target === "peek"
          ? ["screenPeekAudit.log"]
          : ["cloudCommandAudit.log", "screenPeekAudit.log"];

      for (const fileName of targets) {
        try {
          fs.writeFileSync(path.join(logDir, fileName), "");
        } catch (err) {
          console.error(
            `[HugoAura / Audit / Error] Failed to clear ${fileName}:`,
            err
          );
          return { success: false, error: "CLEAR_FAILED" };
        }
      }
      return { success: true, error: null };
    }
  );
};

module.exports = { applyAuditIpcHandler, parseJsonlFile, normalizeLimit };
