# HugoAura 插件开发规格 (AI 可直接依据本文件生成插件)

> 本文件是插件系统的**完整契约**。把整份文件提供给 AI 助手, 并附一句任务
> 描述 (例: "写一个每 30 分钟提醒喝水的插件"), AI 即可产出可直接安装的
> 合法插件。人类开发者同样按本文件实现。

---

## 0. 生成前必读的硬性约束 (违反 = 插件无法加载)

1. 插件包为标准 zip, 根目录**必须**包含 `manifest.json` 与 `main.js`;
2. `main.js` 以 `module.exports = { onLoad, onUnload? }` 结尾;
3. main 插件运行在 vm 能力沙箱中, **以下标识符不存在**:
   `require` / `process` / `Buffer` / `fs` / `global` / `document` /
   `window` / `electron` / `setInterval`(裸形式) —— 一律通过 `ctx.*` 使用;
4. 能力由 `manifest.permissions` 声明: 未声明的能力在 `ctx` 上**不存在**
   (不是报错, 是 undefined)。声明后用户仍可在详情弹窗逐项关闭;
5. 事件只能使用自己的命名空间: `$aura.plugin.<manifest.id>...`,
   其他命名空间抛 `EVENT_NAMESPACE_DENIED`;
6. 资源上限: 定时器 ≤16、快捷键 ≤8、单条日志 ≤2000 字符、
   网络响应 ≤1MB / 10s、加载评估限时 3 秒 (禁止加载期死循环);
7. UI 插件不能直接操作 DOM: 只能通过 `ctx.dom` 声明式桥;
8. 跨边界数据: `settings` / `net` / `ipc` 的返回值是**已解析的对象**
   (沙箱已代为 JSON 解析), 但 `eventBus` 回调收到的是 **JSON 字符串**,
   需要自行 `JSON.parse`。

## 1. manifest.json (完整 schema)

```json
{
  "id": "com.yourname.pluginname",
  "name": "显示名 (≤64 字符)",
  "version": "1.0.0",
  "author": "作者",
  "description": "一句话描述 (≤200 字符)",
  "type": "main",
  "main": "main.js",
  "apiLevel": 1,
  "homepage": "https://github.com/you/repo",
  "configUI": [
    {
      "key": "intervalSeconds",
      "label": "间隔 (秒)",
      "type": "input",
      "placeholder": "60",
      "description": "保存后重新启用插件生效",
      "defaultValue": "60"
    },
    { "key": "mode", "label": "模式", "type": "select",
      "options": ["简洁", "详细"] },
    { "key": "verbose", "label": "详细日志", "type": "switch" }
  ],
  "permissions": [
    { "key": "storage",  "label": "私有存储", "description": "读写插件自己的设置" },
    { "key": "events",   "label": "事件",     "description": "订阅自己命名空间的事件" },
    { "key": "network",  "label": "联网",     "description": "经安全校验的 HTTP GET" },
    { "key": "notify",   "label": "通知",     "description": "弹出 Aura 全局提醒" },
    { "key": "shortcuts","label": "快捷键",   "description": "注册全局快捷键" }
  ],
  "capabilities": { "events": ["settingsChanged"] }
}
```

校验规则 (validateManifest, 违反即拒绝安装):
- `id`: `/^[A-Za-z][A-Za-z0-9._-]{2,63}$/` (不含 `/` `\`, 不允许纯符号);
- `type`: `main` 或 `ui`; `main`: 必须以 `.js` 结尾且不含路径分隔符;
- `configUI[].type`: `input` | `select`(必须带 `options`) | `switch`;
- `permissions[].key`: 见第 2 节; 未支持的 key 会被忽略并告警;
- `version`: 覆盖安装时低于已装版本会被拒绝 (semver 递增);
- `homepage`: 仅接受 https。

## 2. 权限 → 能力对照

| 权限 key | main 插件获得 | ui 插件获得 |
|---|---|---|
| `storage` | `ctx.settings.get/set` | — |
| `events` | `ctx.eventBus.on/off/emit` | — |
| `network` | `ctx.net.fetchText` | — |
| `notify` | `ctx.notify` | — |
| `shortcuts` | `ctx.shortcuts.register/unregister` | — |
| (ui 类型) | — | `ctx.dom.*` + `ctx.ipc.invoke` (`$aura.plugin.*` 白名单) |

## 3. main 插件 ctx API (精确签名)

```ts
ctx = {
  manifest: Readonly<{ id, name, version, ... }>,   // 深冻结
  auraVersion: string,                               // 例 "v0.3.3"
  config: {
    get(): object            // Aura 全配置只读快照; auraSettings.settingsPassword* 已脱敏
  },
  logger: {
    log/info/warn/error: (...args) => void   // 进入 Aura 日志文件, 单条 ≤2000 字符
  },
  timers: {
    setTimeout(cb: () => void, ms: number): number | null,   // ≤16 个, 卸载强制回收
    setInterval(cb: () => void, ms: number): number | null,  // ms 上限 60000
    clearTimeout(id): void,
    clearInterval(id): void,
  },

  // ↓ 以下各项仅在 manifest.permissions 声明对应 key 后存在 (否则 undefined)

  // [storage]
  settings: {
    get(key?: string): any,               // 无参 = 全部对象; 有参 = 单值
    set(values: object): object,          // 整体覆盖写入, ≤256KB
  },
  // [events] 命名空间: $aura.plugin.<manifest.id> 与其子通道, 其余拒绝
  eventBus: {
    on(event: string, cb: (payloadJson: string) => void): void,
    off(event: string, cb: (payloadJson: string) => void): void,
    emit(event: string, payload: any): void,
    // 注意: cb 收到的是 JSON 字符串, 需 JSON.parse;
    // 内置事件: "$aura.plugin.<id>.settingsChanged" (用户在配置弹窗保存时)
  },
  // [network] 仅 http/https GET; localhost/内网/保留地址被拒; 响应 ≤1MB/10s
  net: {
    fetchText(url: string): Promise<{ status: number, body?: string, error?: string }>,
  },
  // [notify] 独立置顶提醒小窗 (不抢焦点; title 必填, 自动带插件署名;
  //          展示时长钳制 3s-60s)
  notify: {
    (title: string, message?: string, durationMs?: number): boolean
  },
  // [shortcuts] 全局快捷键 (进程级; ≤8 个, 卸载强制注销)
  shortcuts: {
    register(accelerator: string, cb: () => void): number | null,  // null = 注册失败/超限
    unregister(id: number): boolean,
  },
}
```

错误码 (宿主分发层抛出): `PERMISSION_DENIED: <key>` / `EVENT_NAMESPACE_DENIED: <event>` /
`NOT_AVAILABLE` / `INVALID_SETTINGS` / `SETTINGS_TOO_LARGE` / `CALLBACK_REQUIRED` /
`INVALID_ACCELERATOR` / `UNKNOWN_HOST_METHOD`。

## 4. ui 插件 ctx API (精确签名)

```ts
ctx = {
  manifest: Readonly<...>,
  auraVersion: string,
  logger: { log/info/warn/error },
  timers: { 同 main },
  dom: {
    createEl(tag: string, attrs?: {
      class?: string, title?: string, style?: string,
      src?: string, href?: string,
    }): number,                          // 返回节点 id (真实节点不进沙箱)
    setText(id: number, text: string): void,
    setAttr(id: number, attrs: object): void,
    appendToBody(id: number): void,
    on(id: number, event: "click" | "mouseenter" | "mouseleave",
       cb: () => void): void,
  },
  ipc: {
    invoke(channel: string, payload?: any): Promise<any>,
    // 仅 $aura.plugin.* 前缀; 其余通道返回 { success: false, error: "CHANNEL_NOT_ALLOWED" }
  },
}
```

## 5. 完整示例 A —— main 插件 (定时提醒)

```js
// manifest.json: type "main"; permissions: storage, events, notify, shortcuts
var savedCtx = null;
var timerId = null;
var shortcutId = null;
var count = 0;

module.exports = {
  onLoad(ctx) {
    savedCtx = ctx;
    ctx.logger.log("loaded, aura:", ctx.auraVersion);

    var interval = Number(ctx.settings.get("intervalSeconds")) || 1800;
    timerId = ctx.timers.setInterval(function () {
      count += 1;
      ctx.notify("休息提醒", "已运行 " + count + " 个周期", 8000);
    }, Math.max(interval, 30) * 1000);

    shortcutId = ctx.shortcuts.register("CommandOrControl+Shift+B", function () {
      ctx.notify("手动触发", "当前计数 " + count, 5000);
    });
  },
  onUnload() {
    if (timerId && savedCtx) savedCtx.timers.clearInterval(timerId);
    if (shortcutId && savedCtx) savedCtx.shortcuts.unregister(shortcutId);
  },
};
```

## 6. 完整示例 B —— ui 插件 (页面徽章)

```js
// manifest.json: type "ui"; 无需 permissions
module.exports = {
  onLoad(ctx) {
    var id = ctx.dom.createEl("div", {
      style: "position:fixed;left:12px;bottom:12px;z-index:2147483646;" +
             "background:rgba(33,143,255,.92);color:#fff;padding:6px 12px;" +
             "border-radius:999px;font:12px sans-serif;cursor:pointer;",
    });
    ctx.dom.setText(id, "Hello v" + ctx.manifest.version);
    ctx.dom.appendToBody(id);
    ctx.dom.on(id, "click", function () {
      ctx.ipc.invoke("$aura.plugin.list").then(function (res) {
        ctx.dom.setText(id, "插件数: " + ((res && res.data) || []).length);
      });
    });
  },
};
```

## 7. 常见错误 (AI 生成时的高频坑)

| 错误写法 | 后果 | 正确写法 |
|---|---|---|
| `setInterval(...)` 裸调用 | ReferenceError | `ctx.timers.setInterval(...)` |
| `require("fs")` / `process.env` | ReferenceError | 用 `ctx.settings` / `ctx.config.get` |
| onUnload 里用 `ctx` | ReferenceError (onUnload 无参) | onLoad 里 `savedCtx = ctx` 存闭包 |
| eventBus 回调直接当对象用 | 拿到的是 JSON 字符串 | `JSON.parse(payloadJson)` |
| 订阅 `$aura.config.refreshConfig` | EVENT_NAMESPACE_DENIED | 只订阅自己命名空间 |
| `if (ctx.net)` 未声明就调用 | undefined (未授权即不存在) | `typeof ctx.net !== "undefined"` 探测 |
| 加载期 `while(true)` 轮询 | 3 秒超时, 加载失败 | 用 `ctx.timers.setInterval` |
| 节点引用 DOM 元素 | 沙箱内没有元素, 只有 id | 一律用 `ctx.dom` 的 id API |

## 8. 打包与自检清单

1. zip 根目录: `manifest.json` + `main.js` (扁平, 不套文件夹);
2. `node --check main.js` 通过;
3. main.js 内不得出现 `require` / `process` / `Buffer` / `document`;
4. 声明的每个 permission 都在代码里真实使用 (用户会审查权限);
5. onLoad 幂等 (重复调用不重复挂载); onUnload 清理全部定时器/快捷键;
6. 覆盖安装需递增 `version`。

## 9. 发布

1. fork 仓库 → zip 放入 `src/aura/market/packages/<id>.zip`;
2. `src/aura/market/plugins.json` 的 `items` 登记一条
   (可附 `sha256`: 包文件的 SHA-256, 安装链会做完整性校验);
3. Pull Request → 合并后清单经 jsDelivr / raw 分发 (aura 包内另有离线兜底)。

安装方式 (测试): 设置 → 插件管理 → 本地导入 zip → 确认 → 启用。
