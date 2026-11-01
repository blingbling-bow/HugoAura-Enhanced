// @ts-check

/**
 * 插件运行时 (main 类型) — 加载/停用 <auraDir>/plugins 下的主进程插件。
 *
 * 插件 = 一个目录: manifest.json + main.js (可带其他资源文件)。
 * main.js 导出 { onLoad(ctx), onUnload? }:
 *   - onLoad(ctx) 在启用时调用一次;
 *   - onUnload() 在停用/卸载时尽力调用 (插件应自行清理定时器/事件订阅)。
 *
 * ctx = {
 *   manifest, auraVersion,
 *   logger: { log / warn / error / debug } (自带 [HugoAura / Plugin:<id>] 前缀),
 *   config: { get() } (热读全量配置),
 *   eventBus (进程内事件总线, 可订阅 $aura.config.refreshConfig 等),
 *   storageDir (插件私有可写目录, 已创建),
 *   central (管家 webpack 模块加载器 — 能力等同内置钩子, 谨慎使用)
 * }
 *
 * 安全模型: 插件与 Aura 自身同权限运行 (无沙箱), 安装时已在 UI 明确警示;
 * 加载与调用全程逐插件 try/catch 隔离, 单个插件崩溃不影响 Aura。
 */

const fs = require("fs");
const path = require("path");
const {
  runMainPlugin,
  resolveGrantedPermissions,
} = require("./pluginSandbox");

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{2,63}$/;
const PLUGIN_TYPES = ["main", "ui"];
const MANIFEST_FIELDS_REQUIRED = ["id", "name", "version", "author", "type", "main"];

const pluginsRoot = () => {
  const auraDir = global.__HUGO_AURA__ && global.__HUGO_AURA__.auraDir;
  if (!auraDir) return null;
  return path.join(auraDir, "plugins");
};

/**
 * 校验 manifest 结构。
 * @param {any} manifest
 * @param {string} [expectedId] 期望的插件 id (目录名), 提供时校验一致性
 * @returns {{ok: boolean, reason?: string}}
 */
const validateManifest = (manifest, expectedId) => {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, reason: "MANIFEST_NOT_OBJECT" };
  }
  for (const field of MANIFEST_FIELDS_REQUIRED) {
    if (typeof manifest[field] !== "string" || !String(manifest[field]).trim()) {
      return { ok: false, reason: `MANIFEST_FIELD_MISSING: ${field}` };
    }
  }
  if (!ID_PATTERN.test(manifest.id)) {
    return { ok: false, reason: "MANIFEST_ID_INVALID" };
  }
  if (!PLUGIN_TYPES.includes(manifest.type)) {
    return { ok: false, reason: "MANIFEST_TYPE_INVALID" };
  }
  // main 必须是插件目录内的相对 js 文件名, 防借路径越权
  if (
    manifest.main.includes("/") ||
    manifest.main.includes("\\") ||
    manifest.main.includes("..") ||
    !manifest.main.endsWith(".js")
  ) {
    return { ok: false, reason: "MANIFEST_MAIN_INVALID" };
  }
  if (expectedId && manifest.id !== expectedId) {
    return { ok: false, reason: "MANIFEST_ID_MISMATCH" };
  }
  // ---- 可选扩展字段 (v1.1: 配置界面 / 权限声明 / 能力 / API 等级) ----
  if (manifest.configUI !== undefined) {
    if (!Array.isArray(manifest.configUI)) {
      return { ok: false, reason: "MANIFEST_CONFIGUI_INVALID" };
    }
    for (const row of manifest.configUI) {
      if (
        !row ||
        typeof row.key !== "string" ||
        !row.key.trim() ||
        typeof row.label !== "string" ||
        !["input", "select", "switch"].includes(row.type)
      ) {
        return { ok: false, reason: "MANIFEST_CONFIGUI_INVALID" };
      }
      if (row.type === "select" && !Array.isArray(row.options)) {
        return { ok: false, reason: "MANIFEST_CONFIGUI_INVALID" };
      }
    }
  }
  if (manifest.permissions !== undefined) {
    if (!Array.isArray(manifest.permissions)) {
      return { ok: false, reason: "MANIFEST_PERMISSIONS_INVALID" };
    }
    for (const perm of manifest.permissions) {
      if (
        !perm ||
        typeof perm.key !== "string" ||
        !perm.key.trim() ||
        typeof perm.label !== "string"
      ) {
        return { ok: false, reason: "MANIFEST_PERMISSIONS_INVALID" };
      }
    }
  }
  if (
    manifest.capabilities !== undefined &&
    (typeof manifest.capabilities !== "object" ||
      Array.isArray(manifest.capabilities))
  ) {
    return { ok: false, reason: "MANIFEST_CAPABILITIES_INVALID" };
  }
  if (
    manifest.apiLevel !== undefined &&
    (!Number.isInteger(manifest.apiLevel) || manifest.apiLevel < 1)
  ) {
    return { ok: false, reason: "MANIFEST_APILEVEL_INVALID" };
  }
  if (
    manifest.homepage !== undefined &&
    typeof manifest.homepage === "string" &&
    manifest.homepage &&
    !/^https:\/\//.test(manifest.homepage)
  ) {
    return { ok: false, reason: "MANIFEST_HOMEPAGE_INVALID" };
  }
  return { ok: true };
};

/**
 * 读取并校验插件目录的 manifest.json (同时确认入口文件存在)。
 * @param {string} pluginDir
 * @param {string} [expectedId]
 * @returns {any} manifest
 */
const readManifest = (pluginDir, expectedId) => {
  const manifestPath = path.join(pluginDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const check = validateManifest(manifest, expectedId);
  if (!check.ok) throw new Error(check.reason);
  if (!fs.existsSync(path.join(pluginDir, manifest.main))) {
    throw new Error("PLUGIN_MAIN_MISSING");
  }
  return manifest;
};

/** @type {Map<string, {manifest: any, pluginDir: string, instance: any}>} */
const loadedMainPlugins = new Map();

/**
 * 开关判定: auraSettings.plugins.enabled[id] === true
 * @param {string} id
 */
const isPluginEnabled = (id) => {
  let config = null;
  try {
    config = global.__HUGO_AURA_CONFIG_MGR__?.loadConfig?.() || null;
  } catch (err) {
    console.error("[HugoAura / Plugins] Failed to read config:", err);
  }
  return Boolean(
    config &&
      config.auraSettings &&
      config.auraSettings.plugins &&
      config.auraSettings.plugins.enabled &&
      config.auraSettings.plugins.enabled[id] === true
  );
};

const SETTINGS_FILE = "settings.json";

/**
 * 读插件持久化设置 (storage/settings.json; 不存在/损坏返回空对象)。
 * @param {string} pluginDir
 * @returns {any}
 */
const readPluginSettings = (pluginDir) => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(pluginDir, "storage", SETTINGS_FILE), "utf8")
    );
  } catch (err) {
    return {};
  }
};

/**
 * 写插件持久化设置 (ui 配置弹窗与 main 插件 ctx.settings 共用一份文件)。
 * @param {string} pluginDir
 * @param {any} values
 */
const writePluginSettings = (pluginDir, values) => {
  const storageDir = path.join(pluginDir, "storage");
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(
    path.join(storageDir, SETTINGS_FILE),
    JSON.stringify(values || {}, null, 2)
  );
};

/**
 * 构造插件沙箱的宿主侧能力 (权限门控由 pluginSandbox 二次校验)。
 * @param {any} manifest
 * @param {string} pluginDir
 */
const buildSandboxDeps = (manifest, pluginDir) => {
  const storageDir = path.join(pluginDir, "storage");
  fs.mkdirSync(storageDir, { recursive: true });
  // electron 懒加载: 单测环境无 electron, 缺失时 notify/shortcuts 报 NOT_AVAILABLE
  let electron = null;
  let alertWindowHook = null;
  try {
    electron = require("electron");
    alertWindowHook = require("../../mainProcess/hooks/alertWindow");
  } catch (err) {
    electron = null;
  }
  return {
    settingsApi: {
      get: () => readPluginSettings(pluginDir),
      set: (values) => writePluginSettings(pluginDir, values),
    },
    busApi: {
      on: (event, fn) => {
        try {
          global.__HUGO_AURA_EVENT_BUS__.on(event, fn);
        } catch (err) {
          console.error(`[HugoAura / Plugin:${manifest.id}] bus.on 失败:`, err);
        }
      },
      off: (event, fn) => {
        try {
          global.__HUGO_AURA_EVENT_BUS__.off(event, fn);
        } catch (err) {
          console.error(`[HugoAura / Plugin:${manifest.id}] bus.off 失败:`, err);
        }
      },
      emit: (event, payload) => {
        try {
          global.__HUGO_AURA_EVENT_BUS__.emit(event, payload);
        } catch (err) {
          console.error(`[HugoAura / Plugin:${manifest.id}] bus.emit 失败:`, err);
        }
      },
    },
    notifyApi:
      electron && alertWindowHook && typeof alertWindowHook.showAlertWindow === "function"
        ? (record) => alertWindowHook.showAlertWindow(electron, record)
        : null,
    shortcutsApi:
      electron && electron.globalShortcut
        ? {
            register: (accelerator, cb) =>
              electron.globalShortcut.register(accelerator, cb),
            unregister: (accelerator) =>
              electron.globalShortcut.unregister(accelerator),
          }
        : null,
    storageDir,
  };
};

/**
 * 读取用户在插件详情弹窗里的权限开关 (auraSettings.plugins.permissions[id])。
 * 未配置的权限默认视为开启; 显式 false 即关闭。
 * @param {string} id
 */
const getUserPermissionState = (id) => {
  try {
    const config = global.__HUGO_AURA_CONFIG_MGR__
      ? global.__HUGO_AURA_CONFIG_MGR__.loadConfig()
      : null;
    const perms =
      config &&
      config.auraSettings &&
      config.auraSettings.plugins &&
      config.auraSettings.plugins.permissions;
    return (perms && perms[id]) || {};
  } catch (err) {
    return {};
  }
};

/**
 * 加载一个 main 插件 (调用方负责 try/catch)。
 * main 插件在 vm 能力沙箱中运行: 无 require/fs/central, 仅暴露
 * manifest/config/logger/timers + 声明的 storage/events/network 能力。
 * 授予集 = manifest 声明 ∩ 用户权限开关 (详情弹窗, 显式 false 即关闭)。
 * @param {string} pluginDir
 * @param {any} manifest
 */
const loadMainPlugin = (pluginDir, manifest) => {
  const mainPath = path.join(pluginDir, manifest.main);
  const source = fs.readFileSync(mainPath, "utf8");
  const deps = buildSandboxDeps(manifest, pluginDir);
  const userPermState = getUserPermissionState(manifest.id);
  const granted = resolveGrantedPermissions(manifest).filter((key) => {
    const userSetting = userPermState[key];
    return userSetting === undefined ? true : userSetting !== false;
  });
  const sandboxRun = runMainPlugin({
    source,
    manifest,
    auraVersion: (global.__HUGO_AURA__ && global.__HUGO_AURA__.version) || "",
    permissionsGranted: granted,
    settingsApi: deps.settingsApi,
    busApi: deps.busApi,
    log: (level, line) => {
      const prefix = "[HugoAura / Plugin:" + manifest.id + "]";
      (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(
        prefix,
        line
      );
    },
  });
  const instance = sandboxRun.instance;
  if (instance && typeof instance.onLoad === "function") {
    instance.onLoad(sandboxRun.ctx);
  }
  loadedMainPlugins.set(manifest.id, {
    manifest,
    pluginDir,
    instance,
    dispose: sandboxRun.dispose,
  });
  console.log(
    `[HugoAura / Plugins] Loaded main plugin: ${manifest.id} v${manifest.version} (sandbox: ${granted.join(", ") || "无权限"})`
  );
};

/**
 * 停用 main 插件: 尽力调 onUnload, 回收沙箱资源 (定时器等)。
 * @param {string} id
 */
const unloadMainPlugin = (id) => {
  const record = loadedMainPlugins.get(id);
  if (!record) return;
  try {
    if (record.instance && typeof record.instance.onUnload === "function") {
      record.instance.onUnload();
    }
  } catch (err) {
    console.error(`[HugoAura / Plugins] Plugin ${id} onUnload threw:`, err);
  }
  try {
    if (typeof record.dispose === "function") record.dispose();
  } catch (err) {
    console.error(`[HugoAura / Plugins] Plugin ${id} dispose threw:`, err);
  }
  loadedMainPlugins.delete(id);
  console.log(`[HugoAura / Plugins] Unloaded main plugin: ${id}`);
};

/**
 * 扫描已安装插件 (main + ui 全部返回, enabled 为实时开关状态)。
 * @returns {{manifest: any, pluginDir: string, enabled: boolean}[]}
 */
const scanInstalled = () => {
  const root = pluginsRoot();
  if (!root || !fs.existsSync(root)) return [];

  /** @type {{manifest: any, pluginDir: string, enabled: boolean}[]} */
  const result = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    console.error("[HugoAura / Plugins] Failed to list plugin dir:", err);
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(root, entry.name);
    try {
      const manifest = readManifest(pluginDir, entry.name);
      result.push({ manifest, pluginDir, enabled: isPluginEnabled(manifest.id) });
    } catch (err) {
      console.warn(
        `[HugoAura / Plugins] Skipping invalid plugin dir "${entry.name}":`,
        err && err.message
      );
    }
  }
  return result;
};

/**
 * 扫描并加载所有已启用的 main 插件 (管家启动时调用一次)。
 * @returns {{ installed: number, loaded: number }}
 */
const loadPlugins = () => {
  const installed = scanInstalled();
  let loaded = 0;
  for (const item of installed) {
    if (item.manifest.type !== "main" || !item.enabled) continue;
    try {
      if (!loadedMainPlugins.has(item.manifest.id)) {
        loadMainPlugin(item.pluginDir, item.manifest);
        loaded += 1;
      }
    } catch (err) {
      console.error(
        `[HugoAura / Plugins] Failed to load plugin ${item.manifest.id}:`,
        err
      );
    }
  }
  console.log(
    `[HugoAura / Plugins] Plugin scan finished: ${installed.length} installed, ${loaded} main plugin(s) loaded.`
  );
  return { installed: installed.length, loaded };
};

/**
 * 启用插件 (落盘配置由调用方写; 这里负责运行时加载)。
 * main 类型立即加载; ui 类型由渲染层在下次页面注入时加载。
 * @param {string} id
 */
const enablePlugin = (id) => {
  const root = pluginsRoot();
  if (!root) throw new Error("AURA_DIR_UNAVAILABLE");
  const pluginDir = path.join(root, id);
  const manifest = readManifest(pluginDir, id);
  if (manifest.type === "main" && !loadedMainPlugins.has(id)) {
    try {
      loadMainPlugin(pluginDir, manifest);
    } catch (err) {
      console.error(`[HugoAura / Plugins] Failed to enable plugin ${id}:`, err);
      throw err;
    }
  }
};

/**
 * 停用插件 (落盘配置由调用方写; 这里负责运行时卸载)。
 * @param {string} id
 */
const disablePlugin = (id) => {
  unloadMainPlugin(id);
};

const isMainPluginLoaded = (id) => loadedMainPlugins.has(id);

module.exports = {
  loadPlugins,
  scanInstalled,
  enablePlugin,
  disablePlugin,
  isMainPluginLoaded,
  validateManifest,
  readManifest,
  readPluginSettings,
  writePluginSettings,
  ID_PATTERN,
};
