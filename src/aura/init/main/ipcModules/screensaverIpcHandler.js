// @ts-check

/**
 * 自定义屏保图片 IPC ($aura.screensaver, Issue #15)。
 * apply: 用 <auraDir>\screensaver\ 里的自备图替换 SeewoAbility 屏保图;
 * restore: 还原首次替换前备份的原图。
 */

const applyScreensaverIpcHandler = (ipcMain) => {
  const methodBase = "$aura.screensaver";
  const {
    applyCustomScreenSaver,
    restoreScreenSaver,
  } = require("../../mainProcess/hooks/customScreenSaver");

  ipcMain.handle(`${methodBase}.apply`, async (_event, _arg) => {
    try {
      const result = applyCustomScreenSaver();
      return { success: true, data: result };
    } catch (err) {
      return {
        success: false,
        error: String(err && err.message ? err.message : err),
      };
    }
  });

  ipcMain.handle(`${methodBase}.restore`, async (_event, _arg) => {
    try {
      const result = restoreScreenSaver();
      return { success: true, data: result };
    } catch (err) {
      return {
        success: false,
        error: String(err && err.message ? err.message : err),
      };
    }
  });
};

module.exports = { applyScreensaverIpcHandler };
