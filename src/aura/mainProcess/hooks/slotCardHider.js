// @ts-check

/**
 * 悬浮卡片"隐藏即释放槽位"通用工具 (Slot Card Hider)
 *
 * 背景: 屏幕右下角的悬浮卡片由原生槽位管理器 (模块 19) 从**下往上**统一排版
 * (yIndex 越小越靠下), 卡片窗口的 config 会在 beforeCreate 与 onFinished 中
 * 调用 enterSlot() 入槽, 只有 outSlot() / hideSlot() 才会把槽位让出来。
 *
 * 因此凡是"只把窗口藏起来"的隐藏方式 (browserWindow.hide() 或页面里 display:none)
 * 都会继续占着槽位 —— 上方卡片不下移, 屏底就空出一大片。原生自己的做法都是成对的:
 *   隐藏 -> hide() + hideSlot(name)   (如折叠桌面助手)
 *   还原 -> show() + showSlot(name)
 *
 * 本工具把"隐藏卡片"封装成一对可控操作:
 *   - 开关启用: hide() + hideSlot(窗口名), 上方卡片下移填补空白;
 *     并补丁 show/showInactive —— 原生 onFinished / restore 会重新 enterSlot 再 show,
 *     所以每次被拦下都要再释放一次槽位, 保证不会重新占位;
 *   - 开关关闭: showSlot(窗口名) + 原生 show(), 显示与布局一起恢复。
 *
 * 用法 (窗口级钩子):
 *   const { createSlotCardHider, readConfigPath } = require("./slotCardHider");
 *   createSlotCardHider({
 *     central, browserWindow, windowName: "xxx", label: "HideXxx",
 *     isEnabled: () =>
 *       Boolean(readConfigPath("networkRewrite.appearance/hideXxx.enabled")),
 *   });
 */

const { resolveModule } = require("./retryHook");

/**
 * 读取当前配置中某个点号分隔的路径。配置每次都从磁盘重读, 保证开关改动即时生效。
 *
 * @param {string} configPath 形如 "networkRewrite.appearance/hideFastToolbar.enabled"
 * @returns {any} 读取失败或路径不存在时返回 undefined
 */
const readConfigPath = (configPath) => {
  try {
    const mgr = global.__HUGO_AURA_CONFIG_MGR__;
    if (!mgr) return undefined;
    const config = mgr.loadConfig();
    return configPath
      .split(".")
      .reduce((acc, key) => (acc == null ? undefined : acc[key]), config);
  } catch (err) {
    console.error(
      `[HugoAura / SlotCardHider] Failed to read config path "${configPath}":`,
      err
    );
    return undefined;
  }
};

/**
 * 为一个槽位卡片窗口安装"隐藏 + 释放槽位"逻辑。
 *
 * @param {Object} options
 * @param {(id: number) => any} options.central 模块加载器
 * @param {any} options.browserWindow 卡片窗口
 * @param {string} options.windowName 卡片窗口名 (即槽位名)
 * @param {string} options.label 日志标识
 * @param {() => boolean} options.isEnabled 实时读取"是否隐藏"的开关状态
 * @returns {{ sync: () => void }} sync: 按当前配置立即对齐状态 (安装时已自动调用一次)
 */
const createSlotCardHider = ({
  central,
  browserWindow,
  windowName,
  label,
  isEnabled,
}) => {
  const logPrefix = `[HugoAura / ${label}]`;

  if (
    !browserWindow ||
    typeof browserWindow.show !== "function" ||
    typeof browserWindow.hide !== "function"
  ) {
    console.warn(`${logPrefix} Invalid window instance, hider skipped.`);
    return { sync: () => {} };
  }

  // 当前是否处于"被本钩子隐藏"的状态
  let suppressed = false;

  /** 取槽位管理器 (模块 19), 带运行时自检 */
  const getSlotManager = () => {
    try {
      const slotManager = resolveModule(central, 19);
      const isSlotManager =
        slotManager &&
        Array.isArray(slotManager.slotList) &&
        typeof slotManager.hideSlot === "function" &&
        typeof slotManager.showSlot === "function";
      if (!isSlotManager) {
        console.debug(`${logPrefix} Slot manager (module 19) not ready.`);
        return null;
      }
      return slotManager;
    } catch (err) {
      console.warn(`${logPrefix} Failed to get slot manager:`, err);
      return null;
    }
  };

  /** 卡片当前是否占着槽位 */
  const isInSlot = () => {
    const slotManager = getSlotManager();
    return Boolean(
      slotManager && slotManager.slotList.indexOf(windowName) > -1
    );
  };

  /** 释放槽位: 上方卡片下移, 填补隐藏后留下的空白 */
  const releaseSlot = () => {
    if (!isInSlot()) return;
    try {
      getSlotManager().hideSlot(windowName);
      console.log(`${logPrefix} Released slot; cards above moved down.`);
    } catch (err) {
      console.warn(`${logPrefix} Failed to release slot:`, err);
    }
  };

  /** 复位槽位: 卡片回到原本的槽位, 布局恢复 */
  const restoreSlot = () => {
    const slotManager = getSlotManager();
    if (!slotManager || slotManager.slotList.indexOf(windowName) > -1) return;
    try {
      slotManager.showSlot(windowName);
      console.log(`${logPrefix} Restored slot.`);
    } catch (err) {
      console.warn(`${logPrefix} Failed to restore slot:`, err);
    }
  };

  const isDestroyed = () => {
    try {
      return typeof browserWindow.isDestroyed === "function"
        ? browserWindow.isDestroyed()
        : false;
    } catch (err) {
      return true;
    }
  };

  // 补齐 patchShow 的函数推断, 缺失的方法保持 null 由 patchShow 跳过
  const originalShow =
    typeof browserWindow.show === "function"
      ? browserWindow.show.bind(browserWindow)
      : null;
  const originalShowInactive =
    typeof browserWindow.showInactive === "function"
      ? browserWindow.showInactive.bind(browserWindow)
      : null;

  /** 隐藏卡片并释放槽位 */
  const suppress = () => {
    if (!suppressed) {
      suppressed = true;
      try {
        browserWindow.hide();
      } catch (err) {
        console.warn(`${logPrefix} Failed to hide window:`, err);
      }
    }
    // 原生可能又 enterSlot 了一次 (onFinished / restore), 每次都保证槽位是释放状态
    releaseSlot();
  };

  /** 还原卡片与槽位 */
  const restore = () => {
    if (!suppressed) return;
    suppressed = false;
    restoreSlot();
    try {
      originalShow();
      console.log(`${logPrefix} Card restored (hide disabled).`);
    } catch (err) {
      console.warn(`${logPrefix} Failed to show window:`, err);
    }
  };

  // 补丁显示方法: 原生再次显示时立刻收回 (开关关闭后则放行)
  const patchShow = (methodName, original) => {
    if (typeof original !== "function") return;
    const patched = function (...args) {
      if (isEnabled()) {
        suppress();
        console.debug(`${logPrefix} Suppressed ${methodName}() call.`);
        return;
      }
      if (suppressed) {
        suppressed = false;
        restoreSlot();
      }
      return original.apply(this, args);
    };
    browserWindow[methodName] = patched;
  };

  patchShow("show", originalShow);
  patchShow("showInactive", originalShowInactive);

  // 开关切换: 立即收掉卡片 / 还原卡片与布局, 无需等待下一次云端触发
  const eventBus = global.__HUGO_AURA_EVENT_BUS__;
  if (eventBus && typeof eventBus.on === "function") {
    const unsubscribe = eventBus.on("$aura.config.refreshConfig", () => {
      if (isDestroyed()) return;
      if (isEnabled()) {
        suppress();
      } else {
        restore();
      }
    });
    // 窗口销毁后取消监听, 避免残留回调
    if (
      typeof browserWindow.once === "function" &&
      typeof unsubscribe === "function"
    ) {
      browserWindow.once("closed", unsubscribe);
    }
  }

  const sync = () => {
    if (isDestroyed()) return;
    if (isEnabled()) {
      suppress();
    } else if (!suppressed) {
      console.debug(`${logPrefix} Feature disabled, window left untouched.`);
    }
  };

  sync();

  console.log(
    `${logPrefix} Window hook installed on "${windowName}" (hide + slot release).`
  );

  return { sync };
};

module.exports = { createSlotCardHider, readConfigPath };
