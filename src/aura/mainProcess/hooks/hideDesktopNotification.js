// @ts-check

/**
 * 隐藏常驻消息通知卡片 (Hide Desktop Notification) 窗口级钩子
 *
 * 目标: 桌面常驻消息通知 (windowName: "desktopNotification"),
 * 是悬浮在管家助手**上方**的一张槽位卡片 (yIndex 4, 480×200)。
 *
 * 它由云端指令经 WS 通道 /SeewoProxy 下发触发:
 *   url === "/residentNotice"       -> share("desktopNotificationMessage") + newOne
 *   url === "/cancelResidentNotice" -> close("desktopNotification")
 * 窗口 config 同样是成对的 enterSlot() / outSlot(), 因此只 hide() 不释放槽位
 * 的话, 槽位仍占着 200+8 的高度, 下方卡片不会上移, 屏底就留出一条空白。
 * 隐藏 / 还原与槽位的成对操作由 slotCardHider 统一处理。
 */

const { createSlotCardHider, readConfigPath } = require("./slotCardHider");

const WINDOW_NAME = "desktopNotification";

const hookFn = (central, app, browserWindow) => {
  createSlotCardHider({
    central,
    browserWindow,
    windowName: WINDOW_NAME,
    label: "HideDesktopNotification",
    isEnabled: () =>
      Boolean(
        readConfigPath(
          "networkRewrite.appearance/hideDesktopNotification.enabled"
        )
      ),
  });
};

module.exports = { windowName: WINDOW_NAME, hookFunc: hookFn };
