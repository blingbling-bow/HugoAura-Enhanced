// @ts-check

const __SCOPE = "main";

const fs = require("fs");
const path = require("path");

/**
 * 指令审计日志可视化 IPC (Audit Log Viewer)
 *
 * 提供审计日志的读取与清空能力:
 *   - $aura.audit.getLogs    : 读取 cloudCommandAudit.log / screenPeekAudit.log
 *                              (JSON Lines), 按时间倒序返回
 *   - $aura.audit.clearLogs  : 清空指定审计日志文件
 *
 * 实时事件推送由各 hook (cloudUpdateInterceptor / screenPeekDetector)
 * 通过 ipcMain.send("*", "$aura.audit.onLog", { record }) 完成。
 */

// 每个来源最多返回的条目数 (防止大文件拖慢渲染)
const MAX_ENTRIES_PER_SOURCE = 300;

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
     * @returns {{ success: boolean, error: string | null, data: { cloud: any[], peek: any[] } | null }}
     */
    (_evt) => {
      const logDir = getLogsDir();
      if (!logDir) {
        return { success: false, error: "LOG_DIR_UNAVAILABLE", data: null };
      }

      const cloudEntries = parseJsonlFile(
        path.join(logDir, "cloudCommandAudit.log"),
        MAX_ENTRIES_PER_SOURCE
      );
      const peekEntries = parseJsonlFile(
        path.join(logDir, "screenPeekAudit.log"),
        MAX_ENTRIES_PER_SOURCE
      );

      return {
        success: true,
        error: null,
        data: {
          cloud: cloudEntries.map((e) => ({ ...e, _logType: "cloud" })),
          peek: peekEntries.map((e) => ({ ...e, _logType: "peek" })),
        },
      };
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

module.exports = { applyAuditIpcHandler };
