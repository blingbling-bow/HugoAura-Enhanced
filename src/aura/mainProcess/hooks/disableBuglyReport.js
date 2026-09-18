// @ts-check

/**
 * 禁用 Bugly 崩溃上报 (Disable Bugly Crash Report) 主进程钩子
 *
 * 原理: 管家启动时调用 Electron crashReporter.start({
 *   submitURL: "https://sunday.cvte.com/bugly/api/v1/electron/<appId>",
 *   uploadToServer: true,
 * }), 进程崩溃时转储会自动上传至希沃服务端。
 * 注入侧崩溃同样会触发该上报, 存在暴露注入痕迹的风险。
 *
 * 本钩子在其之后调用 crashReporter.setUploadToServer(false) 关闭上传。
 * 时序容错: crashReporter.start 必须在 app ready 前执行, 若尚未执行
 * (getUploadToServer() 返回 false), 则延迟重试直至生效。
 */

const { withRetry } = require("./retryHook");

const hookFn = (central) => {
  const readConfig = () => {
    try {
      const mgr = global.__HUGO_AURA_CONFIG_MGR__;
      if (!mgr) return null;
      return mgr.loadConfig();
    } catch (err) {
      console.error(
        "[HugoAura / DisableBugly / Error] Failed to read config:",
        err
      );
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

  let attempts = 0;
  const tryDisable = () => {
    attempts += 1;

    if (!shouldDisable()) {
      // 配置关闭, 无需处理, 视为完成
      return true;
    }

    let crashReporter;
    try {
      const electron = central(1);
      crashReporter = electron && electron.crashReporter;
    } catch (err) {
      console.warn(
        "[HugoAura / DisableBugly] Failed to access electron.crashReporter:",
        err
      );
      return false;
    }

    if (
      !crashReporter ||
      typeof crashReporter.getUploadToServer !== "function" ||
      typeof crashReporter.setUploadToServer !== "function"
    ) {
      console.warn(
        "[HugoAura / DisableBugly] crashReporter API unavailable, retrying..."
      );
      return false;
    }

    let uploading = false;
    try {
      uploading = crashReporter.getUploadToServer();
    } catch (err) {
      console.warn(
        "[HugoAura / DisableBugly] getUploadToServer() failed, retrying...",
        err
      );
      return false;
    }

    if (!uploading) {
      // 管家尚未调用 crashReporter.start, 等待其完成后再关闭
      console.debug(
        "[HugoAura / DisableBugly] crashReporter not started yet, retrying..."
      );
      return false;
    }

    try {
      crashReporter.setUploadToServer(false);
      console.log(
        `[HugoAura / DisableBugly] Crash report upload disabled (attempts=${attempts}).`
      );
      return true;
    } catch (err) {
      console.warn(
        "[HugoAura / DisableBugly] setUploadToServer(false) failed, retrying...",
        err
      );
      return false;
    }
  };

  // 懒加载容错: crashReporter.start 未执行时延迟重试
  withRetry(tryDisable, { label: "DisableBugly" })();
};

module.exports = { hookFunc: hookFn };
