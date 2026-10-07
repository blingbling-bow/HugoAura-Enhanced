// @ts-check

/**
 * 指令审计日志可视化 (Audit Log Viewer)
 *
 * 渲染层实现:
 *   - 统计摘要卡片: 总记录 / 已捕获 / 已拦截 / 未识别 / 窥屏 / 关机 / 锁屏
 *   - 日志表格: 时间 / 来源 / 通道 / 指令 / 动作 / 数据, 点击行展开完整 JSON
 *   - 过滤: 关键字 (URL/来源/动作/通道) + 动作类型 + 通道 + 「仅未识别」
 *   - 刷新 / 清空 / 复制全部 / 下载 JSONL
 *   - 实时推送: 监听主进程 $aura.audit.onLog 事件即时更新
 */

const AUDIT_IPC_BASE = "$aura.audit";
const CHANNEL_ON_LOG = "$aura.audit.onLog";

// 内存中保留的最大条目数 (防止无限增长)
const MAX_IN_MEMORY = 600;
// 一次向主进程请求的条目数
const FETCH_LIMIT = 300;
// 从主进程导出的 JSONL 上限
const EXPORT_LIMIT = 1000;

const state = {
  entries: [],
  filterText: "",
  filterType: "all",
  filterChannel: "all",
  onlyUnknown: false,
  listenerInstalled: false,
};

// 解锁方式中文名 (unlockAudit 记录的 method 字段)
const UNLOCK_METHOD_LABELS = {
  remote: "远程解锁",
  activationCode: "激活码解锁",
  password: "密码解锁",
};

/**
 * 已知指令表: key -> 中文说明。
 * key 由主进程 cloudUpdateInterceptor.commandKeyOf 生成:
 *   - 有 url 的指令取 url
 *   - 否则取 `messageType:<消息类型>`
 *   - 两者都没有则记为 `(unidentified)`
 * 表中查不到的即视为「未识别」—— 这些正是需要留意的未知指令。
 */
const KNOWN_COMMANDS = {
  // HTTP 指令
  "/api/v1/power/confirmShutdown": "云端关机确认",
  "/api/v1/power/shutdown": "云端关机",
  "/api/v1/upgrade/check": "升级检查",
  "/powerOff/confirm": "远程关机确认",
  // WebSocket 指令
  "/liveclient": "远程窥屏 (任务注册)",
  "/RemoteControl": "远程控制",
  // 消息类型 (无 URL, 仅有 messageType)
  "messageType:1001": "设备信息上报",
  "messageType:1002": "病毒服务指令",
  "messageType:1003": "病毒服务上报",
  "messageType:1211": "远程锁屏",
  "messageType:1213": "语音服务指令",
  "messageType:1214": "语音服务指令",
  "messageType:1215": "语音服务指令",
  "messageType:1315": "设备绑定",
  "messageType:1317": "设备绑定",
  "messageType:1318": "设备绑定",
  // 出站 HTTP (SeewoProxyHTTP 代理调用) —— 真实 path 可能带 /forward/SeewoHugoHttp
  // 前缀, 查表前会先归一化 (见 normalizeHttpPath)
  "/api/v1/device/id": "查询设备 ID",
  "/api/v1/login/info": "登录信息上报",
  "/api/v1/uips/feedback": "UIPS 反馈上报",
  "/api/app/v2/report": "通用上报",
  "/api/v1/screenlock/startMiniSizeWindows": "开启迷你锁屏窗",
  "/api/v1/screenlock/stopMiniSizeWindows": "关闭迷你锁屏窗",
  "/api/v1/screenlock/lockfeedback": "锁屏回执上报",
  "/api/v1/screenlock/unlockfeedback": "解锁回执上报",
  "/api/v1/screenLock/unlock/auth": "解锁鉴权",
  "/api/v1/admin/password/auth": "管理员密码鉴权",
  "/api/v1/pre_bind/school/auth": "学校预绑定鉴权",
  "/api/v1/power/confirmShutdown": "关机回执确认",
  "/api/v1/screenSaver/reset": "屏保重置上报",
  "/api/v1/desktop/desktop_data": "桌面数据上报",
  "/api/v1/desktop/setting": "桌面设置上报",
  "/api/v1/residentNotice/feedback": "常驻通知回执",
  "/api/v1/cancelResidentNotice/feedback": "取消常驻通知回执",
  "/api/v1/popupNotice/feedback": "弹窗通知回执",
  "/api/v1/marquee/feedback": "跑马灯回执",
  "/api/v1/sceneVoice/feedback": "场景语音回执",
  "/api/v1/newsBroadcast/feedback": "新闻广播回执",
  "/api/v1/propaganda/Feedback": "宣传回执",
  "/api/v1/shout/stop": "喊话停止",
  "/api/v1/eye_protection/timer/finishing": "护眼计时结束上报",
  "/api/v1/eye_protection/timer/pausing": "护眼计时暂停上报",
  "/api/v1/eye_protection/timer/resume": "护眼计时恢复上报",
  // ===== 真机实测补全 (2026-10-04 真机 cloudCommandAudit.log, 295 条) =====
  // WebSocket 下行指令
  "/cancelResidentNotice": "取消常驻通知",
  "/serviceUpgrade/status": "云端升级状态下发",
  "/password/authMode": "密码认证模式下发",
  "/qrCode/remoteAuth": "扫码远程解锁开关",
  "/message/user/login/info": "用户登录信息下发",
  "/newsBroadcast/auth": "新闻广播授权",
  "/edgeServer/ip": "边缘服务器地址下发",
  "/propaganda/uips/property": "UIPS 宣传属性下发",
  "/qrCode/notify": "扫码登录通知",
  "messageType:/propaganda/auth": "宣传授权下发",
  // 模块 132 HideCountdown: GET_COUNTDOWN_MES = 1004
  "messageType:1004": "倒计时消息",
  // 广告拦截通道 (ADBlockWebSocket, 模块 126 常量表)
  "/record": "广告拦截记录",
  "/switch": "广告拦截开关",
  "/superState": "广告拦截超级状态",
  "/blockCount": "广告拦截计数",
  // 灯光/音频通道 (audioWebsocket, 模块 407)
  "/lightAudio/device": "灯光音频设备状态",
  "/lightAudio/newPairableDevices": "可配对灯光设备列表",
  "/mic/batteryLow": "麦克风电量低",
  // 智慧讲台通道 (wisdomPlatformWebsocket, 模块 406)
  "/wisdomPlatform/linkState": "智慧讲台连接状态",
  "/wisdomPlatform/actionNotify": "智慧讲台操作通知",
  // 进程加速通道 (processAcceleration, 模块 405)
  "messageType:1854": "进程数据下发",
  "messageType:1853": "结束进程指令",
  // ===== bundle 字面量全量扫荡补全 (scripts/audit-path-literals.js) =====
  // 浮窗提示 (模块 125): 云端控制悬浮小窗的创建/移动/关闭
  "/tipConfirm": "浮窗提示 (创建/移动/关闭)",
  // 绑定
  "/batchbind/receivedResult": "批量绑定结果下发",
  "/batchBind/success": "批量绑定成功通知",
  // 磁盘清理 (模块 69)
  "/disk/clean/status": "磁盘清理状态下发",
  "/systemDisk/clean/status": "系统盘清理状态下发",
  "/userProfile/moving/status": "用户配置迁移状态下发",
  // 边缘服务器 (模块 405)
  "/edgeServer/search": "边缘服务器搜索指令",
  // 护眼 (模块 144)
  "/eye_protection/timer/created": "护眼计时创建",
  "/eye_protection/timer/aborted": "护眼计时中止",
  "/eye_protection/timer/paused": "护眼计时暂停",
  "/eye_protection/timer/resumed": "护眼计时恢复",
  // NFC 鉴权 (模块 414)
  "/message/nfc/authResult": "NFC 鉴权结果下发",
  // 新闻广播 (模块 71)
  "/newsBroadcast/play": "新闻广播播放",
  "/newsBroadcast/cancel": "新闻广播取消",
  // 宣传/UIPS (模块 147/66)
  "/propaganda/task": "宣传任务下发",
  "/propaganda/cancel": "宣传任务取消",
  "/propaganda/uips/playProgram": "UIPS 播放节目",
  "/propaganda/uips/cancelProgram": "UIPS 取消节目",
  "/propaganda/uips/stopPrograms": "UIPS 停止节目",
  "/propaganda/uips/service": "UIPS 服务下发",
  // 扫码 (模块 404)
  "/qrCode/auth": "扫码鉴权",
  // 升级 (模块 406)
  "/serviceUpgrade/feedback": "升级回执请求",
  // 喊话 (模块 419)
  "/shouting/notice": "喊话通知下发",
  // 设备配对 (模块 57)
  "/sp20e/pairingError": "SP20E 设备配对错误下发",
};

// 出站 HTTP 路径前缀 (管家调用本地代理时拼在真实 API 路径前)
const HTTP_PATH_PREFIX = "/forward/SeewoHugoHttp";

/** 剥掉代理前缀, 便于按 API 路径查指令表 */
const normalizeHttpPath = (path) => {
  const raw = String(path || "");
  if (!raw) return raw;
  return raw.startsWith(HTTP_PATH_PREFIX)
    ? raw.slice(HTTP_PATH_PREFIX.length) || "/"
    : raw;
};

/** 该记录是否为未知指令 */
const isUnknownCommand = (entry) => {
  // 仅对云端指令判定; 窥屏 / 锁屏 / 解锁等本地事件不算
  if (entry._logType && entry._logType !== "cloud") return false;
  const key = entry.key;
  if (!key) return false;
  if (key === "(unidentified)") return true;
  return !Object.prototype.hasOwnProperty.call(KNOWN_COMMANDS, key);
};

/** 指令列显示文本 */
const commandTextOf = (entry) => {
  if (entry._logType === "peek") return entry.url || "/liveclient";
  // 出站 HTTP: 显示请求路径 (剥掉代理前缀后查表, 命中则显示中文名)
  if (entry._logType === "http") {
    const path = entry.url || entry.key || "-";
    const normalized = normalizeHttpPath(path);
    return KNOWN_COMMANDS[normalized] || KNOWN_COMMANDS[path] || normalized;
  }
  if (entry.key && entry.key !== "(unidentified)")
    return KNOWN_COMMANDS[entry.key] || entry.key;
  if (entry.url) return entry.url;
  if (entry.messageType !== undefined && entry.messageType !== null)
    return `消息类型 ${entry.messageType}`;
  return entry._logType === "cloud" ? "未知指令" : "-";
};

const escapeHtml = (value) => {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
};

/**
 * 通道名归一化。
 *
 * 探针早期版本拿不到通道名时会把整条 WS URL 当作 channel 写进日志, 例如
 *   wss://127.0.0.1:51270/forward/SeewoHugoHttp/SeewoWindowBlock
 * 显示与筛选都很难看。这里把 URL 形态的通道名还原成最后一段
 * (SeewoWindowBlock), 新版本日志本身就是通道名 (ADBlockWebSocket), 原样保留。
 */
const shortChannelOf = (channel) => {
  const s = String(channel || "");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return channel;
  const withoutScheme = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const slash = withoutScheme.indexOf("/");
  const path = slash >= 0 ? withoutScheme.slice(slash) : "";
  const segment = path.split("/").filter(Boolean).pop();
  return segment || s;
};

// 动作徽标样式
const actionMeta = (entry) => {
  if (entry._logType === "unlock") {
    return {
      text: UNLOCK_METHOD_LABELS[entry.method] || "未知解锁",
      cls: entry.method === "unknown" ? "secondary" : "info",
    };
  }
  if (entry._logType === "peek") {
    if (entry.action === "peek_start") {
      return entry.blocked
        ? { text: "窥屏已阻止", cls: "danger" }
        : { text: "窥屏开始", cls: "warning" };
    }
    if (entry.action === "peek_stop")
      return { text: "窥屏结束", cls: "secondary" };
  }
  if (entry._logType === "powerOff") {
    if (entry.action === "blocked")
      return { text: "关机已阻止", cls: "danger" };
    if (entry.action === "captured")
      return { text: "关机提醒", cls: "warning" };
  }
  if (entry._logType === "lockScreen") {
    if (entry.action === "blocked")
      return { text: "锁屏已阻止", cls: "danger" };
    if (entry.action === "captured")
      return { text: "锁屏提醒", cls: "warning" };
    if (entry.action === "unlock")
      return { text: "解锁已接管", cls: "info" };
    if (entry.action === "passthrough_unlock")
      return { text: "解锁已放行", cls: "secondary" };
    if (entry.action === "passthrough")
      return { text: "锁屏已放行", cls: "secondary" };
  }
  // 出站 HTTP 响应 (SeewoProxyHTTP 调用的返回)
  if (entry._logType === "http") {
    const status = entry.httpStatus != null ? String(entry.httpStatus) : "";
    if (entry.error) return { text: `失败 ${status}`.trim(), cls: "warning" };
    return { text: `${entry.method || "GET"} ${status}`.trim(), cls: "info" };
  }
  if (entry.action === "blocked") return { text: "已拦截", cls: "danger" };
  if (entry.action === "captured") return { text: "已捕获", cls: "primary" };
  if (entry.action === "logged") return { text: "已记录", cls: "info" };
  return { text: entry.action || "-", cls: "secondary" };
};

const formatTime = (ts) => {
  if (!ts) return "-";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/**
 * 耗时展示 (纯函数)。
 * 出站 HTTP 是"发起 -> 响应结束"的真实往返耗时; WS/本地事件是拦截链自身的
 * 处理耗时 (亚毫秒级)。没有耗时数据的记录显示占位符。
 *
 * @param {number | null | undefined} ms
 * @returns {string}
 */
const formatDuration = (ms) => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
};

/**
 * 过滤判定 (纯函数, 便于单测)。
 * 关键字在这里统一 trim + 转小写 —— 调用方不需要记得先归一化。
 * @param {any} entry
 * @param {{ text?: string, onlyUnknown?: boolean, channel?: string, type?: string }} f
 * @returns {boolean}
 */
const entryMatchesFilters = (entry, f) => {
  const text = typeof f.text === "string" ? f.text.trim().toLowerCase() : "";
  if (text) {
    const haystack = [
      entry.url,
      entry.source,
      entry.channel,
      entry.action,
      entry._logType,
      entry.key,
      entry.messageType,
      entry.traceId,
    ]
      .filter((v) => v != null)
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(text)) return false;
  }
  if (f.onlyUnknown && !isUnknownCommand(entry)) return false;
  if (f.channel !== "all") {
    const ch = entry.channel || entry._logType || "";
    if (ch !== f.channel) return false;
  }
  if (f.type === "all") return true;
  return entry.action === f.type;
};

const matchesFilter = (entry) =>
  entryMatchesFilters(entry, {
    text: state.filterText,
    onlyUnknown: state.onlyUnknown,
    channel: state.filterChannel,
    type: state.filterType,
  });

// ===== HTML 生成 (纯函数: 渲染、预览页与单测共用) ===== //

/**
 * 指令列的"显示名 + 原始键"。
 *
 * 中文名便于快速判读, 但审计工具必须能看到指令原文 —— 否则「广告拦截记录」
 * 背后到底是 /record 还是别的什么就无从核对。因此两行都给出。
 */
const commandPartsOf = (entry) => {
  const label = commandTextOf(entry);
  const raw =
    entry._logType === "http"
      ? normalizeHttpPath(entry.url || entry.key || "")
      : entry.key && entry.key !== "(unidentified)"
        ? entry.key
        : entry.url || "";
  return { label, raw: raw && raw !== label ? raw : "" };
};

/**
 * 记录的危险等级 —— 决定行首色条与徽标配色。
 * @param {any} entry
 * @returns {"blocked"|"peek"|"powerOff"|"lockScreen"|"unlock"|"http"|"cloud"}
 */
const severityOf = (entry) => {
  if (entry.action === "blocked" || entry.blocked === true) return "blocked";
  if (entry._logType === "http") return "http";
  if (entry._logType === "unlock") return "unlock";
  if (entry._logType === "lockScreen") return "lockScreen";
  if (entry._logType === "powerOff") return "powerOff";
  if (entry._logType === "peek" || entry.action === "peek_start") return "peek";
  return "cloud";
};

/**
 * JSON 语法着色 (纯函数)。
 *
 * 注意顺序: 必须在**未转义**的原文上用正则切分, 再逐段 escapeHtml ——
 * 反过来先转义会让引号变成 &quot;, 正则就再也匹配不到字符串了。
 *
 * @param {any} value
 * @returns {string} 已转义且带高亮 span 的 HTML
 */
const highlightJson = (value) => {
  let raw;
  try {
    raw = JSON.stringify(value, null, 2);
  } catch {
    raw = String(value);
  }
  if (raw === undefined) raw = "null";

  const re =
    /("(?:\\.|[^"\\])*")(\s*:)?|(\btrue\b|\bfalse\b)|(\bnull\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(raw)) !== null) {
    out += escapeHtml(raw.slice(last, m.index));
    if (m[1] !== undefined) {
      out += `<span class="${m[2] ? "aura-json-key" : "aura-json-str"}">${escapeHtml(
        m[1]
      )}</span>`;
      if (m[2]) out += escapeHtml(m[2]);
    } else if (m[3] !== undefined) {
      out += `<span class="aura-json-bool">${escapeHtml(m[3])}</span>`;
    } else if (m[4] !== undefined) {
      out += `<span class="aura-json-null">${escapeHtml(m[4])}</span>`;
    } else {
      out += `<span class="aura-json-num">${escapeHtml(m[5])}</span>`;
    }
    last = re.lastIndex;
  }
  out += escapeHtml(raw.slice(last));
  return out;
};

/** 统计卡片区 HTML */
const statsHtml = (stats) =>
  stats
    .map(
      (s) => `
      <div class="aura-audit-stat" data-sev="${s.cls}">
        <div class="aura-audit-stat-head">
          <span class="aura-audit-stat-label">${escapeHtml(s.label)}</span>
          <span class="aura-audit-stat-dot"></span>
        </div>
        <div class="aura-audit-stat-value">${s.value}${
          s.sub ? `<span class="aura-audit-stat-sub">${escapeHtml(s.sub)}</span>` : ""
        }</div>
      </div>`
    )
    .join("");

/** 表格空状态 */
const emptyStateHtml = () => `
  <tr class="aura-audit-empty-row">
    <td colspan="6">
      <div class="aura-audit-empty">
        <div class="aura-audit-empty-ico">◍</div>
        <div class="aura-audit-empty-title">暂无审计记录</div>
        <div class="aura-audit-empty-desc">
          云端下发指令或检测到窥屏事件后会自动出现在这里
        </div>
      </div>
    </td>
  </tr>`;

/**
 * 详情弹窗里的元信息 (键值两栏, 纯函数)。
 *
 * 为什么不用小胶囊拼一排: 来源/traceId 这类值很长, 胶囊挤在一起会
 * 换行错位、看不出哪段是标签哪段是值。键值两栏 + 左侧固定标签宽,
 * 长值在自身格子里折行, 结构始终清晰。
 */
const detailMetaHtml = (entry) =>
  [
    ["通道", entry.channel || entry._logType || "-"],
    ["来源", entry.source || "-"],
    ["模块", entry.channelId === null || entry.channelId === undefined ? "-" : entry.channelId],
    ["traceId", entry.traceId || "-"],
  ]
    .filter(([, v]) => v !== "-")
    .map(
      ([k, v]) =>
        `<div class="aura-audit-meta-row">
          <span class="aura-audit-meta-key">${escapeHtml(k)}</span>
          <span class="aura-audit-meta-val">${escapeHtml(String(v))}</span>
        </div>`
    )
    .join("");

/**
 * 详情弹窗 (纯函数, 渲染与预览页共用)。
 *
 * 为什么是弹窗: 管家窗口固定 880x600 且不可拉伸, 行内展开会把表格撑得
 * 忽高忽低、一屏看不全 —— 弹窗独立滚动, 表格始终保持一行一条的节奏。
 *
 * @param {any} entry
 * @returns {string} 覆盖全屏的模态框 HTML
 */
const detailModalHtml = (entry) => `
    <div class="aura-audit-modal">
      <div class="aura-audit-modal-card" role="dialog" aria-modal="true">
        <div class="aura-audit-modal-head">
          <div class="aura-audit-modal-heading">
            <p class="aura-audit-modal-title">指令详情</p>
            <p class="aura-audit-modal-sub">${escapeHtml(formatTime(entry.ts))}</p>
          </div>
          <button type="button" class="aura-audit-btn aura-audit-modal-close" title="关闭 (Esc)">
            ✕
          </button>
        </div>
        <div class="aura-audit-modal-meta">${detailMetaHtml(entry)}</div>
        <div class="aura-audit-modal-body">
          <pre class="aura-audit-json">${highlightJson(entry)}</pre>
        </div>
        <div class="aura-audit-modal-foot">
          <button type="button" class="aura-audit-btn aura-audit-copy-one">复制 JSON</button>
        </div>
      </div>
    </div>`;

/** 单条记录的主行 */
const rowHtml = (entry, key) => {
  const meta = actionMeta(entry);
  const unknown = isUnknownCommand(entry);
  const sev = severityOf(entry);
  const channelText = entry.channel || entry._logType || "-";
  const host = entry.source || "-";
  const cmd = commandPartsOf(entry);
  const dur = formatDuration(entry.durationMs);

  return `
      <tr class="aura-audit-row" data-sev="${sev}" data-key="${escapeHtml(key)}">
        <td class="aura-audit-td-time">${escapeHtml(formatTime(entry.ts))}</td>
        <td class="aura-audit-td-source">
          <span class="aura-audit-chan" title="${escapeHtml(channelText)}">${escapeHtml(
            channelText
          )}</span>
          <span class="aura-audit-host" title="${escapeHtml(host)}">${escapeHtml(
            host
          )}</span>
        </td>
        <td class="aura-audit-td-cmd">
          <span class="aura-audit-cmd-name" title="${escapeHtml(cmd.label)}">${escapeHtml(
            cmd.label
          )}${
            unknown
              ? '<span class="aura-audit-flag" title="指令表未收录, 可能是新的云端下发行为">未识别</span>'
              : ""
          }</span>
          ${
            cmd.raw
              ? `<code class="aura-audit-cmd" title="${escapeHtml(cmd.raw)}">${escapeHtml(
                  cmd.raw
                )}</code>`
              : ""
          }
        </td>
        <td class="aura-audit-td-action">
          <span class="aura-audit-pill" data-tone="${meta.cls}">${escapeHtml(
            meta.text
          )}</span>
        </td>
        <td class="aura-audit-td-dur" title="处理耗时${dur === "—" ? " (无耗时数据)" : ""}">${dur}</td>
        <td class="aura-audit-td-op">
          <button
            type="button"
            class="aura-audit-btn aura-audit-btn-sm aura-audit-detail-btn"
            data-detail="${escapeHtml(key)}"
            title="查看这条记录的完整 JSON"
          >详情</button>
        </td>
      </tr>`;
};

const renderEntries = () => {
  const filtered = state.entries.filter(matchesFilter);
  renderStats(filtered, state.entries);
  renderTable(filtered);
  renderFooter(filtered);
};

/** 统计口径 (纯函数, 供渲染与预览共用) */
const buildStats = (filtered, all) => {
  const count = (pred) => all.filter(pred).length;
  return [
    {
      label: "全部记录",
      value: filtered.length,
      sub: all.length !== filtered.length ? `/ ${all.length}` : "",
      cls: "primary",
    },
    {
      label: "已拦截",
      value: count((e) => e.action === "blocked"),
      cls: "danger",
    },
    {
      label: "未识别指令",
      value: count(isUnknownCommand),
      cls: "warning",
    },
    {
      label: "出站响应",
      value: count((e) => e._logType === "http"),
      cls: "info",
    },
    {
      label: "窥屏事件",
      value: count((e) => e.action === "peek_start"),
      sub: `结束 ${count((e) => e.action === "peek_stop")}`,
      cls: "warning",
    },
    {
      label: "关机拦截",
      value: count((e) => e._logType === "powerOff"),
      cls: "danger",
    },
    {
      label: "锁屏拦截",
      value: count(
        (e) =>
          e._logType === "lockScreen" &&
          (e.action === "blocked" || e.action === "captured")
      ),
      cls: "danger",
    },
    {
      label: "解锁记录",
      value: count((e) => e._logType === "unlock"),
      cls: "info",
    },
  ];
};

/** 渲染统计条 */
const renderStats = (filtered, all) => {
  const container = document.getElementById("auditStatsContainer");
  if (!container) return;
  container.innerHTML = statsHtml(buildStats(filtered, all));
};

/** 行唯一键 (同一时刻可能有多条, 用序号兜底) */
const entryKey = (entry) =>
  `${entry.ts || ""}|${entry.source || ""}|${entry.key || entry.url || ""}|${
    entry.action || ""
  }`;

const renderTable = (filtered) => {
  const tbody = document.getElementById("auditTableBody");
  if (!tbody) return;

  if (filtered.length === 0) {
    tbody.innerHTML = emptyStateHtml();
    return;
  }

  // 行 key 必须基于"在 state.entries 中的下标" —— 用筛选后的下标会导致
  // 筛选状态下「复制 JSON」取到另一条记录
  const indexInState = new Map(state.entries.map((item, index) => [item, index]));
  tbody.innerHTML = filtered
    .map((entry) => rowHtml(entry, `${entryKey(entry)}|${indexInState.get(entry)}`))
    .join("");
};

/** 底部计数 */
const renderFooter = (filtered) => {
  const el = document.getElementById("auditCountHint");
  if (!el) return;
  const total = state.entries.length;
  el.textContent =
    filtered.length === total
      ? `共 ${total} 条`
      : `显示 ${filtered.length} 条 / 共 ${total} 条`;
};

const loadLogs = async () => {
  try {
    const res = await global.ipcRenderer.invoke(`${AUDIT_IPC_BASE}.getLogs`, {
      limit: FETCH_LIMIT,
    });
    if (!res.success || !res.data) {
      console.error("[HugoAura / Audit / Error] Failed to load logs:", res);
      return;
    }
    const merged = res.data.cloud.concat(res.data.peek);
    // 旧日志的 channel 可能是整条 WS URL, 归一化后再展示/筛选
    for (const entry of merged) entry.channel = shortChannelOf(entry.channel);
    merged.sort((a, b) => {
      const ta = new Date(a.ts).getTime() || 0;
      const tb = new Date(b.ts).getTime() || 0;
      return tb - ta;
    });
    state.entries = merged.slice(0, MAX_IN_MEMORY);
    renderEntries();
  } catch (err) {
    console.error("[HugoAura / Audit / Error] Failed to invoke getLogs:", err);
  }
};

/** 复制文本到剪贴板 (优先用 Electron clipboard, 回退到 navigator) */
const copyText = async (text) => {
  try {
    if (
      global.__HUGO_AURA_ELECTRON__ &&
      global.__HUGO_AURA_ELECTRON__.clipboard
    ) {
      global.__HUGO_AURA_ELECTRON__.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到 navigator 分支
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.error("[HugoAura / Audit / Error] Clipboard write failed:", err);
    return false;
  }
};

/** 导出全部审计日志 (主进程按时间正序拼好的 JSONL 文本) */
const exportLogs = async () => {
  try {
    const res = await global.ipcRenderer.invoke(`${AUDIT_IPC_BASE}.exportLogs`, {
      limit: EXPORT_LIMIT,
    });
    if (!res.success || !res.data) {
      window.alert("导出失败: " + ((res && res.error) || "未知错误"));
      return null;
    }
    return res.data;
  } catch (err) {
    console.error("[HugoAura / Audit / Error] Failed to invoke exportLogs:", err);
    window.alert("导出失败: " + String(err));
    return null;
  }
};

const downloadLogs = async () => {
  const data = await exportLogs();
  if (!data) return;
  if (data.count === 0) {
    window.alert("当前没有可导出的审计记录。");
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const blob = new Blob([data.text], { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `hugoaura-audit-${stamp}.jsonl`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};

const clearLogs = async () => {
  const confirmed = window.confirm(
    "确定要清空全部指令审计日志吗?\n此操作将删除云端指令与窥屏审计的全部记录。"
  );
  if (!confirmed) return;

  try {
    const res = await global.ipcRenderer.invoke(`${AUDIT_IPC_BASE}.clearLogs`, {
      target: "all",
    });
    if (res.success) {
      state.entries = [];
      renderEntries();
    } else {
      console.error("[HugoAura / Audit / Error] Failed to clear logs:", res);
      window.alert("清空日志失败: " + (res.error || "未知错误"));
    }
  } catch (err) {
    console.error("[HugoAura / Audit / Error] Failed to invoke clearLogs:", err);
    window.alert("清空日志失败: " + String(err));
  }
};

// 模块级: 记录变化时的回调 (由 initAuditSubPage 注入, 用于重建通道下拉)
let onEntriesChanged = null;

const installListener = () => {
  if (state.listenerInstalled) return;
  state.listenerInstalled = true;

  global.ipcRenderer.on(CHANNEL_ON_LOG, (_event, payload) => {
    const record = payload && payload.record;
    if (!record) return;
    const entry = { ...record };
    entry.channel = shortChannelOf(entry.channel);
    if (!entry._logType) {
      entry._logType =
        entry.action === "peek_start" || entry.action === "peek_stop"
          ? "peek"
          : entry._logType === "powerOff"
          ? "powerOff"
          : "cloud";
    }
    state.entries.unshift(entry);
    if (state.entries.length > MAX_IN_MEMORY) state.entries.pop();
    // 新通道可能在运行中出现, 实时重建通道下拉
    if (onEntriesChanged) onEntriesChanged();
    renderEntries();
  });
};

/** 审计页整体结构 (纯函数: 渲染与离线预览页共用) */
const auditPageTemplate = () => `
    <div class="aura-settings-form aura-audit-form">
      <header class="aura-audit-hero">
        <div class="aura-audit-hero-text">
          <h3 class="aura-audit-hero-title">
            指令审计
            <span class="aura-audit-hero-live" title="采集运行中"></span>
          </h3>
          <p class="aura-audit-hero-desc">
            实时记录云端下发的全部指令 (含所有 WebSocket 通道) 与窥屏检测事件, 点击任意一行展开完整记录。
          </p>
        </div>
        <div class="aura-audit-hero-actions">
          <button
            id="auditRefreshBtn"
            type="button"
            class="aura-audit-icon-btn"
            title="刷新 (重新读取日志)"
          >
            <svg class="aura-audit-btn-svg" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
            </svg>
          </button>
          <button
            id="auditDownloadBtn"
            type="button"
            class="aura-audit-icon-btn"
            title="导出 JSONL 文件"
          >
            <svg class="aura-audit-btn-svg" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
            </svg>
          </button>
          <button
            id="auditClearBtn"
            type="button"
            class="aura-audit-icon-btn aura-audit-icon-btn-danger"
            title="清空全部审计日志"
          >
            <svg class="aura-audit-btn-svg" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
            </svg>
          </button>
        </div>
      </header>
      <section id="auditStatsContainer" class="aura-audit-stats"></section>
      <details class="aura-audit-settings">
        <summary class="aura-audit-settings-summary">
          <span class="aura-audit-settings-caret"></span>
          <span class="aura-audit-settings-title">采集设置</span>
          <span class="aura-audit-settings-sub">全量记录 · 全通道采集 · 出站响应 · 解锁事件 · 保留天数</span>
        </summary>
        <div class="aura-audit-settings-body">
      <div class="aura-settings-entry">
        <div class="aura-settings-entry-info-container">
          <p class="aura-settings-entry-title">全量记录云端指令</p>
          <p class="aura-settings-entry-desc">
            开启后记录所有云端下发指令(不限于更新/窥屏/关机), 便于排查; 关闭后仅记录被拦截的高危指令。
            注意: 关闭此项会同时停止「监控全部 WebSocket 通道」的采集。
          </p>
        </div>
        <div class="aura-settings-entry-operation-area">
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" role="switch" id="auditLogAllSwitch"/>
          </div>
        </div>
      </div>
      <div class="aura-settings-entry">
        <div class="aura-settings-entry-info-container">
          <p class="aura-settings-entry-title">监控全部 WebSocket 通道</p>
          <p class="aura-settings-entry-desc">
            除集控主连接外, 同时采集远程控制 / 病毒服务 / 语音 / 设备绑定等其余 WebSocket 通道的指令。
            这些通道上的指令此前完全不可见, 开启后审计页才能看到完整来源。
          </p>
        </div>
        <div class="aura-settings-entry-operation-area">
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" role="switch" id="auditTapAllSwitch"/>
          </div>
        </div>
      </div>
      <div class="aura-settings-entry">
        <div class="aura-settings-entry-info-container">
          <p class="aura-settings-entry-title">启动时重连以激活采集</p>
          <p class="aura-settings-entry-desc">
            管家的 WebSocket 在连接建立时就把消息回调固化进闭包, 采集器必须等连接重建一次才会生效。
            开启后启动阶段会短暂断开并自动重连各通道 (约 2 秒); 关闭则本机重启前不采集非主连接通道。
          </p>
        </div>
        <div class="aura-settings-entry-operation-area">
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" role="switch" id="auditTapRefreshSwitch"/>
          </div>
        </div>
      </div>
      <div class="aura-settings-entry">
        <div class="aura-settings-entry-info-container">
          <p class="aura-settings-entry-title">记录出站 HTTP 响应</p>
          <p class="aura-settings-entry-desc">
            管家会主动通过 HTTPS 调用本地 SeewoProxyHTTP 代理上报/查询 (如 /api/v1/device/id),
            开启后把这些调用的响应体也写入审计 (方向标记为「出站响应」)。
            这类调用频繁且多数返回 {code:0} 回执, 嫌吵可关闭。
          </p>
        </div>
        <div class="aura-settings-entry-operation-area">
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" role="switch" id="auditHttpSwitch"/>
          </div>
        </div>
      </div>
      <div class="aura-settings-entry">
        <div class="aura-settings-entry-info-container">
          <p class="aura-settings-entry-title">记录解锁事件</p>
          <p class="aura-settings-entry-desc">
            记录远程 / 激活码 / 密码三种解锁方式与时间, 与指令记录写入同一份日志, 便于对照"谁下发了锁屏、谁解锁了"。开启后立即生效。
          </p>
        </div>
        <div class="aura-settings-entry-operation-area">
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" role="switch" id="auditUnlockSwitch"/>
          </div>
        </div>
      </div>
      <div class="aura-settings-entry">
        <div class="aura-settings-entry-info-container">
          <p class="aura-settings-entry-title">记录保留天数</p>
          <p class="aura-settings-entry-desc">
            超过该天数的审计记录将在写入时自动清除, 防止日志无限增长。
          </p>
        </div>
        <div class="aura-settings-entry-operation-area">
          <input class="form-control" type="number" id="auditRetentionDays" min="1" max="365" style="width: 120px"/>
        </div>
      </div>
        </div>
      </details>
      <section class="aura-audit-panel">
        <div class="aura-audit-filters">
          <div class="aura-audit-search" id="auditSearchBox">
            <span class="aura-audit-search-ico" aria-hidden="true">
              <svg viewBox="0 0 16 16">
                <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85zm-5.242 1.156a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/>
              </svg>
            </span>
            <input
              id="auditSearchInput"
              type="text"
              placeholder="搜索指令 / 通道 / 来源 / traceId"
              autocomplete="off"
            />
            <button
              type="button"
              class="aura-audit-search-clear"
              id="auditSearchClear"
              title="清空搜索"
              hidden
            >✕</button>
          </div>
          <button type="button" class="aura-audit-btn aura-audit-search-go" id="auditSearchGo" title="执行搜索">
            搜索
          </button>
          <select id="auditTypeFilter" class="aura-audit-select" title="按动作筛选">
            <option value="all">全部动作</option>
            <option value="captured">已捕获</option>
            <option value="blocked">已拦截</option>
            <option value="logged">全量记录</option>
            <option value="peek_start">窥屏开始</option>
            <option value="peek_stop">窥屏结束</option>
            <option value="unlock">解锁事件</option>
            <option value="passthrough_unlock">解锁已放行</option>
            <option value="passthrough">锁屏已放行</option>
          </select>
          <select id="auditChannelFilter" class="aura-audit-select" title="按通道筛选">
            <option value="all">全部通道</option>
          </select>
          <label class="aura-audit-chip" for="auditOnlyUnknownSwitch" title="只看指令表未收录的未知指令">
            <input type="checkbox" id="auditOnlyUnknownSwitch" class="aura-audit-chip-input"/>
            <span class="aura-audit-chip-dot"></span>仅未识别
          </label>
        </div>
        <div class="aura-audit-table-wrap">
          <table class="aura-audit-table">
            <thead>
              <tr>
                <th style="width: 15%">时间</th>
                <th style="width: 20%">来源 / 通道</th>
                <th style="width: 31%">指令</th>
                <th style="width: 14%">动作</th>
                <th style="width: 11%">耗时</th>
                <th style="width: 9%">操作</th>
              </tr>
            </thead>
            <tbody id="auditTableBody"></tbody>
          </table>
        </div>
        <div class="aura-audit-panel-foot">
          <span id="auditCountHint" class="aura-audit-count">共 0 条</span>
          <span class="aura-audit-logpath" title="审计日志文件位置">
            &lt;HugoAura 数据目录&gt;/logs/cloudCommandAudit.log · screenPeekAudit.log
          </span>
        </div>
      </section>
    </div>`;

const initAuditSubPage = () => {
  const rootEl = document.getElementById("audit-subpage");
  if (!rootEl) return;

  rootEl.innerHTML = auditPageTemplate();

  const searchInput = document.getElementById("auditSearchInput");
  const typeFilter = document.getElementById("auditTypeFilter");
  const channelFilter = document.getElementById("auditChannelFilter");
  const onlyUnknownSwitch = document.getElementById("auditOnlyUnknownSwitch");
  const refreshBtn = document.getElementById("auditRefreshBtn");
  const downloadBtn = document.getElementById("auditDownloadBtn");
  const clearBtn = document.getElementById("auditClearBtn");
  const logAllSwitch = document.getElementById("auditLogAllSwitch");
  const tapAllSwitch = document.getElementById("auditTapAllSwitch");
  const tapRefreshSwitch = document.getElementById("auditTapRefreshSwitch");
  const httpSwitch = document.getElementById("auditHttpSwitch");
  const unlockSwitch = document.getElementById("auditUnlockSwitch");
  const retentionInput = document.getElementById("auditRetentionDays");
  const tableBody = document.getElementById("auditTableBody");

  /** 依据当前记录重建通道下拉项 (保留已选通道) */
  const populateChannelFilter = () => {
    const channels = Array.from(
      new Set(
        state.entries
          .map((e) => e.channel || e._logType)
          .filter((v) => v !== null && v !== undefined && v !== "")
      )
    ).sort();
    const current = state.filterChannel;
    channelFilter.innerHTML =
      '<option value="all">全部通道</option>' +
      channels
        .map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)
        .join("");
    // 已选通道若已不存在则回落到「全部」
    channelFilter.value = channels.includes(current) ? current : "all";
    state.filterChannel = channelFilter.value;
  };

  // 初始化审计配置控件 (读取当前配置)
  const initAuditControls = () => {
    const auraSettings =
      global.__HUGO_AURA_CONFIG__ && global.__HUGO_AURA_CONFIG__.auraSettings;
    if (!auraSettings) return;
    const auditCfg = auraSettings.cloudCommandAudit;
    if (auditCfg) {
      logAllSwitch.checked = !!auditCfg.enabled;
      retentionInput.value = auditCfg.retentionDays || 7;
      // 未显式关闭即视为开启 (与主进程 getAuditConfig 的判定一致)
      tapAllSwitch.checked = auditCfg.tapAllChannels !== false;
      tapRefreshSwitch.checked = auditCfg.refreshOnInstall !== false;
      httpSwitch.checked = auditCfg.auditHttpResponses !== false;
    }
    unlockSwitch.checked = !!(
      auraSettings.unlockAudit && auraSettings.unlockAudit.enabled
    );
  };

  // 保存审计配置 (全量记录 + 解锁事件记录 + 保留天数)
  const saveAuditControls = () => {
    try {
      const auraSettings =
        global.__HUGO_AURA_CONFIG__ && global.__HUGO_AURA_CONFIG__.auraSettings;
      if (!auraSettings) return;
      const auditCfg = auraSettings.cloudCommandAudit;
      if (auditCfg) {
        auditCfg.enabled = logAllSwitch.checked;
        auditCfg.tapAllChannels = tapAllSwitch.checked;
        auditCfg.refreshOnInstall = tapRefreshSwitch.checked;
        auditCfg.auditHttpResponses = httpSwitch.checked;
        const days = parseInt(retentionInput.value, 10);
        auditCfg.retentionDays =
          Number.isFinite(days) && days >= 1 && days <= 365 ? days : 7;
      }
      // 解锁事件审计开关 (unlockAudit hook 每个解锁事件读一次配置, 保存即生效)
      if (auraSettings.unlockAudit) {
        auraSettings.unlockAudit.enabled = unlockSwitch.checked;
      }
      if (global.__HUGO_AURA_CONFIG_MGR__) {
        global.__HUGO_AURA_CONFIG_MGR__.writeConfig(global.__HUGO_AURA_CONFIG__);
      }
    } catch (err) {
      console.error("[HugoAura / Audit / Error] Failed to save audit config:", err);
    }
  };

  // 搜索: 输入即时过滤; 放大镜是真实按钮 (点击聚焦并全选); ✕ 一键清空
  const searchBox = document.getElementById("auditSearchBox");
  const searchGo = document.getElementById("auditSearchGo");
  const searchClear = document.getElementById("auditSearchClear");

  const applySearch = () => {
    const value = searchInput.value.trim().toLowerCase();
    state.filterText = value;
    searchBox.classList.toggle("has-value", value.length > 0);
    if (searchClear) searchClear.hidden = value.length === 0;
    renderEntries();
  };

  searchInput.addEventListener("input", applySearch);
  // 回车 = 执行搜索
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      applySearch();
      searchInput.blur();
    }
  });
  // 「搜索」按钮: 过滤本身是输入即时的, 按钮给一次显式确认
  if (searchGo) {
    searchGo.addEventListener("click", () => {
      applySearch();
      searchInput.blur();
    });
  }
  if (searchClear) {
    searchClear.addEventListener("click", () => {
      searchInput.value = "";
      applySearch();
      searchInput.focus();
    });
  }
  typeFilter.addEventListener("change", (e) => {
    state.filterType = e.target.value;
    renderEntries();
  });
  channelFilter.addEventListener("change", (e) => {
    state.filterChannel = e.target.value;
    renderEntries();
  });
  onlyUnknownSwitch.addEventListener("change", (e) => {
    state.onlyUnknown = e.target.checked;
    // 用类名而不是 :has() —— 管家 Electron 版本未知, 避免选择器兼容问题
    const chip = e.target.closest(".aura-audit-chip");
    if (chip) chip.classList.toggle("is-on", e.target.checked);
    renderEntries();
  });
  refreshBtn.addEventListener("click", async () => {
    await loadLogs();
    populateChannelFilter();
    renderEntries();
  });
  downloadBtn.addEventListener("click", downloadLogs);
  clearBtn.addEventListener("click", clearLogs);
  logAllSwitch.addEventListener("change", saveAuditControls);
  tapAllSwitch.addEventListener("change", saveAuditControls);
  tapRefreshSwitch.addEventListener("change", saveAuditControls);
  httpSwitch.addEventListener("change", saveAuditControls);
  unlockSwitch.addEventListener("change", saveAuditControls);
  retentionInput.addEventListener("change", saveAuditControls);

  // 「详情」按钮: 打开弹出框看完整 JSON
  if (tableBody) {
    tableBody.addEventListener("click", (e) => {
      const btn = e.target.closest(".aura-audit-detail-btn");
      if (!btn) return;
      const key = btn.getAttribute("data-detail");
      const entry = state.entries.find(
        (item, index) => `${entryKey(item)}|${index}` === key
      );
      if (!entry) return;
      openDetailModal(entry);
    });
  }

  initAuditControls();
  installListener();
  onEntriesChanged = populateChannelFilter;
  loadLogs().then(() => {
    populateChannelFilter();
    renderEntries();
  });
};

// >>> 详情弹窗 (Modal) <<< //
//
// 为什么不用行内展开: 窗口固定 880x600 且不可拉伸, 行内展开会把表格撑得
// 忽高忽低、一屏看不全。弹窗独立滚动, 关掉后表格原样不动。

let detailOverlay = null;
let detailKeyHandler = null;

const closeDetailModal = () => {
  if (detailOverlay) {
    detailOverlay.remove();
    detailOverlay = null;
  }
  if (detailKeyHandler) {
    document.removeEventListener("keydown", detailKeyHandler);
    detailKeyHandler = null;
  }
};

const openDetailModal = (entry) => {
  closeDetailModal();

  const overlay = document.createElement("div");
  overlay.innerHTML = detailModalHtml(entry);

  // 点遮罩关闭
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeDetailModal();
  });
  // Esc 关闭
  detailKeyHandler = (e) => {
    if (e.key === "Escape") closeDetailModal();
  };
  document.addEventListener("keydown", detailKeyHandler);
  // 复制 JSON
  const copyBtn = overlay.querySelector(".aura-audit-copy-one");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const ok = await copyText(JSON.stringify(entry, null, 2));
      window.alert(ok ? "已复制该条记录 (JSON)。" : "复制失败。");
    });
  }
  const closeBtn = overlay.querySelector(".aura-audit-modal-close");
  if (closeBtn) closeBtn.addEventListener("click", closeDetailModal);

  // 挂载点: 必须是"窗口大小且不滚动"的容器 (与 authDialog 同一挂法)。
  // 若挂在 body 上, position:fixed 会被管家外层的 transform 劫持,
  // 弹窗就会跑到文档下方; 挂到 .aura-config-page-root 里用 absolute 则始终对准可视区。
  const host =
    document.querySelector(".aura-config-page-root") || document.body;
  if (host === document.body) {
    // 兜底: 找不到管家容器时退回 fixed (至少盖住视口)
    overlay.style.position = "fixed";
  }
  host.appendChild(overlay);
  detailOverlay = overlay;
};

module.exports = {
  initAuditSubPage,
  KNOWN_COMMANDS,
  normalizeHttpPath,
  shortChannelOf,
  // 纯渲染函数: 离线预览 (scripts/audit-preview.js) 与单测共用
  auditPageTemplate,
  statsHtml,
  buildStats,
  rowHtml,
  detailModalHtml,
  emptyStateHtml,
  highlightJson,
  severityOf,
  formatDuration,
  entryMatchesFilters,
  actionMeta,
  commandTextOf,
  isUnknownCommand,
  formatTime,
};
