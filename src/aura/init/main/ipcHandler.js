// @ts-check

const __SCOPE = "main";

const PENDING_MESSAGE_LIMIT = 100;

const flushPendingMessages = (windowKey) => {
  const pending = global.__HUGO_AURA__.pendingIpcMessages?.get(windowKey);
  if (!pending || pending.length === 0) return;

  const webContents = global.__HUGO_AURA__.hookedWindows
    ?.get(windowKey)
    ?.webContents;
  if (!webContents) return;

  global.__HUGO_AURA__.pendingIpcMessages.delete(windowKey);
  pending.forEach(({ channel, data }) => {
    if (!webContents.isDestroyed()) webContents.send(channel, data);
  });
};

/**
 *
 * @param {import("electron")} electron
 */
const buildIpcMain = (electron) => {
  const { app } = electron;
  /**
   * @type {import("../../types/main/electron").AuraIPCMain}
   */
  // @ts-expect-error
  const ipcMain = electron.ipcMain;

  if (!global.__HUGO_AURA__.pendingIpcMessages) {
    global.__HUGO_AURA__.pendingIpcMessages = new Map();
  }

  /**
   *
   * @param {string} windowKey
   * @param {string} channel
   * @param {any} data
   * @param {import("electron").WebContents?} grep
   */
  ipcMain.send = (windowKey, channel, data, grep = null) => {
    /**
     *
     * @param {string} key
     * @param {string} chan
     * @param {any} targetData
     */
    if (!global.__HUGO_AURA__.hookedWindows) {
      return {
        success: false,
      };
    }

    const sendDataToWebContents = (key, chan, targetData) => {
      const webContents =
        // @ts-expect-error
        global.__HUGO_AURA__.hookedWindows.get(key)?.webContents;

      if (!webContents) {
        console.error(
          `[HugoAura / Main / IPC / ERROR] Failed sending data to ${key}: WebContents not found`
        );
        return {
          success: false,
        };
      }

      if (grep !== webContents) {
        webContents.send(chan, targetData);
      }

      return {
        success: true,
      };
    };

    if (windowKey === "*") {
      for (const perWindow of global.__HUGO_AURA__.hookedWindows.keys()) {
        sendDataToWebContents(perWindow, channel, data);
      }
    } else {
      const isWindowValid = global.__HUGO_AURA__.hookedWindows.has(windowKey);
      if (!isWindowValid) {
        const pending =
          global.__HUGO_AURA__.pendingIpcMessages.get(windowKey) || [];
        if (pending.length >= PENDING_MESSAGE_LIMIT) pending.shift();
        pending.push({ channel, data });
        global.__HUGO_AURA__.pendingIpcMessages.set(windowKey, pending);
        return {
          success: true,
          queued: true,
        };
      }

      sendDataToWebContents(windowKey, channel, data);
    }
  };

  global.__HUGO_AURA__.flushPendingIpcMessages = flushPendingMessages;

  const { applyBaseIpcHandler } = require("./ipcModules/baseIpcHandler");
  const { applyDebugIpcHandler } = require("./ipcModules/debugIpcHandler");
  const { applyConfigIpcHandler } = require("./ipcModules/configIpcHandler");
  const { applyFsIpcHandler } = require("./ipcModules/fsIpcHandler");
  const { applyAikariIpcHandler } = require("./ipcModules/aikariIpcHandler");
  const { applyAuditIpcHandler } = require("./ipcModules/auditIpcHandler");
  const { applyAuraUpdateIpcHandler } = require("./ipcModules/auraUpdateIpcHandler");

  ipcMain.handle("$aura.base.restartApplication", async () => {
    app.relaunch();
    app.exit(0);
  });

  applyBaseIpcHandler(ipcMain);
  applyDebugIpcHandler(ipcMain);
  applyConfigIpcHandler(ipcMain);
  applyFsIpcHandler(ipcMain);
  applyAikariIpcHandler(ipcMain);
  applyAuditIpcHandler(ipcMain);
  applyAuraUpdateIpcHandler(ipcMain);
};

module.exports = { buildIpcMain };
