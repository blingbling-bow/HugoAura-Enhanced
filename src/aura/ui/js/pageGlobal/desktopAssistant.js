// @ts-check

(() => {
  const MAX_AUTO_HIDE_ATTEMPTS = 12;

  const installScreenLockButton = (attempt = 0) => {
    if (document.getElementById("aura-one-click-screen-lock")) return;
    const rootEl = document.getElementById("root");
    if (!rootEl) {
      if (attempt < MAX_AUTO_HIDE_ATTEMPTS) {
        setTimeout(() => installScreenLockButton(attempt + 1), 250);
      }
      return;
    }

    const button = document.createElement("button");
    button.id = "aura-one-click-screen-lock";
    button.type = "button";
    button.textContent = "一键锁屏";
    button.title = "立即锁定屏幕";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const result = await global.ipcRenderer.invoke(
          "$aura.screenLock.userLock"
        );
        if (!result || !result.success) {
          console.warn("[HugoAura] 一键锁屏失败", result);
        }
      } finally {
        button.disabled = false;
      }
    });
    rootEl.appendChild(button);
  };

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
    } else if (global.__HUGO_AURA_CONFIG__.ssa.ux.easiAssistant.notDisplay) {
      const rootEl = document.getElementById("root");
      if (rootEl) {
        // @ts-expect-error
        rootEl.style["display"] = "none";
      }
    }
  };

  const onMounted = () => {
    applyHideSettings();
    installScreenLockButton();
  };

  onMounted();
})();
