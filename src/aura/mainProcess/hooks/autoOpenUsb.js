// @ts-check

/**
 * 自动打开 U 盘 (Auto Open USB) 主进程钩子
 *
 * 原理: 管家通过病毒服务 WS 连接 (模块 140) 接收 USB_LIST (messageType 1003)
 * 消息, data.diskList 为当前插入的 U 盘列表 (含 path 驱动器路径)。
 *
 * 本钩子包装模块 140 的 onMessage: 配置启用时, 对比前后快照,
 * 对新出现的驱动器调用 explorer.exe 打开资源管理器窗口。
 * 管家原有的提示窗口/查杀流程不受影响 (先执行原始 onMessage)。
 *
 * 版本容错: 自检失败时优雅降级, 仅打印诊断日志。
 */

const { spawn } = require("child_process");

const { withRetry, getPrototypeMethod, resolveModule } = require("./retryHook");

const USB_LIST_MESSAGE_TYPE = 1003; // USB_LIST

const hookFn = (central) => {
  let diagLogged = false;
  /** @type {Set<string>|null} 上一次 USB_LIST 快照, null 表示尚未收到消息 */
  let lastDiskPaths = null;

  const readConfig = () => {
    try {
      const mgr = global.__HUGO_AURA_CONFIG_MGR__;
      if (!mgr) return null;
      return mgr.loadConfig();
    } catch (err) {
      console.error(
        "[HugoAura / AutoOpenUsb / Error] Failed to read config:",
        err
      );
      return null;
    }
  };

  const shouldAutoOpen = () => {
    const config = readConfig();
    return Boolean(
      config &&
        config.networkRewrite &&
        config.networkRewrite["appearance/autoOpenUsb"] &&
        config.networkRewrite["appearance/autoOpenUsb"].enabled
    );
  };

  /** 用资源管理器打开驱动器 */
  const openInExplorer = (drivePath) => {
    try {
      const child = spawn("explorer.exe", [drivePath], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      console.log(
        `[HugoAura / AutoOpenUsb] Opened drive in Explorer: ${drivePath}`
      );
    } catch (err) {
      console.warn(
        `[HugoAura / AutoOpenUsb] Failed to open drive ${drivePath}:`,
        err
      );
    }
  };

  /**
   * 处理 USB_LIST 消息: 计算新插入的驱动器并打开
   * @param {any} parsed
   */
  const handleUsbList = (parsed) => {
    const diskList = (parsed.data && parsed.data.diskList) || [];
    const currentPaths = new Set(
      diskList
        .map((/** @type {any} */ d) => String(d && d.path || ""))
        .filter(Boolean)
    );

    // 首次消息仅建立快照, 避免启动时打开已插入的 U 盘
    if (lastDiskPaths === null) {
      lastDiskPaths = currentPaths;
      return;
    }

    for (const drivePath of currentPaths) {
      if (!lastDiskPaths.has(drivePath)) {
        openInExplorer(drivePath);
      }
    }
    lastDiskPaths = currentPaths;
  };

  // 单次安装尝试: 成功返回 true, 模块未就绪返回 false (触发重试)
  const tryInstall = () => {
    const handler = resolveModule(central, 140);

    // 运行时自检: 确认模块 140 是 USB 消息处理器 (版本容错)
    const unboundOnMessage = getPrototypeMethod(handler, "onMessage");
    const isUsbHandler =
      handler &&
      typeof handler.onMessage === "function" &&
      typeof unboundOnMessage === "function" &&
      String(unboundOnMessage).includes("USB_LIST");

    if (!isUsbHandler) {
      if (!diagLogged) {
        diagLogged = true;
        console.warn(
          `[HugoAura / AutoOpenUsb] Module 140 self-check failed. ` +
            `typeof(handler)=${typeof handler}, ` +
            `onMessage=${handler && typeof handler.onMessage}`
        );
      }
      console.debug(
        "[HugoAura / AutoOpenUsb] Module 140 not ready, retrying..."
      );
      return false;
    }

    const originalOnMessage = handler.onMessage.bind(handler);
    handler.onMessage = (e) => {
      // 先让管家完成原有处理 (提示窗口 / 查杀事件等)
      originalOnMessage(e);

      try {
        if (!shouldAutoOpen()) return;
        const parsed = typeof e === "string" ? JSON.parse(e) : e;
        if (parsed && parsed.messageType === USB_LIST_MESSAGE_TYPE) {
          handleUsbList(parsed);
        }
      } catch (err) {
        console.warn("[HugoAura / AutoOpenUsb] Failed to process message:", err);
      }
    };

    console.log(
      "[HugoAura / AutoOpenUsb] Source interception installed (module 140)."
    );
    return true;
  };

  // 懒加载容错: 模块未就绪时延迟重试
  withRetry(tryInstall, { label: "AutoOpenUsb" })();
};

module.exports = { hookFunc: hookFn };
