// @ts-check

// 让管家自身日志保持明文 (官方预留开关, 写日志时实时检查, 注入后生效)
process.env.DISABLE_LOG_ENCRYPTION = "1";

if (!global.__HUGO_AURA__) {
  const __HUGO_AURA__ = {
    hookedWindows: new Map(),
    configInit: false,
    central: () => {},
    ipcInit: false,
    auraDir: "",
    plsStats: null,
    plsSettings: null,
    plsRules: null,
    uiHooks: new Map(),
    windowHooks: new Map(),
    version: require("./preload").__AURA_VERSION__,
  };
  global.__HUGO_AURA__ = __HUGO_AURA__;
}

if (!global.__HUGO_AURA_API__) {
  /** @type {import("../aura/types/shared/global").GlobalHugoAuraApiInfo} */
  const __HUGO_AURA_API__ = {
    domains: [
      "https://api-aura-projekts.delta.ooo",
      "https://api-aura.asaka.site",
      "https://api.hugoaura.dpdns.org",
      "https://api-aura-projekts.minorice.moe",
      "https://api.aura.vim.moe",
    ],
    aikariUpdate: "/api/getAikariLatestVersion",
    auraUpdate: "/api/getAuraLatestVersion",
  };
  global.__HUGO_AURA_API__ = __HUGO_AURA_API__;
}

if (!global.__HUGO_AURA_CONFIG__) {
  global.__HUGO_AURA_CONFIG__ = {};
}

const path = require("path");
const os = require("os");

const MainProcessHooksManager = require("../aura/init/main/windowHooksManager");
const RendererHooksManager = require("../aura/init/rendererHook/uiHooksManager");
const EventBus = require("../aura/utils/eventBus");
const NetworkHook = require("../aura/init/rendererHook/networkHook");
const ConfigManager = require("../aura/init/shared/configManager");
const RegistryManager = require("../aura/init/shared/registryManager");
const { buildIpcMain } = require("../aura/init/main/ipcHandler");
const plsUtils = require("../aura/utils/pls");
const stringUtils = require("../aura/utils/string");

const { initLogger } = require("../aura/init/main/logger");

const getUserDocumentsDirPath = () => {
  const registryManager = new RegistryManager();
  const pathInfo = registryManager.readRegKeySync(
    '"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders"',
    "Personal",
    false,
    true,
    /REG_EXPAND_SZ\s+(.+)/
  );
  try {
    if (pathInfo.success && pathInfo.data) {
      const resolvedPath = pathInfo.data.replace(
        /%([^%]+)%/g,
        (match, varName) => {
          return process.env[varName] || match;
        }
      );

      if (stringUtils.checkIfNonAscii(resolvedPath)) {
        console.warn("[HugoAura / Init] Detected non-ASCII char in resolved user personal folder: ", resolvedPath);
        throw new Error("Non-ASCII char detected");
      }
      return resolvedPath;
    } else {
      throw new Error("Registry data failed to get");
    }
  } catch (err) {
    console.error(
      "[HugoAura / Init / Logger] Failed to get the path of documents dir, using default val. | Error: ", err
    );
    return path.join(os.homedir(), "Documents");
  }
};

/**
 *
 * @param {import("../aura/types/main/core").LauncherArgs} param0
 * @returns
 */
const launcher = ({ central, windowName, config }) => {
  // >>> Init STD <<< //
  process.stdout.isTTY = true;
  process.stderr.isTTY = true;

  // >>> Basic Config <<< //
  /** @type {Electron} */
  const electron = central(1);
  const app = electron.app;
  if (!global.__HUGO_AURA__.central) global.__HUGO_AURA__.central = central;

  global.reloadApp = () => {
    app.relaunch({ args: process.argv.slice(1).concat(["--inspect 5858"]) });
    app.exit(0);
  };

  global.__HUGO_AURA__.auraDir = path.join(
    getUserDocumentsDirPath(),
    "HugoAura"
  );

  // >>> Init Logger <<< //
  initLogger(windowName);

  console.log("[HugoAura / Loaded] Aura is loaded!");
  console.debug(`[HugoAura / Debug] curWindowName: ${windowName}`);

  // >>> Init EventBus <<< //
  if (!global.__HUGO_AURA_EVENT_BUS__)
    global.__HUGO_AURA_EVENT_BUS__ = new EventBus();

  // >>> Init Config <<< //
  const configManager = new ConfigManager();
  configManager.side = "main";
  configManager.migrateOldConfigFile();
  configManager.ensureConfigExists();
  const loadedConfig = configManager.loadConfig();
  if (!global.__HUGO_AURA__.configInit) global.__HUGO_AURA__.configInit = true;
  if (!global.__HUGO_AURA_CONFIG_MGR__)
    global.__HUGO_AURA_CONFIG_MGR__ = configManager;

  global.__HUGO_AURA_CONFIG__ = loadedConfig;

  global.__HUGO_AURA_EVENT_BUS__.on("$aura.config.refreshConfig", () => {
    global.__HUGO_AURA_CONFIG__ = configManager.loadConfig();
  });

  // >>> Init IPC Main <<< //
  if (!global.__HUGO_AURA__.ipcInit) {
    buildIpcMain(electron);
    global.__HUGO_AURA__.ipcInit = true;
  }

  // >>> Init Aura Hooks (guarded: 仅安装一次, 防止多窗口重入) <<< //
  if (!global.__HUGO_AURA__.auraHooksInstalled) {
    const disableScreensaverHook = require("../aura/mainProcess/hooks/disableScreensaver");
    disableScreensaverHook.hookFunc(central);

    const disableUpdateHook = require("../aura/mainProcess/hooks/disableUpdate");
    disableUpdateHook.hookFunc(central);

    const cloudUpdateInterceptor = require("../aura/mainProcess/hooks/cloudUpdateInterceptor");
    cloudUpdateInterceptor.hookFunc(central);

    const screenPeekDetector = require("../aura/mainProcess/hooks/screenPeekDetector");
    screenPeekDetector.hookFunc(central);

    const powerOffInterceptor = require("../aura/mainProcess/hooks/powerOffInterceptor");
    powerOffInterceptor.hookFunc(central);

    const disableBuglyReport = require("../aura/mainProcess/hooks/disableBuglyReport");
    disableBuglyReport.hookFunc(central);

    global.__HUGO_AURA__.auraHooksInstalled = true;
  }

  // >>> Init Main Process Hooks <<< //
  const mainProcessHooksManager = new MainProcessHooksManager();

  const _windowHooks = mainProcessHooksManager.loadHooks();

  // >>> Init Renderer Process Hooks <<< //
  const uiHooksManager = new RendererHooksManager();

  const uiHooks = uiHooksManager.loadHooks();

  // >>> Activate DevTools <<< //
  if (loadedConfig.devTools && !config.canOpenDevTool) {
    config.canOpenDevTool = true;
  }

  // 管家 4010+ 的快捷键模块在加载时就固化了 canOpenDevTool=false,
  // 导致其 Ctrl+Shift+C 永远不会注册; 由 Aura 自行注册快捷键兜底
  if (loadedConfig.devTools && !global.__HUGO_AURA__.devToolsShortcutRegistered) {
    try {
      const { globalShortcut } = electron;
      const openAllDevTools = () => {
        for (const win of electron.BrowserWindow.getAllWindows()) {
          try {
            win.webContents.openDevTools({ mode: "detach" });
          } catch (err) {
            console.warn("[HugoAura / Hook] Failed to open devtools for window:", err);
          }
        }
      };
      globalShortcut.register("CommandOrControl+Shift+C", openAllDevTools);
      globalShortcut.register("F12", openAllDevTools);
      global.__HUGO_AURA__.devToolsShortcutRegistered = true;
      console.log("[HugoAura / Hook] DevTools shortcuts registered (Ctrl+Shift+C / F12)");
    } catch (err) {
      console.error("[HugoAura / Hook] Failed to register devtools shortcuts:", err);
    }
  }

  // >>> Create WebSocket KeepAlive Window <<< //
  if (!global.__HUGO_AURA__.hookedWindows?.has("auraWsKeepAlive")) {
    const wsKaWin = plsUtils.createWsWindow(electron);
    if (wsKaWin) {
      // @ts-expect-error
      global.__HUGO_AURA__.hookedWindows.set("auraWsKeepAlive", wsKaWin);
    }
  }

  // >>> Listeners <<< //

  /**
   *
   * @param {any} _event
   * @param {import("electron").BrowserWindow} browserWindow
   */
  const browserWindowCreatedListener = (_event, browserWindow) => {
    mainProcessHooksManager.initHookForWindow(
      windowName,
      central,
      app,
      browserWindow
    );
  };

  /**
   *
   * @param {any} _event
   * @param {import("electron").WebContents} webContents
   */
  const webContentsCreatedListener = (_event, webContents) => {
    const hookConfig = uiHooks.get(windowName.split("_")[0]);

    const initNetworkHook = () => {
      const networkHook = new NetworkHook();
      networkHook.installHook(webContents.session, loadedConfig);

      console.debug(
        `[HugoAura / Init / Done / NetworkHook] Network Hook for ${windowName} installed.`
      );
    };

    initNetworkHook();

    if (hookConfig) {
      uiHooksManager.handleWindowHook(webContents, hookConfig, windowName);
    } else {
      console.log(
        `[HugoAura / Init / RDH] Window ${windowName} has no corresponding ui hooks, ignoring...`
      );
    }
  };

  app.once("browser-window-created", browserWindowCreatedListener);
  app.once("web-contents-created", webContentsCreatedListener);

  return () => {
    app.removeListener("browser-window-created", browserWindowCreatedListener);
    app.removeListener("web-contents-created", webContentsCreatedListener);
  };
};

module.exports = launcher;
