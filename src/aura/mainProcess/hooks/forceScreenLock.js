// @ts-check

const { withRetry, getPrototypeMethod, resolveModule } = require("./retryHook");

/**
 * Keep cloud-delivered screen-lock state enabled. The host's screen-lock
 * manager receives messageType 1211 with screenLockStatus 0 for unlock and
 * 1 for lock; only the former is rewritten when the option is enabled.
 */
const hookFn = (central) => {
  const isEnabled = () => {
    try {
      return Boolean(
        global.__HUGO_AURA_CONFIG_MGR__?.loadConfig()?.auraSettings
          ?.forceEnableScreenLock
      );
    } catch {
      return false;
    }
  };

  const install = () => {
    const manager = resolveModule(central, 26);
    const originalMethod = getPrototypeMethod(manager, "onMessage");
    if (
      !manager ||
      typeof manager.onMessage !== "function" ||
      typeof manager.startLockTask !== "function" ||
      typeof manager.stopLockTask !== "function" ||
      typeof originalMethod !== "function" ||
      !String(originalMethod).includes("screenLockStatus")
    ) {
      return false;
    }

    if (manager.__hugoAuraForceScreenLockInstalled) return true;
    const originalOnMessage = manager.onMessage.bind(manager);
    manager.onMessage = (message) => {
      if (
        isEnabled() &&
        message &&
        message.messageType === 1211 &&
        message.data &&
        message.data.screenLockStatus === 0
      ) {
        console.debug(
          "[HugoAura / ForceScreenLock] Rewrote cloud unlock command to lock."
        );
        originalOnMessage({
          ...message,
          data: { ...message.data, screenLockStatus: 1 },
        });
        return;
      }
      originalOnMessage(message);
    };
    manager.__hugoAuraForceScreenLockInstalled = true;
    console.log("[HugoAura / ForceScreenLock] Installed on module 26.");
    return true;
  };

  withRetry(install, { label: "ForceScreenLock" })();
};

module.exports = { hookFunc: hookFn };
