// @ts-check

/**
 * 禁止管家崩溃上报 (Disable Bugly Crash Report) 主进程钩子
 *
 * 原理: 管家启动时调用 Electron crashReporter.start({
 *   submitURL: "https://sunday.cvte.com/bugly/api/v1/electron/<appId>",
 *   uploadToServer: true,
 * }), 进程崩溃时转储会被上传至希沃服务端。
 *
 * 为什么必须关死: 运行时进程内还跑着注入代码, 崩溃转储里会带注入痕迹。
 * 修改版把这类样本传到原厂, 只会让原厂把问题归因到原版管家身上。
 *
 * 拦截方式 (两层, 不依赖时序):
 *   1. 包裹 crashReporter.start: 无论调用方传什么, uploadToServer 一律强制 false。
 *      只要钩子在 start 之前装上, 后续任何启动都开不了上传。
 *   2. 包裹 crashReporter.setUploadToServer: 任何开启上传的尝试都被改写成 false。
 *   3. 钩子装上时若 start 已经调用过 (getUploadToServer() 为 true), 立刻关掉。
 *
 * 开关: 「禁用 Bugly 崩溃上报」(networkRewrite.disableBuglyReport.enabled, 默认开启)。
 * 该开关在设置页标注为需重启生效, 故只在安装时判定一次; 关掉开关即完全放行。
 */

const readConfig = () => {
  try {
    const mgr = global.__HUGO_AURA_CONFIG_MGR__;
    if (!mgr) return null;
    return mgr.loadConfig();
  } catch (err) {
    console.error("[HugoAura / DisableBugly / Error] Failed to read config:", err);
    return null;
  }
};

const shouldDisable = () => {
  const config = readConfig();
  return Boolean(
    config &&
      config.networkRewrite &&
      config.networkRewrite.disableBuglyReport &&
      config.networkRewrite.disableBuglyReport.enabled
  );
};

const hookFn = (central) => {
  // 开关在设置页标注为需重启生效, 因此安装时判定一次即可
  if (!shouldDisable()) {
    console.log("[HugoAura / DisableBugly] Disabled by config switch, hook skipped.");
    return;
  }

  let crashReporter;
  try {
    const electron = central(1);
    crashReporter = electron && electron.crashReporter;
  } catch (err) {
    console.error("[HugoAura / DisableBugly] Failed to access electron.crashReporter:", err);
    return;
  }

  if (
    !crashReporter ||
    typeof crashReporter.start !== "function" ||
    typeof crashReporter.setUploadToServer !== "function"
  ) {
    console.warn("[HugoAura / DisableBugly] crashReporter API unavailable, hook skipped.");
    return;
  }

  // 幂等: 同一进程内可能被多次安装
  if (crashReporter.__auraUploadGuardInstalled) return;

  const originalStart = crashReporter.start.bind(crashReporter);
  const originalSetUploadToServer = crashReporter.setUploadToServer.bind(crashReporter);

  crashReporter.start = (options) => {
    const normalized = Object.assign({}, options, { uploadToServer: false });
    if (options && options.uploadToServer) {
      console.log("[HugoAura / DisableBugly] Forced uploadToServer=true -> false on crashReporter.start.");
    }
    return originalStart(normalized);
  };

  crashReporter.setUploadToServer = (enable) => {
    if (enable) {
      console.log("[HugoAura / DisableBugly] Blocked an attempt to enable crash upload.");
    }
    return originalSetUploadToServer(false);
  };

  crashReporter.__auraUploadGuardInstalled = true;

  // 兜底: 钩子安装前 start 已执行过, 此时上传是开着的, 直接关掉
  let uploading = false;
  try {
    if (typeof crashReporter.getUploadToServer === "function") {
      uploading = crashReporter.getUploadToServer();
    }
  } catch (err) {
    console.warn("[HugoAura / DisableBugly] getUploadToServer() failed:", err);
  }

  if (uploading === true) {
    try {
      originalSetUploadToServer(false);
      console.log("[HugoAura / DisableBugly] Crash upload was already on, disabled it.");
    } catch (err) {
      console.error("[HugoAura / DisableBugly] Failed to disable crash upload:", err);
    }
  }

  console.log("[HugoAura / DisableBugly] Crash report upload guard installed (uploadToServer forced to false).");
};

module.exports = { hookFunc: hookFn };
