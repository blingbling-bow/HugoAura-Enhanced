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
 * 快速检测 (为什么有两条路径): 1003 由本地病毒服务周期性推送 (真机实测
 * 约 20 秒一份), 被动等待的话插入后要等 20 多秒才打开。因此本钩子在主进程
 * 用 kernel32.GetLogicalDrives 主动轮询盘符位图 —— 借用管家自带的 ffi 模块
 * (windowsApiFfi.dll 同源), 纯内存操作, 不像 fs.existsSync 那样可能在
 * 未就绪设备上阻塞主进程; 新出现的可移动驱动器 (GetDriveTypeA ==
 * DRIVE_REMOVABLE) 立即打开。1003 路径保留作兜底 (ffi 不可用时), 且会跳过
 * 观察器刚打开过的盘 —— 推送延迟 (~20s) 远大于跨进程去重的 5 秒窗口,
 * 不跳过的话同一个 U 盘会被打开两次。
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
const FFI_MODULE_ID = 42; // 管家 bundle 自带的 ffi 模块 (windowsApiFfi.dll 同源)

// 同一驱动器在该时间窗内只打开一次 (跨窗口/跨进程去重)
const OPEN_DEDUPE_MS = 5000;

// >>> 快速盘符检测器 <<<
const FAST_POLL_INTERVAL_MS = 1500;
const DRIVE_REMOVABLE = 2; // kernel32 GetDriveTypeA: DRIVE_REMOVABLE
// 观察器打开记录的有效期: 1003 慢推送 (~20s) 在此窗口内不再重复打开
const WATCHER_OPEN_TTL_MS = 60 * 1000;
// 新驱动器等待就绪的重试上限 (U 盘挂载需要零点几秒到几秒): 10 次 x 1.5s
const WATCHER_MAX_TRIES = 10;

// 模块级: 观察器只启动一次 (每个窗口进程都会加载本钩子)。同一进程内多次
// 窗口初始化会创建多个 hookFn 闭包, 打开记录放模块级才能全进程共享。
let fastWatcherStarted = false;
/** @type {Map<string, number>} 观察器已打开的驱动器 -> 时间戳 */
const watcherOpenedAt = new Map();
// shouldAutoOpen 的短缓存: 轮询每 1.5s 一次, 不必每次都读配置。
// null 表示尚未读取 (不能假定时钟起点是真实 epoch, 首次调用必须刷新)
let autoOpenCfgCache = null;

/**
 * 盘符位图 -> 驱动器根路径 (bit0=A ... bit25=Z)
 * @param {number} mask kernel32.GetLogicalDrives 返回值
 * @returns {string[]} 形如 ["C:\\", "D:\\"]
 */
const maskToDrives = (mask) => {
  const drives = [];
  const m = mask >>> 0;
  for (let i = 0; i < 26; i++) {
    if (m & (1 << i)) drives.push(`${String.fromCharCode(65 + i)}:\\`);
  }
  return drives;
};

const hookFn = (central, deps = {}) => {
  // 驱动器就绪探测可注入 (单测用); 生产走真实 fs。注意仅探测走它,
  // claimOpen 的锁文件始终用真实 fs。
  const driveFs = deps.driveFs || fs;
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

  // 轮询用的短缓存版开关判定 (5s 内不重复读配置)
  const shouldAutoOpenCached = (now) => {
    if (!autoOpenCfgCache || now - autoOpenCfgCache.at > 5000) {
      autoOpenCfgCache = { at: now, enabled: shouldAutoOpen() };
    }
    return autoOpenCfgCache.enabled;
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
   * ShellExecute 打开驱动器根目录 (打开动作本体, 前置校验由调用方完成)。
   *
   * @param {string} drivePath 规范化后的驱动器路径 ("E:\\")
   * @param {string} rawPath 原始路径 (仅用于日志)
   */
  const openDriveByShell = (drivePath, rawPath) => {
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
   * 打开驱动器 (1003 慢速兜底路径使用)。
   *
   * 打开前校验路径可用性: 服务端可能下发设备路径等无法直接打开的形态,
   * 若照直传给系统会得到"打开了别的东西"这类静默错误, 因此校验不过就
   * 只记日志并跳过。
   *
   * @param {any} rawPath 服务端下发的路径
   */
  const openInExplorer = (rawPath) => {
    const drivePath = normalizeDiskPath(rawPath);

    // 该功能只应打开本地 U 盘根目录。拒绝 UNC/网络共享路径，避免云端
    // 下发异常路径时触发 SMB 连接或访问外部网络位置。
    if (!/^[A-Za-z]:\\$/.test(drivePath)) {
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

    openDriveByShell(drivePath, rawPath);
  };

  /**
   * 观察器打开记录查询: 该盘是否刚被快速观察器打开过。
   * @param {string} drivePath 规范化后的驱动器路径
   * @param {number} now
   */
  const wasOpenedByWatcher = (drivePath, now) => {
    const at = watcherOpenedAt.get(drivePath);
    return typeof at === "number" && now - at < WATCHER_OPEN_TTL_MS;
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
    const now = Date.now();

    diskList.forEach((/** @type {any} */ disk) => {
      const drivePath = String((disk && disk.path) || "");
      if (drivePath && knownPaths.indexOf(drivePath) === -1) {
        // 快速观察器已打开过的盘: 1003 慢推送到达时不再重复打开
        if (wasOpenedByWatcher(normalizeDiskPath(drivePath), now)) {
          console.debug(
            `[HugoAura / AutoOpenUsb] ${drivePath} already opened by fast watcher, skip USB_LIST echo.`
          );
          return;
        }
        openInExplorer(drivePath);
      }
    });
  };

  /**
   * 观察器的打开尝试。新盘符出现时卷可能尚未就绪 (U 盘挂载需要零点几秒
   * 到几秒), existsSync 不过就返回 false 留给下个 tick 重试; 就绪后走与
   * 1003 路径同一套 claimOpen 去重 + ShellExecute 打开。
   *
   * @param {string} drivePath 驱动器根路径 ("E:\\")
   * @returns {boolean} true=已处理 (打开/去重跳过/路径非法) / false=未就绪需重试
   */
  const tryOpenDrive = (drivePath) => {
    // 该功能只应打开本地 U 盘根目录 (与 1003 路径同一校验)
    if (!/^[A-Za-z]:\\$/.test(drivePath)) return true;
    if (!driveFs.existsSync(drivePath)) return false;

    const claimed = claimOpen(drivePath);
    // 无论本窗口是否抢到打开权都登记时间: 本进程的 1003 兜底路径据此跳过
    watcherOpenedAt.set(drivePath, Date.now());

    if (claimed) {
      openDriveByShell(drivePath, drivePath);
    } else {
      console.debug(
        `[HugoAura / AutoOpenUsb] ${drivePath} already opened by another window, skip.`
      );
    }
    return true;
  };

  /**
   * 快速盘符检测器 (每个窗口进程启动一次)。
   * ffi/kernel32 不可用时直接返回, 保留 1003 被动路径作为兜底。
   */
  const startFastWatcher = () => {
    if (fastWatcherStarted) return;
    fastWatcherStarted = true;

    let getLogicalDrives = null;
    let getDriveType = null;
    try {
      const ffi = resolveModule(central, FFI_MODULE_ID);
      if (ffi && typeof ffi.Library === "function") {
        const lib = ffi.Library("kernel32", {
          GetLogicalDrives: ["uint32", []],
          GetDriveTypeA: ["uint32", ["string"]],
        });
        getLogicalDrives = lib.GetLogicalDrives;
        getDriveType = lib.GetDriveTypeA;
      }
    } catch (err) {
      console.warn(
        "[HugoAura / AutoOpenUsb] Failed to bind kernel32 via ffi:",
        err
      );
    }
    if (
      typeof getLogicalDrives !== "function" ||
      typeof getDriveType !== "function"
    ) {
      console.warn(
        "[HugoAura / AutoOpenUsb] Fast drive watcher unavailable, falling back to USB_LIST pushes only."
      );
      return;
    }

    console.log(
      `[HugoAura / AutoOpenUsb] Fast drive watcher started (poll ${FAST_POLL_INTERVAL_MS}ms).`
    );

    let primed = false;
    let knownMask = 0;
    let failures = 0;
    /** @type {Map<string, number>} 新发现待就绪的驱动器 -> 剩余重试次数 */
    const pendingOpens = new Map();

    const timer = setInterval(() => {
      try {
        if (!shouldAutoOpenCached(Date.now())) return;

        const mask = getLogicalDrives() >>> 0;
        if (!primed) {
          // 首帧只登记快照: 启动时已插着的 U 盘不自动打开 (与 1003 首帧保护同义)
          primed = true;
          knownMask = mask;
          return;
        }

        const newMask = mask & ~knownMask;
        knownMask = mask;

        for (const drivePath of maskToDrives(newMask)) {
          if (getDriveType(drivePath) === DRIVE_REMOVABLE) {
            pendingOpens.set(drivePath, WATCHER_MAX_TRIES);
          }
        }
        for (const [drivePath, tries] of pendingOpens) {
          if (tryOpenDrive(drivePath) || tries <= 1) {
            pendingOpens.delete(drivePath);
          } else {
            pendingOpens.set(drivePath, tries - 1);
          }
        }
      } catch (err) {
        failures += 1;
        if (failures >= 5) {
          console.error(
            "[HugoAura / AutoOpenUsb] Fast watcher stopped after repeated failures:",
            err
          );
          clearInterval(timer);
        } else {
          console.warn("[HugoAura / AutoOpenUsb] Fast watcher tick failed:", err);
        }
      }
    }, FAST_POLL_INTERVAL_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
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
      // 快速检测器与 1003 路径并行: 前者负责秒开, 后者兜底
      startFastWatcher();
    }
    return installed;
  };

  // 懒加载容错: 模块未就绪时延迟重试
  withRetry(tryInstall, { label: "AutoOpenUsb" })();
};

module.exports = {
  hookFunc: hookFn,
  maskToDrives,
  FAST_POLL_INTERVAL_MS,
  WATCHER_OPEN_TTL_MS,
  DRIVE_REMOVABLE,
};
