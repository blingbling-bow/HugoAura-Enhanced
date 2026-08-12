// @ts-check

/**
 * 指令审计日志可视化 (Audit Log Viewer)
 *
 * 渲染层实现:
 *   - 统计摘要卡片: 总记录 / 已捕获 / 已拦截 / 窥屏开始 / 窥屏结束
 *   - 日志表格: 时间 / 来源 / 通道 / 指令 URL / 动作 / 数据
 *   - 过滤: 关键字 (URL/来源/动作) + 类型筛选
 *   - 刷新 / 清空
 *   - 实时推送: 监听主进程 $aura.audit.onLog 事件即时更新
 */

const AUDIT_IPC_BASE = "$aura.audit";
const CHANNEL_ON_LOG = "$aura.audit.onLog";

// 内存中保留的最大条目数 (防止无限增长)
const MAX_IN_MEMORY = 600;

const state = {
  entries: [],
  filterText: "",
  filterType: "all",
  listenerInstalled: false,
};

// 动作徽标样式
const actionMeta = (entry) => {
  if (entry._logType === "peek") {
    if (entry.action === "peek_start") {
      return entry.blocked
        ? { text: "窥屏已阻止", cls: "danger" }
        : { text: "窥屏开始", cls: "warning" };
    }
    if (entry.action === "peek_stop")
      return { text: "窥屏结束", cls: "secondary" };
  }
  if (entry.action === "blocked") return { text: "已拦截", cls: "danger" };
  if (entry.action === "captured") return { text: "已捕获", cls: "primary" };
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

const matchesFilter = (entry) => {
  const text = state.filterText;
  if (text) {
    const haystack = [
      entry.url,
      entry.source,
      entry.channel,
      entry.action,
      entry._logType,
    ]
      .filter((v) => v != null)
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(text)) return false;
  }
  if (state.filterType === "all") return true;
  return entry.action === state.filterType;
};

const renderStats = (filtered, all) => {
  const count = (pred) => all.filter(pred).length;
  const stats = [
    {
      label: "全部记录",
      value: filtered.length,
      sub: all.length !== filtered.length ? `/ ${all.length}` : "",
      cls: "primary",
    },
    {
      label: "已捕获",
      value: count((e) => e.action === "captured"),
      cls: "info",
    },
    {
      label: "已拦截",
      value: count((e) => e.action === "blocked"),
      cls: "danger",
    },
    {
      label: "窥屏开始",
      value: count((e) => e.action === "peek_start"),
      cls: "warning",
    },
    {
      label: "窥屏结束",
      value: count((e) => e.action === "peek_stop"),
      cls: "secondary",
    },
  ];

  const container = document.getElementById("auditStatsContainer");
  if (!container) return;
  container.innerHTML = stats
    .map(
      (s) => `
      <div class="aura-audit-stat-card aura-audit-stat-${s.cls}">
        <div class="aura-audit-stat-value">${s.value}${s.sub || ""}</div>
        <div class="aura-audit-stat-label">${s.label}</div>
      </div>`
    )
    .join("");
};

const renderTable = (filtered) => {
  const tbody = document.getElementById("auditTableBody");
  if (!tbody) return;

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="text-center text-muted py-4">
          暂无审计记录
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((entry) => {
      const meta = actionMeta(entry);
      const urlText = entry.url || (entry._logType === "peek" ? "/liveclient" : "-");
      const dataStr =
        entry.data != null
          ? JSON.stringify(entry.data).replace(/"/g, "&quot;").slice(0, 200)
          : "";
      return `
      <tr>
        <td class="aura-audit-cell-time">${formatTime(entry.ts)}</td>
        <td class="aura-audit-cell-source">${entry.source || "-"}</td>
        <td><code class="aura-audit-cell-url">${urlText}</code></td>
        <td>
          <span class="badge bg-${meta.cls}">${meta.text}</span>
        </td>
        <td class="aura-audit-cell-data" title="${dataStr}">
          ${dataStr || "-"}
        </td>
      </tr>`;
    })
    .join("");
};

const renderEntries = () => {
  const filtered = state.entries.filter(matchesFilter);
  renderStats(filtered, state.entries);
  renderTable(filtered);
};

const loadLogs = async () => {
  try {
    const res = await global.ipcRenderer.invoke(`${AUDIT_IPC_BASE}.getLogs`);
    if (!res.success || !res.data) {
      console.error("[HugoAura / Audit / Error] Failed to load logs:", res);
      return;
    }
    const merged = res.data.cloud.concat(res.data.peek);
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

const installListener = () => {
  if (state.listenerInstalled) return;
  state.listenerInstalled = true;

  global.ipcRenderer.on(CHANNEL_ON_LOG, (_event, payload) => {
    const record = payload && payload.record;
    if (!record) return;
    const entry = { ...record };
    if (!entry._logType) {
      entry._logType =
        entry.action === "peek_start" || entry.action === "peek_stop"
          ? "peek"
          : "cloud";
    }
    state.entries.unshift(entry);
    if (state.entries.length > MAX_IN_MEMORY) state.entries.pop();
    renderEntries();
  });
};

const initAuditSubPage = () => {
  const rootEl = document.getElementById("audit-subpage");
  if (!rootEl) return;

  rootEl.innerHTML = `
    <div class="aura-settings-form aura-audit-form">
      <p class="aura-settings-category-header">指令审计</p>
      <div class="aura-settings-entry">
        <div class="aura-settings-entry-info-container">
          <p class="aura-settings-entry-title">审计日志概览</p>
          <p class="aura-settings-entry-desc">
            实时记录云端下发指令与窥屏检测事件, 支持搜索过滤与详情查看。
          </p>
        </div>
      </div>
      <div id="auditStatsContainer" class="aura-audit-stats"></div>
      <hr class="aura-settings-hr-horizontal"/>
      <div class="aura-settings-entry">
        <div class="aura-settings-entry-info-container">
          <p class="aura-settings-entry-title">指令记录</p>
          <p class="aura-settings-entry-desc">
            按时间倒序排列, 最多保留 600 条记录。
          </p>
        </div>
      </div>
      <div class="aura-audit-toolbar">
        <div class="aura-audit-toolbar-search">
          <input
            id="auditSearchInput"
            class="form-control form-control-sm"
            type="text"
            placeholder="搜索: URL / 来源 / 动作..."
            autocomplete="off"
          />
        </div>
        <select id="auditTypeFilter" class="form-select form-select-sm aura-audit-toolbar-select">
          <option value="all">全部类型</option>
          <option value="captured">已捕获</option>
          <option value="blocked">已拦截</option>
          <option value="peek_start">窥屏开始</option>
          <option value="peek_stop">窥屏结束</option>
        </select>
        <button id="auditRefreshBtn" type="button" class="btn btn-sm btn-outline-primary">
          刷新
        </button>
        <button id="auditClearBtn" type="button" class="btn btn-sm btn-outline-danger">
          清空日志
        </button>
      </div>
      <div class="aura-audit-table-wrap">
        <table class="table table-sm table-hover aura-audit-table">
          <thead>
            <tr>
              <th style="width: 150px">时间</th>
              <th style="width: 150px">来源</th>
              <th>指令 URL</th>
              <th style="width: 110px">动作</th>
              <th style="width: 35%">数据</th>
            </tr>
          </thead>
          <tbody id="auditTableBody"></tbody>
        </table>
      </div>
      <p class="aura-settings-entry-desc aura-audit-hint">
        审计日志文件位于: &lt;HugoAura 数据目录&gt;/logs/cloudCommandAudit.log 与 screenPeekAudit.log
      </p>
    </div>`;

  const searchInput = document.getElementById("auditSearchInput");
  const typeFilter = document.getElementById("auditTypeFilter");
  const refreshBtn = document.getElementById("auditRefreshBtn");
  const clearBtn = document.getElementById("auditClearBtn");

  searchInput.addEventListener("input", (e) => {
    state.filterText = e.target.value.trim().toLowerCase();
    renderEntries();
  });
  typeFilter.addEventListener("change", (e) => {
    state.filterType = e.target.value;
    renderEntries();
  });
  refreshBtn.addEventListener("click", loadLogs);
  clearBtn.addEventListener("click", clearLogs);

  installListener();
  loadLogs();
};

module.exports = { initAuditSubPage };
