(() => {
  /* Util: Sleep */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* Util: BootStrap Tooltip Ctrl */
  let tooltipTriggerCache = null;
  const refreshBsTooltip = (selector = '[data-bs-toggle="tooltip"]') => {
    if (tooltipTriggerCache) {
      [...tooltipTriggerCache].map((el) => {
        if (bootstrap.Tooltip.getInstance(el)) {
          bootstrap.Tooltip.getInstance(el).disable();
        }
      });
    }

    const tooltipTriggerList = document.querySelectorAll(selector);
    tooltipTriggerCache = tooltipTriggerList;
    [...tooltipTriggerList].map(
      (tooltipTriggerEl) => new bootstrap.Tooltip(tooltipTriggerEl)
    );
  };

  const createOnLeaveEvtListener = (
    channel,
    pendingRmEvtListener,
    leaveEvt = "onCurConfigPageLeave"
  ) => {
    const rmEvtListener = (event) => {
      document.removeEventListener(channel, pendingRmEvtListener);
      document.removeEventListener(leaveEvt, rmEvtListener);
    };
    document.addEventListener(leaveEvt, rmEvtListener);
    return rmEvtListener;
  };

  if (!window.__HUGO_AURA_GLOBAL__) window.__HUGO_AURA_GLOBAL__ = {};

  window.__HUGO_AURA_GLOBAL__.utils = {
    sleep,
    refreshBsTooltip,
    createOnLeaveEvtListener,
  };

  /* ===== 窥屏提醒弹窗 ===== */
  (() => {
    if (!global.ipcRenderer)
      global.ipcRenderer = require("electron").ipcRenderer;

    let peekAlertEl = null;
    let peekAutoHideTimer = null;

    const hidePeekAlert = () => {
      if (peekAutoHideTimer) {
        clearTimeout(peekAutoHideTimer);
        peekAutoHideTimer = null;
      }
      if (peekAlertEl) {
        peekAlertEl.remove();
        peekAlertEl = null;
      }
    };

    const showPeekAlert = (data) => {
      hidePeekAlert();

      const { state, source, ts, blocked } = data;
      if (!state) return;

      const time = new Date(ts).toLocaleTimeString("zh-CN");
      const color = blocked
        ? { bg: "#f8d7da", border: "#dc3545", text: "#721c24" }
        : { bg: "#fff3cd", border: "#ffc107", text: "#856404" };

      peekAlertEl = document.createElement("div");
      peekAlertEl.id = "aura-screen-peek-alert";
      peekAlertEl.style.cssText =
        "position:fixed;top:20px;right:20px;z-index:2147483647;" +
        'font-family:-apple-system,"Microsoft YaHei",sans-serif;';

      const inner = document.createElement("div");
      inner.style.cssText =
        `background:${color.bg};border:2px solid ${color.border};` +
        "border-radius:10px;padding:14px 18px;box-shadow:0 6px 20px rgba(0,0,0,0.2);" +
        "display:flex;align-items:center;gap:10px;min-width:280px;";

      const icon = document.createElement("span");
      icon.textContent = blocked ? "\u{1F6E1}" : "\u26A0";
      icon.style.cssText = "font-size:24px;flex-shrink:0;";

      const textWrap = document.createElement("div");
      textWrap.style.cssText = "flex:1;";

      const title = document.createElement("p");
      title.textContent = blocked ? "已阻止远程查看屏幕" : "正在被远程查看屏幕";
      title.style.cssText = `margin:0 0 2px;font-size:14px;font-weight:bold;color:${color.text};`;

      const meta = document.createElement("p");
      meta.textContent = `来源: ${source} · ${time}`;
      meta.style.cssText = `margin:0;font-size:11px;color:${color.text};opacity:0.8;`;

      textWrap.appendChild(title);
      textWrap.appendChild(meta);

      const closeBtn = document.createElement("span");
      closeBtn.textContent = "\u00D7";
      closeBtn.style.cssText =
        `font-size:18px;cursor:pointer;color:${color.text};` +
        "opacity:0.6;flex-shrink:0;line-height:1;";
      closeBtn.onmouseenter = () => (closeBtn.style.opacity = "1");
      closeBtn.onmouseleave = () => (closeBtn.style.opacity = "0.6");
      closeBtn.onclick = hidePeekAlert;

      inner.appendChild(icon);
      inner.appendChild(textWrap);
      inner.appendChild(closeBtn);
      peekAlertEl.appendChild(inner);

      // body 可能还未就绪, 用兜底
      (document.body || document.documentElement).appendChild(peekAlertEl);

      // notify 模式 30 秒后自动消失
      if (!blocked) {
        peekAutoHideTimer = setTimeout(hidePeekAlert, 30000);
      }
    };

    ipcRenderer.on("$aura.screenPeek.onPeekDetected", (_event, arg) => {
      if (arg && arg.state) showPeekAlert(arg);
      else hidePeekAlert();
    });
  })();

  /* ===== 远程关机拦截提醒弹窗 ===== */
  (() => {
    if (!global.ipcRenderer)
      global.ipcRenderer = require("electron").ipcRenderer;

    let powerOffAlertEl = null;
    let powerOffAutoHideTimer = null;

    const hideAlert = () => {
      if (powerOffAutoHideTimer) {
        clearTimeout(powerOffAutoHideTimer);
        powerOffAutoHideTimer = null;
      }
      if (powerOffAlertEl) {
        powerOffAlertEl.remove();
        powerOffAlertEl = null;
      }
    };

    const showAlert = (data) => {
      hideAlert();

      const { action, source, ts } = data;
      const blocked = action === "blocked";
      const time = new Date(ts).toLocaleTimeString("zh-CN");
      const color = blocked
        ? { bg: "#f8d7da", border: "#dc3545", text: "#721c24" }
        : { bg: "#fff3cd", border: "#fd7e14", text: "#856404" };

      powerOffAlertEl = document.createElement("div");
      powerOffAlertEl.style.cssText =
        "position:fixed;top:20px;right:20px;z-index:2147483647;" +
        'font-family:-apple-system,"Microsoft YaHei",sans-serif;';

      const inner = document.createElement("div");
      inner.style.cssText =
        `background:${color.bg};border:2px solid ${color.border};` +
        "border-radius:10px;padding:14px 18px;box-shadow:0 6px 20px rgba(0,0,0,0.2);" +
        "display:flex;align-items:center;gap:10px;min-width:280px;";

      const icon = document.createElement("span");
      icon.textContent = blocked ? "\u{1F6E1}" : "\u26A0";
      icon.style.cssText = "font-size:24px;flex-shrink:0;";

      const textWrap = document.createElement("div");
      textWrap.style.cssText = "flex:1;";

      const title = document.createElement("p");
      title.textContent = blocked
        ? "已阻止远程关机"
        : "检测到远程关机, 10 秒后执行";
      title.style.cssText = `margin:0 0 2px;font-size:14px;font-weight:bold;color:${color.text};`;

      const meta = document.createElement("p");
      meta.textContent = `来源: ${source} · ${time}`;
      meta.style.cssText = `margin:0;font-size:11px;color:${color.text};opacity:0.8;`;

      textWrap.appendChild(title);
      textWrap.appendChild(meta);

      const closeBtn = document.createElement("span");
      closeBtn.textContent = "\u00D7";
      closeBtn.style.cssText =
        `font-size:18px;cursor:pointer;color:${color.text};` +
        "opacity:0.6;flex-shrink:0;line-height:1;";
      closeBtn.onmouseenter = () => (closeBtn.style.opacity = "1");
      closeBtn.onmouseleave = () => (closeBtn.style.opacity = "0.6");
      closeBtn.onclick = hideAlert;

      inner.appendChild(icon);
      inner.appendChild(textWrap);
      inner.appendChild(closeBtn);
      powerOffAlertEl.appendChild(inner);

      (document.body || document.documentElement).appendChild(powerOffAlertEl);

      // 10 秒后自动消失
      powerOffAutoHideTimer = setTimeout(hideAlert, 10000);
    };

    ipcRenderer.on("$aura.powerOff.onBlocked", (_event, arg) => {
      if (arg && arg.record) showAlert(arg.record);
    });
  })();
})();
