// @ts-check

/**
 * 自动打开 U 盘 (Auto Open USB) 主进程钩子
 *
 * 原理: 管家通过病毒服务 WS 连接 (模块 141, 继承 WS 基类模块 18) 接收
 * USB_LIST (messageType 1003) 消息, data.diskList 为当前插入的 U 盘列表
 * (含 path 驱动器路径)。
 *
 * 模块 141 自身维护 usbList 快照, 据此计算"新插入/已拔出"并调用模块 371
 * 弹出 usbInsertPrompt 提示窗口。本钩子复用同一份旧快照判定新插入的驱动器,
 * 在管家处理前打开资源管理器窗口, 且不消费消息 (管家原有的提示窗口/查杀
 * 流程不受影响)。
 *
 * 打开方式: 必须走 ShellExecute (electron.shell.openPath), 与管家原生
 * openExternal → windowsApiFfi.dll OpenItem 同源。不可使用 explorer.exe
 * 命令行: 实测 `explorer.exe C:/` (正斜杠) 与不存在的路径都会被静默改写为
 * 打开「文档」目录, 而服务端下发的 disk.path 恰是正斜杠形式 ("E:/", 渲染端
 * usbInsertPrompt 用 `path.split(":/")` 取盘符可证) —— 这曾导致插入 U 盘后
 * 弹出若干「文档」窗口而非 U 盘窗口。
 *
 * 拦截方式: 模块 141 是 WS 基类 (模块 18) 的派生实例, 基类 create() 会把
 * onMessage 解构固化进连接闭包, 事后包装实例属性可能被绕过, 因此统一使用
 * WS 蹦床 (installWsInterceptor)。
 *
 * 版本容错: 自检失败时优雅降级, 仅打印诊断日志。
 */

const fs = require("fs");
const path = require("path");

const {
  withRetry,
  getPrototypeMethod,
  resolveModule,
  installWsInterceptor,
} = require("./retryHook");

const USB_HANDLER_MODULE_ID = 141; // 病毒服务消息处理器 (USB_LIST)
const USB_LIST_MESSAGE_TYPE = 1003; // USB_LIST

// 同一驱动器在该时间窗内只打开一次 (跨窗口/跨进程去重)
const OPEN_DEDUPE_MS = 5000;

const hookFn = (central) => {
  let diagLogged = false;

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

  /**
   * 跨窗口/跨进程去重: 抢到锁才允许打开。
   *
   * 管家的每个窗口都是独立进程、各自持有一条病毒服务 WS 连接, 因此同一次
   * 插入会被每个窗口各拦一次 —— 不去重的话会弹出多个重复的资源管理器窗口
   * (曾观测到 2~5 个)。这里用原子创建 (wx) 的锁文件做跨进程仲裁, 时间窗内
   * 只有第一个窗口能打开。
   *
   * @param {string} drivePath 规范化后的驱动器路径
   * @returns {boolean} true=本窗口负责打开 / false=已有其他窗口打开过
   */
  const claimOpen = (drivePath) => {
    try {
      const auraDir = global.__HUGO_AURA__ && global.__HUGO_AURA__.auraDir;
      if (!auraDir) return true; // 拿不到运行目录时不做去重, 宁可多开也不错失

      const stateDir = path.join(auraDir, "state");
      fs.mkdirSync(stateDir, { recursive: true });
      const lockFile = path.join(
        stateDir,
        `usbOpen-${drivePath.replace(/[^A-Za-z0-9]/g, "")}.lock`
      );

      const now = Date.now();
      try {
        fs.writeFileSync(lockFile, String(now), { flag: "wx" });
        return true;
      } catch (err) {
        if (!err || err.code !== "EEXIST") return true;
        const last = Number(fs.readFileSync(lockFile, "utf8")) || 0;
        if (now - last < OPEN_DEDUPE_MS) return false;
        fs.writeFileSync(lockFile, String(now)); // 过期锁, 接管
        return true;
      }
    } catch (err) {
      console.warn("[HugoAura / AutoOpenUsb] Dedupe check failed:", err);
      return true;
    }
  };

  /**
   * 规范化服务端下发的盘符路径为 Windows 反斜杠形式。
   * 服务端下发 "E:/" 这类正斜杠形式, 统一转为 "E:\"。
   *
   * @param {any} rawPath 服务端下发的路径
   * @returns {string} 规范化后的路径 (无法识别时原样返回)
   */
  const normalizeDiskPath = (rawPath) => {
    const raw = String(rawPath || "").trim();
    const driveRoot = raw.match(/^([A-Za-z]):[\\/]*$/);
    if (driveRoot) return `${driveRoot[1].toUpperCase()}:\\`;
    return raw.replace(/\//g, "\\");
  };

  /**
   * 打开驱动器 (ShellExecute 通道)。
   *
   * 打开前校验路径可用性: 服务端可能下发设备路径等无法直接打开的形态,
   * 若照直传给系统会得到"打开了别的东西"这类静默错误, 因此校验不过就
   * 只记日志并跳过。
   *
   * @param {any} rawPath 服务端下发的路径
   */
  const openInExplorer = (rawPath) => {
    const drivePath = normalizeDiskPath(rawPath);

    if (!/^(?:[A-Za-z]:\\|\\\\[^\\])/.test(drivePath)) {
      console.warn(
        `[HugoAura / AutoOpenUsb] Skip non-absolute path: "${rawPath}"`
      );
      return;
    }

    if (!fs.existsSync(drivePath)) {
      console.warn(
        `[HugoAura / AutoOpenUsb] Drive not accessible, skip: "${drivePath}" (raw: "${rawPath}")`
      );
      return;
    }

    if (!claimOpen(drivePath)) {
      console.debug(
        `[HugoAura / AutoOpenUsb] ${drivePath} already opened by another window, skip.`
      );
      return;
    }

    try {
      const { shell } = central(1);
      Promise.resolve(shell.openPath(drivePath)).then(
        (errMsg) => {
          if (errMsg) {
            console.warn(
              `[HugoAura / AutoOpenUsb] Failed to open "${drivePath}": ${errMsg}`
            );
          } else {
            console.log(
              `[HugoAura / AutoOpenUsb] Opened drive in Explorer: ${drivePath} (raw: "${rawPath}")`
            );
          }
        },
        (err) => {
          console.warn(
            `[HugoAura / AutoOpenUsb] Failed to open "${drivePath}":`,
            err
          );
        }
      );
    } catch (err) {
      console.warn(
        `[HugoAura / AutoOpenUsb] Failed to open drive ${drivePath}:`,
        err
      );
    }
  };

  /**
   * 与管家同源的新盘判定: 拦截器在原始 onMessage 之前执行,
   * 此时 handler.usbList 仍为上一条消息的快照, 可据此找出新插入的驱动器。
   *
   * 首帧保护: 服务器在连接建立/重连后必先推一份全量 diskList, 而此刻
   * handler.usbList 还是构造器里的初值 [] —— 若直接做 diff, 全量列表里
   * 每一项都会被误判为"新插入", 导致开机/重连时弹出一串资源管理器窗口。
   * 因此第一帧只登记快照不打开 (标记 __auraUsbPrimed); 真实插入必然发生在
   * 之后的帧里, 那次 diff 用的就是真实上一帧快照, 不会漏。
   * 注意这里不能用"快照长度为 0"来判断首帧: 设备上没插 U 盘时, 首帧全量
   * 本身就是空列表, 之后的真实插入同样以空列表为上一帧。
   *
   * @param {any} handler 病毒服务消息处理器实例 (模块 141)
   * @param {any} parsed 已解析的 USB_LIST 消息
   */
  const openNewDisks = (handler, parsed) => {
    if (!handler.__auraUsbPrimed) {
      handler.__auraUsbPrimed = true;
      console.log(
        "[HugoAura / AutoOpenUsb] First full disk list received, snapshot only (no window opened)."
      );
      return;
    }

    const diskList = (parsed.data && parsed.data.diskList) || [];
    const knownPaths = Array.isArray(handler.usbList)
      ? handler.usbList.map((/** @type {any} */ d) =>
          String((d && d.path) || "")
        )
      : [];

    diskList.forEach((/** @type {any} */ disk) => {
      const drivePath = String((disk && disk.path) || "");
      if (drivePath && knownPaths.indexOf(drivePath) === -1) {
        openInExplorer(drivePath);
      }
    });
  };

  // 单次安装尝试: 成功返回 true, 模块未就绪返回 false (触发重试)
  const tryInstall = () => {
    const handler = resolveModule(central, USB_HANDLER_MODULE_ID);

    // 运行时自检: 确认模块 141 是病毒服务消息处理器 (版本容错)
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
          `[HugoAura / AutoOpenUsb] Module ${USB_HANDLER_MODULE_ID} self-check failed. ` +
            `typeof(handler)=${typeof handler}, ` +
            `onMessage=${handler && typeof handler.onMessage}`
        );
      }
      console.debug(
        `[HugoAura / AutoOpenUsb] Module ${USB_HANDLER_MODULE_ID} not ready, retrying...`
      );
      return false;
    }

    // 不消费消息 (返回 undefined), 仅旁路打开资源管理器
    const installed = installWsInterceptor(
      central,
      USB_HANDLER_MODULE_ID,
      "AutoOpenUsb",
      (parsed) => {
        try {
          if (!shouldAutoOpen()) return;
          if (parsed && parsed.messageType === USB_LIST_MESSAGE_TYPE) {
            openNewDisks(handler, parsed);
          }
        } catch (err) {
          console.warn(
            "[HugoAura / AutoOpenUsb] Failed to process message:",
            err
          );
        }
      }
    );

    if (installed) {
      console.log(
        `[HugoAura / AutoOpenUsb] Interceptor installed (module ${USB_HANDLER_MODULE_ID}).`
      );
    }
    return installed;
  };

  // 懒加载容错: 模块未就绪时延迟重试
  withRetry(tryInstall, { label: "AutoOpenUsb" })();
};

module.exports = { hookFunc: hookFn };
