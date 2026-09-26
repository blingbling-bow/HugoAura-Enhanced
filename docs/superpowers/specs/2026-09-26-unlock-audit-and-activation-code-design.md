# 解锁审计与激活码不换码 — 设计文档

| 项 | 内容 |
|---|---|
| 日期 | 2026-09-26 |
| 状态 | 待评审 |
| 范围 | HugoAura-Enhanced（基线：希沃管家 SeewoServiceAssistant 1.6.7.4010） |
| 代号 | unlock-audit-and-activation-code |

---

## 1. 背景

锁屏的解锁方式列表由渲染侧组件决定：扫码 / 激活码 / 密码，另可选「直接」（`showDirectUnlock`）。两条现状构成本次需求：

**1.1 激活码有本地重试惩罚。**
渲染侧 `checkPasswordCorrect` 内的 `originalAuthFailed` 维护 `failCount`，到达 5 次时弹「激活码错误次数过多，请重新扫码」并调用 `setNewQrcode()` 换一个新码，旧码作废、必须重新扫码。该限制**完全在本地**：6 位码由 `Math.random()` 在设备上生成、用 RSA 公钥加密后编入二维码，校验是本地 `inputPassword.join("") === o.password` 字符串比对，与云端无关。

**1.2 解锁事件没有任何记录。**
三条解锁路径在模块 33（`screenLockController` 单例）的 `stopLockTask` 汇聚，并以 `actionOperator` 区分方式（1 / 2 / 3）。当前项目只记录了锁屏**下发**（`lockScreenInterceptor` 写 `cloudCommandAudit.log`）和云端指令，缺少「谁在何时以何种方式解锁」这一半。

---

## 2. 目标与非目标

### 2.1 目标

1. 打开开关后，激活码输错不再触发换码，一次扫码可反复尝试（仍显示「激活码错误」提示）。
2. 打开开关后，每次解锁事件写入审计日志，包含解锁方式、`actionOperator`、`operationLogId`，并能区分「真实解锁」与「无锁时的冗余解锁指令」。

### 2.2 非目标（本次明确不做）

| 不做的事 | 原因 |
|---|---|
| 解除密码输入次数限制 | 密码冻结有两条来源：本地连错 5 次（模块 348 计 `_ERROR_COUNT`，第 5 次起广播 600 秒 `_FEEDBACK`）与云端限流（响应 `choked` → 模块 349）。后者判定在云端，`choked` 表示云端根本未评估本次请求，本地无法解除；只解除本地那层会让「输对了也过不去」更难解释，故整体不做。 |
| 给锁屏密码页签加本地判定兜底 | 现有 `rewrite["vendor/passwordValidation"]`（自定义密码 / 任意密码）监听 `adminPasswordValidationResult`，作用于**管家身份验证组件**；锁屏密码页签监听 `passwordAuthenResult`，是另一条链路。补齐它属于新能力，需单独立项。 |
| 改变 admin 模式（`actionType === 3`）隐藏密码页签的行为 | 该路径与 `hasNetworkHidePasswordBlock` 无关（由 `handleChangeHidePassword` 本地置 `adminHidePassword`）。改写 `mode` 会把 `actionType` 传导进激活码二维码的 `_pki` 参数（服务端可见），需另行评估后再定，本次不动。 |
| 记录解锁失败尝试 | 需要额外挂载模块 346 与渲染侧事件，暂无明确需求。 |
| 新建独立日志文件 / 在审计查看页新增独立页签 | 见 §5.3 的取舍说明。本次仅在既有审计页内增加 `unlock` 类型的行渲染与筛选项，不新增页签、不新增文件读取分支。 |

---

## 3. 配置

| 开关 | 配置键 | 默认 | 消费方 | 生效时机 |
|---|---|---|---|---|
| 激活码不换码 | `rewrite["vendor/screenLock"].noActivationCodeReset` | `false` | 渲染侧 jsRewrite | 下次锁屏窗口创建时 |
| 解锁审计 | `auraSettings.unlockAudit.enabled` | `false` | 主进程 hook | 立即（每个事件读取一次配置） |

两个键都加入 `src/aura/init/shared/default.json`，由既有 `deepMerge` 并入用户配置。

`noActivationCodeReset` 放在 `rewrite["vendor/screenLock"]` 下的理由：该 jsRewrite 模块已把整个对象读入 `__config`（`src/aura/jsRewrite/vendor/screenLock.js` 第 9 行），新增字段零管线成本，且与同文件内 `fastfail` / `showDirectUnlock` / `authRewriteType` 的既有约定一致。

生效时机不需要「重载页面」提示：锁屏窗口每次锁屏均重新创建（模块 33 `startLock()` → `s.addOne("screenLock", ...)`），窗口加载时自然读到新配置，用户感知等同于立即生效。

---

## 4. 实现：激活码不换码（渲染侧）

**文件**：`src/aura/jsRewrite/vendor/screenLock.js`

**改动点**：`checkPasswordCorrect` 内的 `originalAuthFailed`（位于该文件 `// ### BOR ### //` … `// ### EOR ### //` 区块内）。

现状：

```js
const originalAuthFailed = () => {
  o.failCount++,
    o.passwordCheckFail(),
    5 <= o.failCount &&
      o.setState(
        { passwordError: !0, passwordText: "激活码错误次数过多，请重新扫码" },
        function () {
          o.setNewQrcode(), (o.failCount = 0);
        }
      );
};
```

改为在函数体开头短路：

```js
if (__config.enabled && __config.noActivationCodeReset) {
  o.passwordCheckFail();
  return;
}
```

**要点**

- 保留 `o.passwordCheckFail()`：即「激活码错误」提示与输入清空重试的行为不变，只是不再计数、不再换码。
- 必须同时判断 `__config.enabled`（该 rewrite 规则的总开关，对应「屏幕锁」分类里的 `enableScreenLockOverride`），与文件内其他分支的写法一致。
- `o.state.inputPassword.join("") === o.password` 的本地主比对、以及 `customAuthFailed()` 的自定义激活码分支结构均不变。
- `setNewQrcode()` 的另外两个调用点（组件挂载时的 `componentDidMountFunc`、`actionType` 变化时的 `componentDidUpdate`）不受影响，激活码仍会正常生成。

---

## 5. 实现：解锁审计（主进程）

**新文件**：`src/aura/mainProcess/hooks/unlockAudit.js`

**注册**：`src/core/hook.js` 中新增

```js
installHook("UnlockAudit", "../aura/mainProcess/hooks/unlockAudit");
```

导出与结构对齐同目录 `keepPasswordUnlock.js`：`const hookFn = (central) => { ... }` 与 `module.exports = { hookFunc: hookFn }`。

### 5.1 挂载点

模块 33 单例（`screenLockController`）的原型方法 `stopLockTask`。它是三条解锁路径的唯一汇聚点：

| `actionOperator` | 来源 | 触发链 |
|---|---|---|
| 1 | 远程解锁指令 | 模块 399 → 模块 33 `onMessage`（`messageType === 1211` 且 `data.screenLockStatus === 0`）→ `stopLockTask({ actionOperator: 1, operationLogId })` |
| 2 | 激活码解锁成功 | 渲染侧 `send("stopScreenLock", true)` → 模块 380 → `unlockAction(2)` |
| 3 | 密码解锁成功 | 渲染侧 `send("stopScreenLock", false)` → 模块 380 → `unlockAction(3)` |

### 5.2 安装与自检

- `withRetry(tryInstall, { label: "UnlockAudit" })()`；模块未就绪时延迟重试（同 `keepPasswordUnlock`）。
- `resolveModule(central, 33)` 取实例；`getPrototypeMethod(handler, "stopLockTask")` 取原型方法（模块 33 是匿名类单例，方法挂在原型上）。
- 自检特征串：`String(original).includes("unlockStreamControl")`（`stopLockTask` 内 `tslKey` 的字面量）。自检失败只打一次诊断日志并优雅降级，不挂钩子。
- 包装在自检通过后立即就位，**不受开关当前取值影响**（开关只决定是否写入日志）。因此开关可随时热更新，无需监听 `$aura.config.refreshConfig`。

### 5.3 记录

包装函数保持签名 `stopLockTask(arg)`，执行顺序：

1. **调用前取快照** `hadLock = !!this.message || (Array.isArray(this.windows) && this.windows.length > 0)`。必须在调用前取样，因为原方法内部会清空 `message` 与 `windows`。
2. 以 `original.call(this, arg)` 调用原方法（`stopLockTask` 内部依赖 `this.message` / `this.windows` / `this.closeWindow()`；模块 33 是单例，`this` 即 `handler`，用 `this` 可兼容潜在的多实例）。若抛错：不写日志，异常原样抛出（不改变原生行为）。
3. 原方法正常返回后，若 `isEnabled()` 为真，写一条记录。

记录结构（JSON Lines，由 `auditWriter.writeAudit` 追加）：

```json
{"ts":"2026-09-26T11:03:11.482Z","channel":"screenLockController","action":"unlock","method":"password","actionOperator":3,"operationLogId":"0","hadLock":true,"_logType":"unlock"}
```

| 字段 | 取值 |
|---|---|
| `ts` | `new Date().toISOString()` |
| `channel` | 固定 `"screenLockController"`，与 `lockScreenInterceptor` 的记录一致 |
| `action` | 固定 `"unlock"` |
| `method` | `1 → "remote"`、`2 → "activationCode"`、`3 → "password"`、其他 → `"unknown"` |
| `actionOperator` | `arg` 为对象且 `arg.actionOperator` 是数字时取原值，否则为 `null` |
| `operationLogId` | `arg` 为对象且含该字段时取原值，否则 `"0"` |
| `hadLock` | 见上，用于区分真实解锁与无锁时的冗余解锁指令 |
| `_logType` | 固定 `"unlock"`，供审计查看页分类 |

写入文件：`cloudCommandAudit.log`（经 `auditWriter`，复用其 5 MB 轮转）。

**为什么复用 `cloudCommandAudit.log`**

- 与 `lockScreenInterceptor` / `powerOffInterceptor` / `cloudUpdateInterceptor` 的既有约定一致：同一共享写入器、同一轮转策略，不引入第二个文件句柄。
- 锁屏指令（`_logType: "lockScreen"`）与解锁事件（`_logType: "unlock"`）落在同一条时间线上，便于对照「几点拦截了锁屏 / 几点有人解锁」。
- 代价：解锁事件与云端指令混在同一文件，需按 `_logType` 区分。可接受 —— `auditWriter` 的注释已明确「按文件名统一入口」正是为避免多句柄在 Windows 上互相打架。

### 5.4 fail-soft

- 审计写入失败只记录 `console.error`，不抛错、不阻断解锁。
- `isEnabled()` 读取配置失败时按「未启用」处理。
- 自检失败时不挂钩子，行为与原生完全一致。

---

## 6. UI 改动

### 6.1 `src/aura/ui/pages/configSubPages/disableLimitations/settings/auth.js`

**（a）分类「屏幕锁」（`id: 1`）末尾新增条目**

| 字段 | 值 |
|---|---|
| `id` | `"noActivationCodeReset"` |
| `type` | `"switch"` |
| `name` | `"激活码输错不换码"` |
| `description` | 「默认行为: 激活码连错 5 次会更换新码, 需重新扫码。开启后一次扫码可反复尝试, 仍会提示激活码错误」 |
| `restart` / `reload` | `false` / `false` |
| `associateVal` | `["rewrite.vendor/screenLock.enabled"]` |
| `auraIf` | `() => global.__HUGO_AURA_CONFIG__.rewrite["vendor/screenLock"].enabled` |
| `defaultValue` | `false` |
| `valueGetter` / `callbackFn` | 读写 `global.__HUGO_AURA_CONFIG__.rewrite["vendor/screenLock"].noActivationCodeReset`（写前判 `typeof newVal !== "boolean"` 直接 return，与同分类既有条目一致） |

**（b）新增分类「解锁审计」（`id: 8`，接在 `id: 7`「远程锁屏」之后）**

| 字段 | 值 |
|---|---|
| `categoryName` | `"解锁审计"` |
| 条目 `id` | `"enableUnlockAudit"` |
| `type` | `"switch"` |
| `name` | `"记录解锁事件"` |
| `description` | 「记录远程 / 激活码 / 密码三种解锁方式与时间, 写入 logs/cloudCommandAudit.log」 |
| `restart` / `reload` | `false` / `false` |
| `associateVal` | `null` |
| `auraIf` | `() => true` |
| `defaultValue` | `false` |
| `valueGetter` / `callbackFn` | 读写 `global.__HUGO_AURA_CONFIG__.auraSettings.unlockAudit.enabled` |

### 6.2 `src/aura/ui/pages/configSubPages/preferences/settings/auditLog.js`

新增 `_logType === "unlock"` 的处理：

- 行摘要渲染：与既有 `lockScreen` 分支并列，展示解锁方式（`method` 的中文名：远程 / 激活码 / 密码）与 `hadLock`。
- 类型筛选：新增一项按 `_logType === "unlock"` 统计的计数项。

不做：新增独立页签、新增独立日志文件读取。

### 6.3 `src/aura/init/shared/default.json`

```json
{
  "rewrite": {
    "vendor/screenLock": {
      "noActivationCodeReset": false
    }
  },
  "auraSettings": {
    "unlockAudit": {
      "enabled": false
    }
  }
}
```

（片段示意，实际改动为在既有对象内追加这两个键，其余键保持不变。）

---

## 7. 测试与验证

### 7.1 自动化：新增 `test/unlockAudit.test.js`

用 `node:test` + `node:assert/strict`，桩 `central`（返回带原型 `stopLockTask` 的单例）与桩 `auditWriter`，覆盖：

1. 开关关闭：解锁事件不写日志，且包装不改变原方法返回值。
2. 开关打开：`actionOperator` 为 1 / 2 / 3 时 `method` 分别为 `remote` / `activationCode` / `password`；非法值落 `unknown`。
3. `hadLock` 在调用前取样：原方法把 `message` 置空、`windows` 清空后，记录里仍为 `true`。
4. 原方法抛错：不写日志，异常原样抛出。
5. 自检失败（原型方法不含 `unlockStreamControl`）：不包装、不写日志、不抛错。
6. `arg` 非对象（如 `undefined`）时 `operationLogId` 落 `"0"`、`actionOperator` 落 `null`、`method` 落 `"unknown"`，且不抛错。

### 7.2 手工验证（渲染侧改写无法单测）

`src/aura/jsRewrite/vendor/screenLock.js` 是整模块替换规则（`module.exports = { feature, method, methodArg, newFunction }`），不像 `src/aura/jsRewrite/network/appearance/customScreenLockBg.js` 那种 `ruleFn` 文本替换可以按锚点单独求值，因此无法在测试中独立执行。

| # | 操作 | 期望 |
|---|---|---|
| 1 | 开关打开，进入激活码页签，连续输错 6 次 | 二维码不刷新，仍可继续输入，每次提示「激活码错误」 |
| 2 | 开关关闭，连续输错 5 次 | 出现「激活码错误次数过多，请重新扫码」且二维码刷新（与原生一致） |
| 3 | 审计开关关闭时用密码 / 激活码解锁 | 不产生 `_logType: "unlock"` 记录 |
| 4 | 审计开关打开后分别用密码、激活码解锁 | 各产生一条记录，`method` 与实际方式一致，`hadLock` 为 `true` |
| 5 | 在「偏好设置 → 审计日志」查看 | 能看到 `unlock` 类型记录，筛选计数正确 |

### 7.3 回归

全量 `node --test`（基线 59 个用例）必须全部通过。

---

## 8. 风险

| 风险 | 影响 | 处理 |
|---|---|---|
| 管家升级后模块 33 方法名或特征串变化 | 审计静默失效（不崩溃） | 自检失败时打诊断日志并放弃挂钩子，而非误挂 |
| 管家升级后渲染侧 bundle 结构变化 | 激活码改写锚点失配 | 该 rewrite 规则自带 `feature` 匹配，失配即整条规则不生效，行为回落原生 |
| 审计记录本身成为可被追溯的痕迹 | 隐私 / 暴露风险 | 两个开关均默认关闭；UI 描述中写明日志落盘位置 |

---

## 9. 取证依据

- 模块 33 源码（`stopLockTask` / `unlockAction` / `startLock`，`actionOperator` 语义）
- 模块 380（`stopScreenLock` → `unlockAction(e ? 2 : 3)`）
- 模块 348 / 349（本地计数与云端限流的 `_FEEDBACK` 广播）
- 模块 346（`passwordAuthen` → `/forward/SeewoHugoHttp/api/v1/screenLock/unlock/auth`）
- 渲染侧 `screenLock.js` 的 `checkPasswordCorrect` / `originalAuthFailed` / `handleLockTimeFeedBack` / `handleButtonClick`
- `src/aura/mainProcess/hooks/{lockScreenInterceptor,auditWriter,keepPasswordUnlock}.js`
- `src/aura/ui/pages/configSubPages/disableLimitations/settings/auth.js`（分类结构与条目字段约定）
- `src/aura/init/main/ipcModules/auditIpcHandler.js`（审计读取与 `_logType` 透传）
