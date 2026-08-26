// @ts-check

/**
 * Expose the host application's existing userLock() action to Aura UI.
 * The module id is from the supported SeewoServiceAssistant build.
 *
 * @param {import("../../../types/main/electron").AuraIPCMain} ipcMain
 */
const applyScreenLockIpcHandler = (ipcMain) => {
  ipcMain.handle("$aura.screenLock.userLock", () => {
    try {
      const central = global.__HUGO_AURA__.central;
      const screenLockManager = central && central(26);
      if (!screenLockManager || typeof screenLockManager.userLock !== "function") {
        console.warn("[HugoAura] Native screen lock manager is unavailable");
        return { success: false, reason: "UNAVAILABLE" };
      }
      screenLockManager.userLock();
      return { success: true };
    } catch (error) {
      console.error("[HugoAura] Failed to start native screen lock", error);
      return { success: false, reason: "ERROR" };
    }
  });
};

module.exports = { applyScreenLockIpcHandler };
