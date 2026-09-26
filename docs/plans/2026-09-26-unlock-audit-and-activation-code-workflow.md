---
intent: 让锁屏激活码一次扫码可反复尝试（连错 5 次不再换码），并记录每次解锁事件（远程 / 激活码 / 密码）到审计日志。两个开关均默认关闭。
success_criteria: |
  1. 开启 rewrite["vendor/screenLock"].noActivationCodeReset 后，激活码连错 6 次不换码、仍可继续输入，且每次仍提示「激活码错误」。
  2. 关闭该开关时行为与原生一致：连错 5 次出现「激活码错误次数过多，请重新扫码」并刷新二维码。
  3. 开启 auraSettings.unlockAudit.enabled 后，远程 / 激活码 / 密码三条解锁路径各产生一条 _logType 为 "unlock" 的审计记录，method 与 actionOperator 映射正确（1→remote、2→activationCode、3→password）。
  4. 关闭审计开关时不产生 unlock 记录。
  5. 全量 node --test 通过（基线 59 个用例 + 新增用例）。
risk_level: medium
auto_approve: true
branch: dev
worktree: false
dirty_worktree: allow
---

## 参考文档

- 设计文档：`docs/superpowers/specs/2026-09-26-unlock-audit-and-activation-code-design.md`（下称「spec」）
- 结构模板：`src/aura/mainProcess/hooks/keepPasswordUnlock.js`（钩子写法、自检、withRetry、导出形状）

## Steps

- [x] **Step 1: 补两个配置默认值**
action: 编辑 `src/aura/init/shared/default.json`。在 `rewrite` 下的 `"vendor/screenLock"` 对象内追加 `"noActivationCodeReset": false`；在顶层 `auraSettings` 对象内追加 `"unlockAudit": { "enabled": false }`。不修改其他任何键，不改动文件其它区域。注意 `rewrite` 的键名是扁平的 `"vendor/screenLock"`（含斜杠），不是嵌套对象。
loop: false
verify:
  - type: shell
    command: node -e "const c=require('./src/aura/init/shared/default.json'); const sl=c.rewrite['vendor/screenLock']; if(sl.noActivationCodeReset!==false) throw new Error('noActivationCodeReset 缺失或非 false'); if(sl.enabled!==true||sl.fastfail!==false||sl.showDirectUnlock!==false) throw new Error('vendor/screenLock 既有键被破坏'); if(!c.auraSettings.unlockAudit||c.auraSettings.unlockAudit.enabled!==false) throw new Error('unlockAudit 缺失或非 false'); if(!c.auraSettings.lockScreenIntercept||typeof c.auraSettings.lockScreenIntercept.enabled!=='boolean') throw new Error('auraSettings 既有键被破坏'); if(c.auraSettings.cloudCommandAudit.enabled!==false) throw new Error('cloudCommandAudit 既有键被破坏'); console.log('ok')"
  - type: artifact
    path: src/aura/init/shared/default.json
    assert:
      kind: exists

- [x] **Step 2: 实现渲染侧「激活码输错不换码」**
action: 编辑 `src/aura/jsRewrite/vendor/screenLock.js`。定位 `checkPasswordCorrect` 内 `// ### BOR ### //` 区块里的 `const originalAuthFailed = () => {`，在其函数体第一行插入短路：
  `if (__config.enabled && __config.noActivationCodeReset) {`
  `  o.passwordCheckFail();`
  `  return;`
  `}`
  其余内容一行都不改：保留 `o.failCount++`、`o.passwordCheckFail()`、`5 <= o.failCount && o.setState(...)` 与原 `setNewQrcode()` 分支（开关关闭时才走到）。同时保留 `customAuthFailed` 与 `o.state.inputPassword.join("") === o.password` 主比对。
loop: false
gate: human
verify:
  - type: shell
    command: node --check src/aura/jsRewrite/vendor/screenLock.js
  - type: shell
    command: node -e "const s=require('fs').readFileSync('src/aura/jsRewrite/vendor/screenLock.js','utf8'); const g='if (__config.enabled && __config.noActivationCodeReset) {'; if(!s.includes(g)) throw new Error('guard 未插入'); if(!s.includes('5 <= o.failCount &&')) throw new Error('原生换码分支被删'); if(!s.includes('o.setNewQrcode(), (o.failCount = 0)')) throw new Error('原生换码逻辑被改动'); if(!s.includes('o.state.inputPassword.join(\"\") === o.password')) throw new Error('本地主比对被改动'); const b=(s.match(/### BOR ###/g)||[]).length, e=(s.match(/### EOR ###/g)||[]).length; if(b!==6||e!==6) throw new Error('BOR/EOR 数量异常(期望 6/6, 实际 '+b+'/'+e+'), 禁止嵌套锚点'); console.log('ok')"

- [x] **Step 3: 写 unlockAudit 的失败测试**
action: 新建 `test/unlockAudit.test.js`，用 `node:test` + `node:assert/strict`，桩化 `central` 与 `auditWriter`。测试模块按 spec §5 的接口编写：`require("../src/aura/mainProcess/hooks/unlockAudit").hookFunc(central)`。至少包含以下 6 个用例（用例名直接用下面的文字）：
  1. 开关关闭时不写审计
  2. actionOperator 1/2/3 映射为 remote/activationCode/password
  3. 非法 actionOperator 落 unknown
  4. hadLock 在调用前取样（原方法清空 message/windows 后记录仍为 true）
  5. 原方法抛错时不写日志且异常原样抛出
  6. 自检失败（原型 stopLockTask 源码不含 unlockStreamControl）时不包装、不写日志、不抛错
  另加一条边界用例：`arg` 非对象时 operationLogId 落 "0"、actionOperator 落 null、method 落 "unknown" 且不抛错。
  桩的构造要求：`central` 返回一个对象，其原型上定义 `stopLockTask`，且该原型方法源码包含字面量 `unlockStreamControl`，方法内部模拟清空 `this.message` 与 `this.windows`；同时提供 `global.__HUGO_AURA_CONFIG_MGR__.loadConfig()` 桩以控制开关状态，`global.__HUGO_AURA_EVENT_BUS__` 可省略。`auditWriter` 用 `require` 缓存替换或依赖注入的方式桩成记录调用参数。
  此步骤结束时测试必须失败（模块尚未创建），失败原因应为找不到模块。
loop: false
verify:
  - type: artifact
    path: test/unlockAudit.test.js
    assert:
      kind: exists
  - type: shell
    command: node --test test/unlockAudit.test.js *> $null; if ($LASTEXITCODE -eq 0) { Write-Error '预期失败但通过了'; exit 1 } else { Write-Output 'ok: 已确认当前为失败状态' }

- [x] **Step 4: 实现 unlockAudit 钩子**
action: 新建 `src/aura/mainProcess/hooks/unlockAudit.js`，严格按 spec §5 实现，结构对齐同目录 `keepPasswordUnlock.js`：
  - 文件头注释块：背景（三条解锁路径在模块 33 stopLockTask 汇聚、actionOperator 语义）、挂载点选择理由、为什么复用 cloudCommandAudit.log、fail-soft 说明、版本容错说明。
  - `const { withRetry, getPrototypeMethod, resolveModule } = require("./retryHook");` 与 `const auditWriter = require("./auditWriter");`
  - 常量：`SCREEN_LOCK_CONTROLLER_ID = 33`、`AUDIT_FILE = "cloudCommandAudit.log"`、`UNLOCK_METHOD_MARKER = "unlockStreamControl"`。
  - `const hookFn = (central) => { ... }`：`readConfig()` 用 `global.__HUGO_AURA_CONFIG_MGR__.loadConfig()`；`isEnabled()` 读 `config.auraSettings.unlockAudit.enabled`（配置读取失败按未启用处理）；`methodOf(n)` 映射 1→"remote"、2→"activationCode"、3→"password"、其他→"unknown"。
  - `tryInstall()`：`resolveModule(central, 33)` 取实例，`getPrototypeMethod(handler, "stopLockTask")` 取原型方法，自检 `typeof original === "function" && String(original).includes(UNLOCK_METHOD_MARKER)`；不通过时只打一次诊断日志并 `return false`（触发重试，最终优雅降级）。
  - 通过后将包装函数写到原型上（`Object.getPrototypeOf(handler).stopLockTask = wrapper`）。wrapper 签名 `function (arg)`：先取 `hadLock = !!this.message || (Array.isArray(this.windows) && this.windows.length > 0)`，再 `const ret = original.call(this, arg)`；原方法抛错时不写日志、异常原样抛出；正常返回后若 `isEnabled()` 为真，用 `auditWriter.writeAudit(AUDIT_FILE, record)` 写记录。记录字段严格按 spec §5.3：ts / channel("screenLockController") / action("unlock") / method / actionOperator（非数字为 null）/ operationLogId（非对象或缺失为 "0"）/ hadLock / _logType("unlock")。审计写入失败仅 `console.error`，不影响返回值与流程。
  - `withRetry(tryInstall, { label: "UnlockAudit" })();` 与 `module.exports = { hookFunc: hookFn };`
loop: until node --test test/unlockAudit.test.js 通过
max_iterations: 3
verify: node --test test/unlockAudit.test.js

- [x] **Step 5: 在 hook.js 注册钩子**
action: 编辑 `src/core/hook.js`，在已有的 `installHook("KeepPasswordUnlock", "../aura/mainProcess/hooks/keepPasswordUnlock");` 之后紧邻新增一行：`installHook("UnlockAudit", "../aura/mainProcess/hooks/unlockAudit");`。不修改其他注册行。
loop: false
verify:
  - type: shell
    command: node --check src/core/hook.js
  - type: shell
    command: node -e "const s=require('fs').readFileSync('src/core/hook.js','utf8'); const k=s.indexOf('hooks/keepPasswordUnlock'); const u=s.indexOf('hooks/unlockAudit'); if(k<0||u<0) throw new Error('注册行缺失'); if(u<k) throw new Error('注册顺序异常'); if(!s.includes('installHook(\"UnlockAudit\", \"../aura/mainProcess/hooks/unlockAudit\");')) throw new Error('注册语句与约定格式不一致'); console.log('ok')"

- [x] **Step 6: UI — 新增「激活码输错不换码」条目**
action: 编辑 `src/aura/ui/pages/configSubPages/disableLimitations/settings/auth.js`，在 `categoryName: "屏幕锁"`（`id: 1`）的分类的 `child` 数组末尾新增一个条目，字段按 spec §6.1(a)：`index` 取该 child 现有最大 index + 1，`id: "noActivationCodeReset"`，`type: "switch"`，`name: "激活码输错不换码"`，`description` 说明默认会换码、开启后一次扫码可反复尝试且仍提示激活码错误，`restart: false`、`reload: false`，`associateVal: ["rewrite.vendor/screenLock.enabled"]`，`auraIf: () => global.__HUGO_AURA_CONFIG__.rewrite["vendor/screenLock"].enabled`，`defaultValue: false`，`valueGetter` / `callbackFn` 读写 `global.__HUGO_AURA_CONFIG__.rewrite["vendor/screenLock"].noActivationCodeReset`（写入前 `if (typeof newVal !== "boolean") return;`）。
loop: false
verify:
  - type: shell
    command: node --check src/aura/ui/pages/configSubPages/disableLimitations/settings/auth.js
  - type: shell
    command: node -e "const s=require('fs').readFileSync('src/aura/ui/pages/configSubPages/disableLimitations/settings/auth.js','utf8'); const i=s.indexOf('index: 7,'); if(i<0) throw new Error('entry missing'); const j=s.indexOf('index: ', i+8); const blk=s.slice(i, j<0?s.length:j); if(!blk.includes('id: \x22noActivationCodeReset\x22')) throw new Error('wrong entry id'); if(!blk.includes('rewrite[\x22vendor/screenLock\x22]')) throw new Error('wrong config object'); if(!blk.includes('noActivationCodeReset')) throw new Error('wrong config key'); if(!blk.includes('defaultValue: false')) throw new Error('defaultValue not false'); if(!blk.includes('restart: false')||!blk.includes('reload: false')) throw new Error('restart/reload not false'); if(!blk.includes('rewrite.vendor/screenLock.enabled')) throw new Error('associateVal precondition missing'); console.log('ok')"

- [x] **Step 7: UI — 新增「解锁审计」分类**
action: 编辑同一文件 `src/aura/ui/pages/configSubPages/disableLimitations/settings/auth.js`，在顶层数组末尾（`id: 7`「远程锁屏」之后）新增分类：`{ id: 8, categoryName: "解锁审计", child: [ ... ] }`，其中唯一一个条目字段按 spec §6.1(b)：`index: 0`，`id: "enableUnlockAudit"`，`type: "switch"`，`name: "记录解锁事件"`，`description` 说明会记录远程 / 激活码 / 密码三种解锁方式与时间并写入 logs/cloudCommandAudit.log，`restart: false`、`reload: false`，`associateVal: null`，`auraIf: () => true`，`defaultValue: false`，`valueGetter` / `callbackFn` 读写 `global.__HUGO_AURA_CONFIG__.auraSettings.unlockAudit.enabled`。
loop: false
verify:
  - type: shell
    command: node --check src/aura/ui/pages/configSubPages/disableLimitations/settings/auth.js
  - type: shell
    command: node -e "const s=require('fs').readFileSync('src/aura/ui/pages/configSubPages/disableLimitations/settings/auth.js','utf8'); if(!s.includes('categoryName: \"解锁审计\"')) throw new Error('分类缺失'); if(!s.includes('id: \"enableUnlockAudit\"')) throw new Error('条目缺失'); if(!s.includes('auraSettings.unlockAudit')) throw new Error('未读写目标配置键'); if(!s.includes('categoryName: \"远程锁屏\"')) throw new Error('既有分类被破坏'); console.log('ok')"

- [x] **Step 8: UI — 审计查看页支持 unlock 类型**
action: 编辑 `src/aura/ui/pages/configSubPages/preferences/settings/auditLog.js`。在行摘要渲染处（现有 `entry._logType === "peek"` / `"powerOff"` / `"lockScreen"` 分支旁）新增 `entry._logType === "unlock"` 分支：展示解锁方式中文名（remote→远程解锁、activationCode→激活码、password→密码、unknown→未知）与 `hadLock`。在类型筛选的计数处新增一项按 `entry._logType === "unlock"` 统计的计数项。不新增独立页签、不新增文件读取分支。
loop: false
verify:
  - type: shell
    command: node --check src/aura/ui/pages/configSubPages/preferences/settings/auditLog.js
  - type: shell
    command: node -e "const s=require('fs').readFileSync('src/aura/ui/pages/configSubPages/preferences/settings/auditLog.js','utf8'); if(!s.includes('\"unlock\"')) throw new Error('unlock 分支缺失'); for(const k of ['\"peek\"','\"powerOff\"','\"lockScreen\"']) { if(!s.includes(k)) throw new Error('既有分支被破坏: '+k); } console.log('ok')"

- [x] **Step 9: 全量回归**
action: 在仓库根目录运行全量测试，确认既有用例无回归且新增用例通过。若有失败，修复到全绿；不得通过删改既有用例来绕过。
loop: until node --test 全部通过
max_iterations: 3
verify: node --test

- [x] **Step 10: 重新打包部署产物**
action: 在仓库根目录执行 `Compress-Archive -Path "src\aura\*" -DestinationPath "Artifacts\aura.zip" -Force` 与 `Compress-Archive -Path "src\core\*" -DestinationPath "Artifacts\core.zip" -Force`（Artifacts 已被 .gitignore 忽略，不进提交）。
loop: false
verify:
  - type: artifact
    path: Artifacts/aura.zip
    assert:
      kind: exists
  - type: shell
    command: node -e "const fs=require('fs'); for(const f of ['Artifacts/aura.zip','Artifacts/core.zip']) { const st=fs.statSync(f); if(st.size<1000) throw new Error(f+' 体积异常: '+st.size); console.log(f, st.size); }"

- [ ] **Step 11: 真机手工验证**
action: （已推迟 —— 用户选择先提交、稍后验证；真机验证通过前本步不得视为完成）把 Step 10 的产物部署到装有希沃管家 1.6.7.4010 的测试设备，按 spec §7.2 的 5 条清单逐条验证：
  (1) 开启 noActivationCodeReset，进入激活码页签连错 6 次 → 二维码不刷新、仍可输入、每次提示「激活码错误」；
  (2) 关闭该开关，连错 5 次 → 出现「激活码错误次数过多，请重新扫码」且二维码刷新；
  (3) 审计开关关闭时用密码 / 激活码解锁 → 不产生 unlock 记录；
  (4) 审计开关打开后分别用密码、激活码解锁 → 各一条记录，method 正确，hadLock 为 true；
  (5) 在「偏好设置 → 审计日志」能看到 unlock 类型记录且筛选计数正确。
  同时检查管家日志无新增异常（原生的 "screenLock_x窗口崩溃了" 属既有噪声，不算本次问题）。
loop: false
gate: human
verify:
  type: human-review
  check: spec §7.2 的 5 条清单全部符合预期；审计记录字段与预期一致；管家日志无本次引入的异常

- [x] **Step 12: 提交本次改动**
action: 按仓库 commit message 规范（`[<Emoji> <Type>] <Description>`，英文动词原形）提交本次代码与测试文件：`src/aura/init/shared/default.json`、`src/aura/jsRewrite/vendor/screenLock.js`、`src/aura/mainProcess/hooks/unlockAudit.js`、`src/core/hook.js`、`src/aura/ui/pages/configSubPages/disableLimitations/settings/auth.js`、`src/aura/ui/pages/configSubPages/preferences/settings/auditLog.js`、`test/unlockAudit.test.js`。建议标题：`[✨ Feat] Impl activation-code retry without re-scan & unlock event audit`。不提交 `Artifacts/`；`docs/superpowers/` 与 `docs/plans/` 下的设计文档与工作流是否一并提交，由用户当场决定。
loop: false
gate: human
verify:
  - type: shell
    command: git log -n 1 --format=%s
  - type: shell
    command: git status --short
