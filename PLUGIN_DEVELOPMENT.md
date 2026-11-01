# HugoAura 插件开发指南

HugoAura 的插件系统允许通过 zip 包扩展管家功能。本指南描述插件的结构、
能力契约、沙箱边界与发布流程。

> 安全模型一句话: **主进程插件运行在 vm 能力沙箱中（无 require / fs /
> process），只能使用 manifest 声明的能力；UI 插件只能通过声明式 DOM 桥
> 和 `$aura.plugin.*` 白名单 IPC 操作页面。** 沙箱是强化而非硬边界，请
> 仅从可信来源安装插件。

## 插件包结构

```
your-plugin.zip
├── manifest.json     ← 必需, 见下方 schema
└── main.js           ← 必需, 入口脚本 (module.exports = { onLoad, onUnload? })
```

打包要求: 标准 zip（deflate 或 store 均可），单个文件 ≤ 64MB 解压后总量，
条目 ≤ 512，路径不允许 `..` / 盘符 / 绝对路径。

## manifest.json

```json
{
  "id": "com.yourname.yourplugin",
  "name": "插件名称",
  "version": "1.0.0",
  "author": "你的名字",
  "description": "一句话描述插件功能",
  "type": "main",
  "main": "main.js",
  "apiLevel": 1,
  "homepage": "https://github.com/you/your-plugin",
  "configUI": [
    { "key": "interval", "label": "刷新间隔 (秒)", "type": "input",
      "placeholder": "60", "description": "保存后重新启用生效" },
    { "key": "mode", "label": "模式", "type": "select", "options": ["a", "b"] },
    { "key": "enabled", "label": "启用", "type": "switch" }
  ],
  "permissions": [
    { "key": "storage", "label": "私有存储", "description": "读写插件自己的设置" },
    { "key": "network", "label": "联网", "description": "经安全校验的网络请求" },
    { "key": "events",  "label": "事件",   "description": "订阅自己命名空间的事件" }
  ],
  "capabilities": { "events": ["settingsChanged"] }
}
```

- `id`: 全局唯一，`/^[A-Za-z][A-Za-z0-9._-]{2,63}$/`，建议反向域名风格；
- `type`: `main`（主进程）或 `ui`（设置/管家页面 UI）；
- `configUI`: 插件管理页"配置"弹窗的设置项 schema（input/select/switch），
  值持久化在插件私有的 `storage/settings.json`；
- `permissions`: 声明需要的能力。**未声明即不存在**——用户还可以在插件
  详情弹窗里逐项关闭（修改后需停用并重新启用插件生效）。

## main 插件 (主进程, vm 能力沙箱)

```js
var savedCtx = null;
var timerId = null;

module.exports = {
  onLoad(ctx) {
    savedCtx = ctx;

    // 只读配置快照 (settingsPassword* 已脱敏)
    var config = ctx.config.get();

    // 日志 (进入 Aura 日志文件, 带 [HugoAura / Plugin:<id>] 前缀)
    ctx.logger.log("loaded", ctx.auraVersion);

    // [storage 权限] 私有持久化设置 (宿主代管, 无文件系统访问)
    ctx.settings.set({ lastRun: Date.now() });
    var all = ctx.settings.get();
    var one = ctx.settings.get("lastRun");

    // [events 权限] 事件总线: 仅限自己的命名空间 $aura.plugin.<id>.*
    ctx.eventBus.on("$aura.plugin." + ctx.manifest.id + ".settingsChanged",
      function (valuesJson) { /* valuesJson 是 JSON 字符串 */ });

    // 定时器 (≤16 个, 卸载时宿主强制回收; 回调异常被捕获)
    timerId = ctx.timers.setInterval(function () { /* ... */ }, 60000);
  },

  onUnload() {
    if (timerId && savedCtx) savedCtx.timers.clearInterval(timerId);
  },
};
```

沙箱内**不存在** `require` / `process` / `Buffer` / `fs` / `global` /
`document`。宿主函数不可见（跨边界数据一律 JSON 字符串）；未声明权限对应
的 ctx 属性直接不出现（建议 `typeof ctx.net !== "undefined"` 探测后再用）。

### network 能力

```js
ctx.net.fetchText("https://example.com/api").then(function (res) {
  // res = { status: 200, body: "..." } 或 { status: 0, error: "..." }
});
```

仅 http/https GET；localhost / 环回 / 私有 / 保留地址被拒绝；响应 ≤ 1MB、
超时 10s。

## ui 插件 (设置页面, 声明式 DOM 桥)

```js
module.exports = {
  onLoad(ctx) {
    var badge = ctx.dom.createEl("div", {
      class: "my-badge",
      style: "position:fixed;left:12px;bottom:12px;...",
      title: "提示",
    });
    ctx.dom.setText(badge, "你好");
    ctx.dom.appendToBody(badge);
    ctx.dom.on(badge, "click", function () {
      ctx.ipc.invoke("$aura.plugin.list").then(function (res) { /* ... */ });
    });
  },
};
```

- DOM: 仅 `createEl / setText / setAttr / appendToBody / on`，标签 / 属性 /
  事件均在白名单内；真实节点不进入沙箱，卸载时宿主自动移除插件创建的节点；
- IPC: 仅 `$aura.plugin.*` 前缀通道（如 `list` / `getConfig`），其余通道
  返回 `CHANNEL_NOT_ALLOWED`。

## 发布到插件市场

1. fork 本仓库，把你的 zip 放入 `src/aura/market/packages/`；
2. 在 `src/aura/market/plugins.json` 的 `items` 里登记一条（id / 名称 /
   版本 / 作者 / 描述 / 类型 / 主页 / downloadUrl 直链）；
3. 提交并 Pull Request。合并后清单经 jsDelivr / raw 分发（也随 aura 包
   内置离线兜底）。

版本约定: 覆盖安装时低于已装版本会被拒绝；升级请递增 semver 版本号并
同步更新清单。
