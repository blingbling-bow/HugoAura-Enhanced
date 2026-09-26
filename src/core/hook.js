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
  /**
   * Aikari 更新源。
   * 原有 API 域名自 2026-09 起已全部失效, 且暂无新的可用地址, 故暂时清空:
   * 版本查询会立即返回"更新服务不可用", 不再逐个域名等待连接超时。
   * 服务恢复后, 把可用域名填回 domains 即可复原更新能力。
   *
   * 原域名留档 (均已失效):
   *   https://api-aura-projekts.delta.ooo
   *   https://api-aura.asaka.site
   *   https://api.hugoaura.dpdns.org
   *   https://api-aura-projekts.minorice.moe
   *   https://api.aura.vim.moe
   */
  /** @type {import("../aura/types/shared/global").GlobalHugoAuraApiInfo} */
  const __HUGO_AURA_API__ = {
    domains: [],
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
    // 逐个隔离安装: 任一钩子(含模块加载)抛错都只跳过它自己,
    // 不能连带中断后面的钩子 (否则会出现"某个功能静默失效"且无迹可循)。
    const installHook = (name, modulePath) => {
      try {
        require(modulePath).hookFunc(central);
      } catch (err) {
        console.error(`[HugoAura / Hooks] Failed to install ${name} hook:`, err);
      }
    };

    installHook("DisableScreensaver", "../aura/mainProcess/hooks/disableScreensaver");
    installHook("DisableUpdate", "../aura/mainProcess/hooks/disableUpdate");
    installHook("CloudUpdateInterceptor", "../aura/mainProcess/hooks/cloudUpdateInterceptor");
    installHook("ScreenPeekDetector", "../aura/mainProcess/hooks/screenPeekDetector");
    installHook("PowerOffInterceptor", "../aura/mainProcess/hooks/powerOffInterceptor");
    installHook("LockScreenInterceptor", "../aura/mainProcess/hooks/lockScreenInterceptor");
    installHook("DisableBuglyReport", "../aura/mainProcess/hooks/disableBuglyReport");
    installHook("BlockTelemetryUpload", "../aura/mainProcess/hooks/blockTelemetryUpload");
    installHook("HideCountdown", "../aura/mainProcess/hooks/hideCountdown");
    installHook("DeviceLinkNotify", "../aura/mainProcess/hooks/deviceLinkNotify");
    installHook("AutoOpenUsb", "../aura/mainProcess/hooks/autoOpenUsb");
    installHook("KeepPasswordUnlock", "../aura/mainProcess/hooks/keepPasswordUnlock");
    installHook("UnlockAudit", "../aura/mainProcess/hooks/unlockAudit");

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
  // 导致其自身的 DevTools 快捷键永远不会注册; 由 Aura 自行注册快捷键兜底。
  // 注意: globalShortcut.register 在注册失败 (被其它程序占用) 时只返回 false
  // 而不抛异常, 因此必须用 isRegistered 逐个复核, 否则会误判为注册成功。
  if (loadedConfig.devTools && !global.__HUGO_AURA__.devToolsShortcutRegistered) {
    const devToolsShortcuts = [
      "CommandOrControl+Shift+I",
      "CommandOrControl+Shift+C",
      "F12",
    ];
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

      const okShortcuts = [];
      const failedShortcuts = [];
      for (const accelerator of devToolsShortcuts) {
        try {
          globalShortcut.register(accelerator, openAllDevTools);
        } catch (err) {
          console.warn(`[HugoAura / Hook] DevTools shortcut ${accelerator} threw:`, err);
        }
        if (globalShortcut.isRegistered(accelerator)) {
          okShortcuts.push(accelerator);
        } else {
          failedShortcuts.push(accelerator);
        }
      }

      // 只要有一个键注上就算安装完成, 避免每次配置刷新都重复尝试
      global.__HUGO_AURA__.devToolsShortcutRegistered = okShortcuts.length > 0;
      if (okShortcuts.length > 0) {
        console.log(`[HugoAura / Hook] DevTools shortcuts registered: ${okShortcuts.join(" / ")}`);
      }
      if (failedShortcuts.length > 0) {
        console.warn(
          `[HugoAura / Hook] DevTools shortcuts NOT registered (占用或冲突): ${failedShortcuts.join(" / ")}`
        );
      }
      if (okShortcuts.length === 0) {
        console.error("[HugoAura / Hook] No DevTools shortcut available, please use Chrome remote debugging.");
      }
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
