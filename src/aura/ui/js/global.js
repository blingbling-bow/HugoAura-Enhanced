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

  /* ===== 预载密码哈希工具 =====
   * 渲染层脚本的相对 require 基准有两种 (以文档为基准 / 以脚本自身为基准),
   * 写死哪一种都可能踩空; 一旦取不到模块, 设置密码的链路就会抛错。
   * 这里用候选列表加载一次并挂到全局, 供 settings/aura.js 与 config.js 取用。 */
  (() => {
    if (global.__HUGO_AURA_PASSWORD_HASH__) return;
    const candidates = [
      "../../aura/utils/passwordHash", // 渲染层 (文档) 基准
      "../../../utils/passwordHash", // 脚本自身基准
    ];
    for (const candidate of candidates) {
      try {
        const mod = require(candidate);
        if (mod && typeof mod.hashPassword === "function") {
          global.__HUGO_AURA_PASSWORD_HASH__ = mod;
          return;
        }
      } catch (_err) {
        // 该候选不可用, 继续尝试下一个
      }
    }
    console.warn("[HugoAura] 未能预载 passwordHash 模块, 将回退到按需加载");
  })();

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

      const { state, source, ts } = data;
      if (!state) return;

      const time = new Date(ts).toLocaleTimeString("zh-CN");
      const color = { bg: "#fff3cd", border: "#ffc107", text: "#856404" };

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
      icon.textContent = "\u26A0";
      icon.style.cssText = "font-size:24px;flex-shrink:0;";

      const textWrap = document.createElement("div");
      textWrap.style.cssText = "flex:1;";

      const title = document.createElement("p");
      title.textContent = "正在被远程查看屏幕";
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

      // 30 秒后自动消失
      peekAutoHideTimer = setTimeout(hidePeekAlert, 30000);
    };

    ipcRenderer.on("$aura.screenPeek.onPeekDetected", (_event, arg) => {
      if (arg && arg.state) showPeekAlert(arg);
      else hidePeekAlert();
    });
  })();

  /* ===== 远程指令拦截提醒弹窗 (远程关机 / 远程锁屏) ===== */
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

      const { action, source, ts, _logType, bootGuard } = data;
      const blocked = action === "blocked";
      const isLock = _logType === "lockScreen";
      // 关机只有"阻止"一种结果 (不再提供仅提醒的放行模式), 锁屏仍有延迟放行
      // bootGuard: 开机窗口期拦截走的是本地 "下课锁屏" 流程, 措辞区分于远程指令
      const actionName = bootGuard
        ? "开机自动锁屏"
        : isLock
          ? "远程锁屏"
          : "远程关机";
      const time = new Date(ts).toLocaleTimeString("zh-CN");
      const color = blocked
        ? { bg: "#f8d7da", border: "#dc3545", text: "#721c24" }
        : { bg: "#fff3cd", border: "#fd7e14", text: "#856404" };

      powerOffAlertEl = document.createElement("div");
      powerOffAlertEl.style.cssText =
        "position:fixed;bottom:20px;right:20px;z-index:2147483647;" +
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
      // 延迟秒数须与主进程保持一致: 锁屏见 lockScreenInterceptor 的 NOTIFY_DELAY_MS;
      // 关机 / 重启是立即阻止, 没有延迟放行
      const delaySeconds = 5;
      title.textContent = blocked
        ? `已阻止${actionName}`
        : `即将在 ${delaySeconds} 秒后锁屏`;
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

      // 锁屏延迟 5 秒后即真正锁屏, 提示随之收起; 关机已阻止, 提示停留 10 秒
      powerOffAutoHideTimer = setTimeout(hideAlert, isLock ? 5000 : 10000);
    };

    ipcRenderer.on("$aura.powerOff.onBlocked", (_event, arg) => {
      if (arg && arg.record) showAlert(arg.record);
    });
    ipcRenderer.on("$aura.lockScreen.onBlocked", (_event, arg) => {
      if (arg && arg.record) showAlert(arg.record);
    });
  })();

  /* ===== 渲染层插件加载 (ui 类型, vm 能力沙箱: 声明式 DOM 桥 + IPC 白名单) ===== */
  (async () => {
    try {
      if (!global.ipcRenderer)
        global.ipcRenderer = require("electron").ipcRenderer;

      const res = await global.ipcRenderer.invoke("$aura.plugin.list");
      if (!res || !res.success) return;

      let auraDir = (global.__HUGO_AURA__ && global.__HUGO_AURA__.auraDir) || "";
      if (!auraDir) {
        const syncRes = global.ipcRenderer.sendSync("$aura.base.getAuraDirSync");
        auraDir = (syncRes && syncRes.data) || "";
      }
      if (!auraDir) return;

      const nodePath = require("path");
      const nodeFs = require("fs");

      // 渲染层脚本相对 require 的基准有两种 (文档 / 脚本自身), 候选列表兜底
      let uiSandbox = null;
      const sandboxCandidates = [
        "../../aura/ui/js/pluginUiSandbox",
        "../../../ui/js/pluginUiSandbox",
      ];
      for (const candidate of sandboxCandidates) {
        try {
          const mod = require(candidate);
          if (mod && typeof mod.runUiPlugin === "function") {
            uiSandbox = mod;
            break;
          }
        } catch (_err) {
          // 该基准不可用, 尝试下一个
        }
      }
      if (!uiSandbox) {
        console.error("[HugoAura / UIPlugin] 沙箱模块加载失败, 跳过 UI 插件加载");
        return;
      }

      const runs = [];
      for (const item of res.data || []) {
        if (item.type !== "ui" || item.enabled !== true) continue;
        try {
          const mainPath = nodePath.join(auraDir, "plugins", item.id, item.main);
          const source = nodeFs.readFileSync(mainPath, "utf8");
          const run = uiSandbox.runUiPlugin({
            source,
            manifest: item,
            auraVersion: global.__HUGO_AURA__ && global.__HUGO_AURA__.version,
            document,
            ipcInvoke: (channel, payload) =>
              global.ipcRenderer.invoke(channel, payload),
            log: (level, line) =>
              console.log(`[HugoAura / UIPlugin:${item.id}] ${line}`),
          });
          if (run.instance && typeof run.instance.onLoad === "function") {
            run.instance.onLoad(run.ctx);
          }
          runs.push({ id: item.id, dispose: run.dispose });
          console.log(
            `[HugoAura / UIPlugin] Loaded (sandbox): ${item.id} v${item.version}`
          );
        } catch (err) {
          console.error(`[HugoAura / UIPlugin] Failed to load ${item.id}:`, err);
        }
      }

      // 页面卸载/导航时回收沙箱资源 (定时器 + 插件创建的节点)
      window.addEventListener("beforeunload", () => {
        for (const run of runs) {
          try {
            run.dispose();
          } catch (_err) {
            /* 回收失败不影响卸载 */
          }
        }
      });
    } catch (err) {
      console.error("[HugoAura / UIPlugin] Plugin bootstrap failed:", err);
    }
  })();
})();
