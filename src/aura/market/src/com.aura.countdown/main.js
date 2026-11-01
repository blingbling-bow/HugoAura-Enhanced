// com.aura.countdown — 悬浮倒计时组件 (UI 插件, 声明式 DOM 桥)
//
// 交互: 时间胶囊点击 = 开始/暂停/复位(时间到后); 3/5/10 分钟预设按钮;
//       "复位"按钮回到默认时长。默认时长可在插件配置弹窗设置。
// 边界: 全部 DOM 操作经 ctx.dom (宿主代管节点), IPC 仅 $aura.plugin.* 白名单。

var ctxRef = null;
var els = { time: 0, start: 0, reset: 0, chips: [] };

var state = "idle"; // idle | running | paused | done
var totalMs = 5 * 60 * 1000;
var remainMs = totalMs;
var endAt = 0;
var tickTimer = 0;
var blinkTimer = 0;
var blinkOn = false;

var TIME_STYLE =
  "position:fixed;left:12px;bottom:12px;z-index:2147483645;" +
  "color:#fff;padding:8px 18px;border-radius:12px;" +
  "font:bold 22px 'Microsoft YaHei',sans-serif;letter-spacing:2px;" +
  "box-shadow:0 4px 14px rgba(0,0,0,0.3);cursor:pointer;user-select:none;";
var BG_IDLE = "background:rgba(20,40,80,0.92);";
var BG_RUN = "background:rgba(16,110,60,0.92);";
var BG_PAUSED = "background:rgba(158,108,10,0.92);";
var BG_DONE = "background:rgba(190,30,30,0.95);";

var BTN_STYLE =
  "position:fixed;bottom:18px;z-index:2147483645;color:#fff;" +
  "padding:4px 10px;border-radius:999px;font:12px 'Microsoft YaHei',sans-serif;" +
  "background:rgba(40,60,100,0.85);cursor:pointer;user-select:none;" +
  "box-shadow:0 2px 8px rgba(0,0,0,0.25);";

var PRESETS = [3, 5, 10];

function fmt(ms) {
  var t = Math.max(0, Math.ceil(ms / 1000));
  var m = Math.floor(t / 60);
  var s = t % 60;
  return m + ":" + (s < 10 ? "0" : "") + s;
}

function bgFor() {
  if (state === "running") return BG_RUN;
  if (state === "paused") return BG_PAUSED;
  if (state === "done") return BG_DONE;
  return BG_IDLE;
}

function setText(id, text) {
  ctxRef.dom.setText(id, text);
}

function renderTime() {
  var ms =
    state === "running"
      ? endAt - Date.now()
      : remainMs;
  if (state === "done") {
    setText(els.time, blinkOn ? "时间到!" : "点击复位");
  } else if (state === "idle") {
    setText(els.time, "⏱ " + fmt(totalMs));
  } else {
    setText(els.time, fmt(ms));
  }
  ctxRef.dom.setAttr(els.time, { style: TIME_STYLE + bgFor() });
}

function stopTickers() {
  if (tickTimer) {
    ctxRef.timers.clearInterval(tickTimer);
    tickTimer = 0;
  }
  if (blinkTimer) {
    ctxRef.timers.clearInterval(blinkTimer);
    blinkTimer = 0;
  }
}

function startBlink() {
  blinkOn = true;
  blinkTimer = ctxRef.timers.setInterval(function () {
    blinkOn = !blinkOn;
    renderTime();
  }, 500);
}

function startTick() {
  stopTickers();
  tickTimer = ctxRef.timers.setInterval(function () {
    if (state !== "running") return;
    var left = endAt - Date.now();
    if (left <= 0) {
      state = "done";
      remainMs = 0;
      stopTickers();
      startBlink();
      setText(els.start, "复位");
      renderTime();
      return;
    }
    renderTime();
  }, 250);
}

function toggleRun() {
  if (state === "idle") {
    endAt = Date.now() + remainMs;
    state = "running";
    setText(els.start, "暂停");
    showChips(false);
    startTick();
  } else if (state === "running") {
    remainMs = Math.max(0, endAt - Date.now());
    state = "paused";
    stopTickers();
    setText(els.start, "继续");
  } else if (state === "paused") {
    endAt = Date.now() + remainMs;
    state = "running";
    setText(els.start, "暂停");
    startTick();
  } else {
    resetAll();
  }
  renderTime();
}

function resetAll() {
  stopTickers();
  state = "idle";
  remainMs = totalMs;
  setText(els.start, "开始");
  showChips(true);
  renderTime();
}

function showChips(visible) {
  for (var i = 0; i < els.chips.length; i++) {
    ctxRef.dom.setAttr(els.chips[i].id, {
      style:
        BTN_STYLE +
        "left:" + (150 + i * 64) + "px;" +
        (visible ? "" : "display:none;"),
    });
  }
  ctxRef.dom.setAttr(els.start, {
    style: BTN_STYLE + "left:" + (150 + els.chips.length * 64) + "px;",
  });
  ctxRef.dom.setAttr(els.reset, {
    style: BTN_STYLE + "left:" + (216 + els.chips.length * 64) + "px;",
  });
}

module.exports = {
  onLoad: function (ctx) {
    ctxRef = ctx;

    // 主胶囊: 时间显示 + 开始/暂停/复位
    els.time = ctx.dom.createEl("div", {
      style: TIME_STYLE + BG_IDLE,
      title: "点击 开始 / 暂停 / 复位",
    });
    ctxRef.dom.appendToBody(els.time);
    ctxRef.dom.on(els.time, "click", toggleRun);
    renderTime();

    // 时长预设按钮
    els.chips = [];
    for (var i = 0; i < PRESETS.length; i++) {
      (function (minutes, idx) {
        var chipId = ctxRef.dom.createEl("div", {
          style: BTN_STYLE + "left:" + (150 + idx * 64) + "px;",
          title: minutes + " 分钟",
        });
        ctxRef.dom.setText(chipId, minutes + " 分");
        ctxRef.dom.appendToBody(chipId);
        ctxRef.dom.on(chipId, "click", function () {
          if (state === "running") return;
          totalMs = minutes * 60 * 1000;
          remainMs = totalMs;
          state = "idle";
          stopTickers();
          setText(els.start, "开始");
          renderTime();
        });
        els.chips.push({ id: chipId, minutes: minutes });
      })(PRESETS[i], i);
    }

    // 开始/暂停 按钮 (与胶囊等价, 便于单手点按)
    els.start = ctxRef.dom.createEl("div", {
      style: BTN_STYLE + "left:" + (150 + PRESETS.length * 64) + "px;",
      title: "开始 / 暂停",
    });
    setText(els.start, "开始");
    ctxRef.dom.appendToBody(els.start);
    ctxRef.dom.on(els.start, "click", toggleRun);

    // 复位 按钮
    els.reset = ctxRef.dom.createEl("div", {
      style: BTN_STYLE + "left:" + (216 + PRESETS.length * 64) + "px;",
      title: "回到默认时长",
    });
    setText(els.reset, "复位");
    ctxRef.dom.appendToBody(els.reset);
    ctxRef.dom.on(els.reset, "click", resetAll);

    // 默认时长: 从插件配置弹窗读取 (IPC 白名单内; 沙箱强制只读自身 id)
    ctxRef.ipc
      .invoke("$aura.plugin.getConfig", { id: "com.aura.countdown" })
      .then(function (res) {
        try {
          var values =
            res && res.success && res.data ? res.data.values || {} : {};
          var minutes = Number(values.defaultMinutes);
          if (minutes > 0 && minutes <= 180 && state === "idle") {
            totalMs = minutes * 60 * 1000;
            remainMs = totalMs;
            renderTime();
          }
        } catch (e) {
          /* 配置读取失败按默认 5 分钟 */
        }
      });
  },
};
