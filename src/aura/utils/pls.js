// @ts-check

/**
 * @param {Electron} electron
 */
const createWsWindow = (electron) => {
  const path = require("path");
  const fs = require("fs");
  const aikariLauncher = path.join("C:\\Program Files", "HugoAura", "Aikari", "Aikari-Launcher.exe");
  if (!fs.existsSync(aikariLauncher)) return null;
  const { BrowserWindow } = electron;
  const window = new BrowserWindow({
    width: 0,
    height: 0,
    frame: false,
    skipTaskbar: true,
    transparent: true,
    // #00000000: 全透明黑。不设底色时 Windows 会把透明窗铺成白底。
    backgroundColor: "#00000000",
    alwaysOnTop: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      devTools: true,
    },
  });

  window.setIgnoreMouseEvents(true);
  window.minimize();
  window.loadFile(
    path.join(
      __dirname,
      "..",
      "ui",
      "pages",
      "windows",
      "auraWsKeepAlive",
      "index.html"
    )
  );

  return window;
};

module.exports = { createWsWindow };
