// @ts-check

/**
 * 隐藏下课锁屏卡片 (Hide Fast Toolbar) 窗口级钩子
 *
 * 原理: "下课锁屏"卡片是独立窗口 (windowName: "fastToolbar"),
 * 由桌面助手 WS 消息 FAST_TOOLBAR_CONTROL 动态创建 (newOne) / 销毁 (close)。
 *
 * 本钩子由 windowHooksManager 在 fastToolbar 窗口创建时调用:
 * 配置启用时立即隐藏窗口, 并补丁 show/showInactive,
 * 使管家后续的显示调用也被拦下 (每次触发都新建窗口, 钩子会重新执行)。
 *
 * 不拦截消息本身, 桌面助手的其他功能不受影响;
 * 关闭开关后重新触发即恢复正常显示。
 */

const hookFn = (central, app, browserWindow, windowName) => {
  const readEnabled = () => {
    try {
      const mgr = global.__HUGO_AURA_CONFIG_MGR__;
      if (!mgr) return false;
      const config = mgr.loadConfig();
      return Boolean(
        config &&
          config.networkRewrite &&
          config.networkRewrite["appearance/hideFastToolbar"] &&
          config.networkRewrite["appearance/hideFastToolbar"].enabled
      );
    } catch (err) {
      console.error(
        "[HugoAura / HideFastToolbar / Error] Failed to read config:",
        err
      );
      return false;
    }
  };

  if (!readEnabled()) {
    console.debug(
      "[HugoAura / HideFastToolbar] Feature disabled, window left untouched."
    );
    return;
  }

  try {
    // 创建即隐藏 (窗口可能以可见方式创建)
    browserWindow.hide();

    // 补丁显示方法: 每次调用时实时读取配置, 开关关闭后自动恢复
    const patchShow = (methodName) => {
      const original = browserWindow[methodName];
      if (typeof original !== "function" || original.__auraPatched) return;
      const patched = function (...args) {
        if (readEnabled()) {
          console.debug(
            `[HugoAura / HideFastToolbar] Suppressed ${methodName}() call.`
          );
          return;
        }
        return original.apply(this, args);
      };
      patched.__auraPatched = true;
      browserWindow[methodName] = patched;
    };

    patchShow("show");
    patchShow("showInactive");

    console.log(
      `[HugoAura / HideFastToolbar / Success / ${windowName}] Window hidden and show() patched.`
    );
  } catch (err) {
    console.error(
      "[HugoAura / HideFastToolbar / Error] Failed to patch window:",
      err
    );
  }
};

module.exports = { windowName: "fastToolbar", hookFunc: hookFn };
