// @ts-check

/**
 * 隐藏管家助手卡片 (Hide Desktop Assistant) 窗口级钩子
 *
 * 目标: "管家助手"(教学资源面板, windowName: "desktopAssistant"),
 * 是槽位卡片里最大的一张 (yIndex 2, 480×400)。
 * 原生自己的隐藏 / 还原流程都是与槽位成对操作的:
 *   最小化 -> getInstance("desktopAssistant").minimize() + hideSlot("desktopAssistant")
 *   还原   -> restore("desktopAssistant") + showSlot("desktopAssistant")
 *   关闭   -> close("desktopAssistant") (窗口 config onClose -> outSlot)
 *
 * 但 Aura 的"隐藏管家助手"开关此前只在页面里把 #root 设为 display:none ——
 * 窗口还在、480×400 的槽位也还在, 屏底会空出一大片。
 * 本钩子改为隐藏窗口 + 释放槽位, 让上方卡片下移填补空白;
 * 页面内的 display:none 仍保留, 作为钩子未命中时的兜底。
 */

const { createSlotCardHider, readConfigPath } = require("./slotCardHider");

const WINDOW_NAME = "desktopAssistant";

const hookFn = (central, app, browserWindow) => {
  createSlotCardHider({
    central,
    browserWindow,
    windowName: WINDOW_NAME,
    label: "HideDesktopAssistant",
    isEnabled: () =>
      Boolean(readConfigPath("ssa.ux.easiAssistant.notDisplay")),
  });
};

module.exports = { windowName: WINDOW_NAME, hookFunc: hookFn };
