// @ts-check

const fs = require("fs");
const path = require("path");
const os = require("os");
const { dialog } = require("electron");

const __SCOPE = "main";

/** 导出文件大小上限 (4MB) 与标记字段 */
const EXPORT_MAX_BYTES = 4 * 1024 * 1024;
const EXPORT_KIND = "HugoAura-Config-Export";

/**
 * 收集已安装插件的私有设置 (plugins/<id>/storage/settings.json)。
 * @param {string} auraDir
 */
const collectPluginSettings = (auraDir) => {
  const pluginsRoot = path.join(auraDir, "plugins");
  const result = {};
  try {
    if (!fs.existsSync(pluginsRoot)) return result;
    for (const entry of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const settingsPath = path.join(
        pluginsRoot, entry.name, "storage", "settings.json"
      );
      try {
        if (!fs.existsSync(settingsPath)) continue;
        const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
        if (parsed && typeof parsed === "object") result[entry.name] = parsed;
      } catch (err) {
        console.warn(`[HugoAura / Config / Export] Skip plugin settings (${entry.name}):`, err);
      }
    }
  } catch (err) {
    console.warn("[HugoAura / Config / Export] Failed to scan plugin settings:", err);
  }
  return result;
};

/**
 * 把插件私有设置写回已安装插件的 storage (未安装的跳过)。
 * @param {string} auraDir
 * @param {Record<string, any>} settingsMap
 */
const applyPluginSettings = (auraDir, settingsMap) => {
  const applied = [];
  const skipped = [];
  const pluginsRoot = path.join(auraDir, "plugins");
  for (const [id, values] of Object.entries(settingsMap || {})) {
    try {
      const pluginDir = path.join(pluginsRoot, id);
      // 只对已安装 (manifest 存在) 的插件写设置, 防止借导入创建任意目录
      if (
        !/^[A-Za-z][A-Za-z0-9._-]{2,63}$/.test(id) ||
        !fs.existsSync(path.join(pluginDir, "manifest.json"))
      ) {
        skipped.push(id);
        continue;
      }
      const storageDir = path.join(pluginDir, "storage");
      fs.mkdirSync(storageDir, { recursive: true });
      fs.writeFileSync(
        path.join(storageDir, "settings.json"),
        JSON.stringify(values || {}, null, 2)
      );
      applied.push(id);
    } catch (err) {
      console.warn(`[HugoAura / Config / Import] Failed to apply settings for ${id}:`, err);
      skipped.push(id);
    }
  }
  return { applied, skipped };
};

/**
 *
 * @param {import("../../../types/main/electron").AuraIPCMain} ipcMain
 */
const applyConfigIpcHandler = (ipcMain) => {
  const methodBase = "$aura.config";

  const mainEventBus = global.__HUGO_AURA_EVENT_BUS__;

  const ConfigManager = require("../../shared/configManager");
  const configManager = global.__HUGO_AURA_CONFIG_MGR__
    ? global.__HUGO_AURA_CONFIG_MGR__
    : new ConfigManager();

  ipcMain.on(`${methodBase}.refreshMainConfig`, (_event) => {
    mainEventBus.emit("$aura.config.refreshConfig");
  });

  ipcMain.handle(
    `${methodBase}.setConfigEncSettings`,
    (
      /** @type {import("electron").IpcMainInvokeEvent} */ _event,
      /** @type {{ target: boolean }} */ arg
    ) => {
      mainEventBus.emit("$aura.config.updateConfigEncSettings", arg.target);
      return {
        success: true,
      };
    }
  );

  ipcMain.on(`${methodBase}.getConfigFromMainSync`, (event, _arg) => {
    if (
      global.__HUGO_AURA_CONFIG__ &&
      Object.keys(global.__HUGO_AURA_CONFIG__).length !== 0
    ) {
      event.returnValue = {
        success: true,
        data: global.__HUGO_AURA_CONFIG__,
      };
    } else {
      console.warn(
        "[HugoAura / Main / IPC / Config / WARN] Global config var not found!"
      );
      event.returnValue = {
        success: false,
        data: {},
      };
    }
  });

  ipcMain.handle(
    `${methodBase}.dispatchConfigFromRenderer`,
    (_event, /** @type {{data: string, writeConfig?: boolean}} */ arg) => {
      const parsedData = JSON.parse(arg.data);

      global.__HUGO_AURA_CONFIG__ = parsedData;

      if (arg.writeConfig) {
        const result = configManager.writeConfig(parsedData);
        if (!result) {
          return {
            success: false,
          };
        }
      }

      return {
        success: true,
      };
    }
  );

  // ---- 配置导出 / 导入 (批量部署与迁移) ----

  // 导出: 渲染层递交完整配置 JSON, 主进程合并插件私有设置后经保存框写盘。
  // 加密标志由渲染层强制置 false (目标设备需重新开启加密以生成自己的
  // DPAPI 凭据, 直接带入会因注册表口令缺失而无法解密)。
  ipcMain.handle(
    `${methodBase}.exportToFile`,
    async (_event, /** @type {{dataJson?: string}} */ arg) => {
      try {
        const dataJson = arg && typeof arg.dataJson === "string" ? arg.dataJson : "";
        if (!dataJson || dataJson.length > EXPORT_MAX_BYTES) {
          return { success: false, error: "INVALID_PAYLOAD" };
        }
        let payload;
        try {
          payload = JSON.parse(dataJson);
        } catch {
          return { success: false, error: "INVALID_JSON" };
        }
        if (!payload || payload.kind !== EXPORT_KIND || !payload.config) {
          return { success: false, error: "INVALID_PAYLOAD" };
        }

        const auraDir = global.__HUGO_AURA__ && global.__HUGO_AURA__.auraDir;
        payload.pluginSettings = collectPluginSettings(auraDir);

        const now = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
          now.getDate()
        )}-${pad(now.getHours())}${pad(now.getMinutes())}`;
        const save = await dialog.showSaveDialog({
          title: "导出 HugoAura 配置",
          defaultPath: path.join(
            os.homedir(), "Desktop",
            `HugoAura-config-${stamp}.json`
          ),
          filters: [{ name: "HugoAura 配置", extensions: ["json"] }],
        });
        if (save.canceled || !save.filePath) {
          return { success: false, error: "CANCELED" };
        }
        fs.writeFileSync(save.filePath, JSON.stringify(payload, null, 2), "utf8");
        return {
          success: true,
          data: {
            path: save.filePath,
            pluginSettingsCount: Object.keys(payload.pluginSettings).length,
          },
        };
      } catch (err) {
        console.error("[HugoAura / Config / Export] Failed:", err);
        return { success: false, error: String(err && err.message ? err.message : err) };
      }
    }
  );

  // 导入: 打开框读文件并解析校验, 返回载荷由渲染层确认后应用
  ipcMain.handle(`${methodBase}.importFromFile`, async () => {
    try {
      const open = await dialog.showOpenDialog({
        title: "导入 HugoAura 配置",
        filters: [{ name: "HugoAura 配置", extensions: ["json"] }],
        properties: ["openFile"],
      });
      if (open.canceled || !open.filePaths.length) {
        return { success: false, error: "CANCELED" };
      }
      const raw = fs.readFileSync(open.filePaths[0], "utf8");
      if (!raw || raw.length > EXPORT_MAX_BYTES) {
        return { success: false, error: "FILE_TOO_LARGE" };
      }
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        return { success: false, error: "INVALID_JSON" };
      }
      if (
        !payload ||
        payload.kind !== EXPORT_KIND ||
        !payload.config ||
        typeof payload.config !== "object"
      ) {
        return { success: false, error: "NOT_A_CONFIG_EXPORT" };
      }
      return {
        success: true,
        data: {
          payload,
          path: open.filePaths[0],
        },
      };
    } catch (err) {
      console.error("[HugoAura / Config / Import] Failed:", err);
      return { success: false, error: String(err && err.message ? err.message : err) };
    }
  });

  // 导入的第二步: 把插件私有设置写回已安装插件 (由渲染层确认后调用)
  ipcMain.handle(
    `${methodBase}.applyPluginSettings`,
    (_event, /** @type {{settingsMap?: Record<string, any>}} */ arg) => {
      try {
        const auraDir = global.__HUGO_AURA__ && global.__HUGO_AURA__.auraDir;
        if (!auraDir) return { success: false, error: "NO_AURA_DIR" };
        const settingsMap =
          arg && typeof arg.settingsMap === "object" ? arg.settingsMap : {};
        return { success: true, data: applyPluginSettings(auraDir, settingsMap) };
      } catch (err) {
        return { success: false, error: String(err && err.message ? err.message : err) };
      }
    }
  );
};

module.exports = { applyConfigIpcHandler };
