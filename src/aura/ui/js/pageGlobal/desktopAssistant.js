// @ts-check

(() => {
  const MAX_AUTO_HIDE_ATTEMPTS = 12;

  const findMinimizeButton = () => {
    const selectors = [
      ".index__button2__2mhwC3oY",
      '[class*="index__button2__"]',
      '[class*="button2__"]',
    ];

    for (const selector of selectors) {
      const container = document.querySelector(selector);
      const button = container?.querySelector("button,[role='button']") ||
        container?.children?.[0];
      if (button) return button;
    }

    return null;
  };

  const applyHideSettings = (attempt = 0) => {
    if (global.__HUGO_AURA_CONFIG__.ssa.ux.easiAssistant.autoHide) {
      const minimizeBtnEl = findMinimizeButton();
      if (minimizeBtnEl) {
        // @ts-expect-error
        minimizeBtnEl.click();
      } else if (attempt < MAX_AUTO_HIDE_ATTEMPTS) {
        setTimeout(() => {
          if (global.__HUGO_AURA_CONFIG__.ssa.ux.easiAssistant.autoHide) {
            applyHideSettings(attempt + 1);
          }
        }, 250);
      } else {
        console.warn(
          "[HugoAura / UI / Assistant] Unable to find the minimize button"
        );
      }
    }
    // "隐藏管家助手" (easiAssistant.notDisplay) 由主进程窗口钩子负责:
    // 隐藏窗口 + 释放槽位 (mainProcess/hooks/hideDesktopAssistant.js)。
    // 这里不能再把 #root 设为 display:none —— 该内联样式只在页面加载时设置一次,
    // 开关关闭后不会复位, 会让恢复显示的卡片窗口变成一张空白卡片。
  };

  const onMounted = () => {
    applyHideSettings();
  };

  onMounted();
})();
