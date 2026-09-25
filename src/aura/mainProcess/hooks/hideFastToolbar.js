// @ts-check

/**
 * 隐藏下课锁屏卡片 (Hide Fast Toolbar) 窗口级钩子
 *
 * 目标: "下课锁屏"卡片 (windowName: "fastToolbar"), 由桌面助手 WS 消息
 * FAST_TOOLBAR_CONTROL (messageType 1213) 动态创建 (newOne) / 销毁 (close)。
 *
 * 它是槽位栈的栈底 (yIndex 0, 480×56), 只 hide() 窗口不释放槽位的话,
 * 槽位仍占着 56+8 的高度, 上方卡片不会下移, 屏底就留出一条空白。
 * 隐藏 / 还原与槽位的成对操作由 slotCardHider 统一处理。
 */

const { createSlotCardHider, readConfigPath } = require("./slotCardHider");

const WINDOW_NAME = "fastToolbar";

const hookFn = (central, app, browserWindow) => {
  createSlotCardHider({
    central,
    browserWindow,
    windowName: WINDOW_NAME,
    label: "HideFastToolbar",
    isEnabled: () =>
      Boolean(
        readConfigPath("networkRewrite.appearance/hideFastToolbar.enabled")
      ),
  });
};

module.exports = { windowName: WINDOW_NAME, hookFunc: hookFn };
