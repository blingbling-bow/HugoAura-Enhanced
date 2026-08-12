# SeewoCore MQTT TLS 劫持技术文档

> **文档性质**：技术文档。面向对 SeewoCore MQTT TLS 劫持机制感兴趣的开发者/维护者，记录协议行为、系统机制、诊断方法与实验依据。
> **文档定位**：对 SeewoCore MQTT TLS 流量劫持这一技术课题的完整技术记录——从现象定义、机制拆解到假设验证与未决问题的系统性存档。
> **覆盖范围**：项目背景、问题定义、diag18–diag39 全程实验、关键机制规格、证书部署现状、未决问题与后续研究方向。
> **数据来源**：2026-08-10 ~ 2026-08-11 会话日志、各轮 diag 脚本输出、`C:\ProgramData\HugoAura\Aikari\log\` 下的 Aikari 日志、Seewo 侧二进制与文件系统观测。
> **证据可信度标注**：✅ = 实测确认；🔶 = 高置信推断（有间接证据）；❌ = 已证伪。

---

## 1. 项目概述

### 1.1 HugoAura-Aikari 架构

Aikari 是希沃易 + 系列软件的体验调整工具（[README](../README.md)），由多个子模块组成：

| 模块 | 全称 | 职责 |
|---|---|---|
| **Launcher**（Main） | Aikari 主程序 | 生命周期管理、WebSocket 服务（`wss://127.0.0.1:22077`）、注册表/文件系统/配置管理、TLS 证书初始化 |
| **PLS** | Proxy Layer Services（代理层服务） | **本文档主题核心**：创建假 MQTT Broker + 假 Client，修改设备 hosts，对 SeewoCore 的 MQTT 流量做 MITM 篡改（伪造上报、伪造集控指令） |
| **Aikari-Shared** | 共享库 | 日志（Logger）、配置（IConfigManager）、工具（crypto/network/string 等） |
| **Aikari-UI-Settings** | 设置界面 | QML 前端，通过 WebSocket 与 Launcher 通信 |

### 1.2 PLS 模块在劫持链路中的角色

PLS 的劫持链路（[init.cpp](../Aikari-PLS/init.cpp)）由以下环节构成：

1. **环境探测**：读取 `SeewoCoreService` / `SeewoProxyLayerService` 状态、版本、路径（`init.cpp:319` 输出 `SeewoService profile`）
2. **证书保障**：若本地 CA 未生成则调用 [sslUtils.cpp](../Aikari-Launcher/utils/sslUtils.cpp) 的 `genRSA2048TlsCertWithCa` 生成 CA + leaf（`issuedByLocalCa` 检查 issuer 含 "Root CA" 则跳过再生成）
3. **hosts 劫持写入**：`iot-broker.seewo.com → 127.11.45.14`（2 条条目），并刷新 Windows DNS 缓存
4. **假 Broker 监听**：mbedTLS TLS 服务端监听 `127.11.45.14:8883`（`mqttBroker.cpp`），接受 SeewoCore 的连接
5. **SeewoCore 重启触发**：杀 SeewoCore 进程，触发希沃看门狗重新拉起（此时 hosts 劫持已生效）
6. **退出回滚**：删除 hosts 条目、杀 SeewoCore、flush 日志后退出

> **命名冲突提示**：README 中 PLS = "Proxy Layer Services"（Aikari 的代理层服务），而希沃生态自身存在一个 `SeewoProxyLayerService` 服务，两者**同名不同物**（后者机制见 §5.6）。

---

## 2. 问题定义

### 2.1 现象

SeewoCore（希沃集控基础服务，`SeewoService_1.6.6.3993`）通过 `ssl://iot-broker.seewo.com:8883` 建立 MQTT over TLS 连接。在 hosts 劫持生效、PLS 假 Broker 正常监听的条件下：

- **TLS 握手在 `ServerHelloDone` 之后失败**：PLS 侧日志显示 `server state: 5`（ServerHelloDone 已写出）→ 随后对端**静默 RST**（TCP 层直接断开，无 FIN 序列）
- **无任何 TLS alert 报文**：既非早期版本的 `alert 48 unknown_ca`（该问题已修复），也无其他 alert——客户端在 TLS 协议层之外直接断开
- PLS 侧 mbedTLS 表现为 `f_send` 失败，返回码 **-78**（`MBEDTLS_ERR_SSL_CONN_EOF`，对端提前关闭连接）
- 失败呈 **约 65 秒周期性** 重复出现，与 SeewoCore 的重连周期同步

### 2.2 影响

握手失败 → PLS 的 MITM 篡改能力失效 → Aikari 的"伪造上报 / 伪造集控指令"功能无法生效。该失败是 Aikari PLS 子功能投入使用的**主要阻塞点**，也是本文档全部实验围绕的核心问题。

---

## 3. 实验时间线（按发生顺序）

| 时间（2026-08） | 事件 | 阶段结论 |
|---|---|---|
| 08-10 21:27 | `real_broker.crt` 抓取（真云证书 1678B） | 真云证书 SAN/签发者比对基准 |
| 08-11 00:10 | Procmon 取证：SeewoCore 每次握手读取 `machine\seewo.crt` + `machine\ca.crt`，**从不读 cert.pem / Windows 证书存储** | ✅ 信任锚 = `machine\ca.crt` 文件（非系统存储） |
| 08-11 21:31~21:35 | diag32 轮：**SeewoCore 首次连到本地 PLS**（`127.11.45.14:8883` ESTABLISHED，PID 10948），PLS 日志 `server state: 5→6`，写 ServerKeyExchange 时对端 RST | ✅ hosts 劫持链路打通；失败点 = ServerHelloDone 之后 |
| 08-11 21:33~21:41 | diag33 + fix1883：`machine_zmodule.dll` 硬编码 `ssl://192.168.153.253:1883`（假地址 = 设计好的劫持点）→ fix1883 添加 IP 别名 + portproxy 1883→8883 → 21:41 轮 PLS 收到握手（仍 -78） | ✅ machine 模块经 portproxy 连到 PLS；**主机名校验假设提出** |
| 08-11 21:45 | `gen_ip_san_certs.py` 生成新 CA + 带 IP SAN 的 leaf（`fix_ip_san_certs\`） | 新证书集就绪 |
| 08-11 21:5x | fix_ip_san.bat：Aikari certs 4 文件替换 ✅；Seewo 侧 `ca.crt` 复制**拒绝访问**（驱动保护） | 驱动拦截写入，实验半完成 |
| 08-11 22:0x | fix_ip_san2.bat：先杀 SeewoCore → 停驱动 → 立即复制 → 恢复 → **Seewo 侧 ca.crt 实际部署成功**（文件哈希 E7978B99） | ✅ 新 CA 双端就位 |
| 08-11 22:00~22:12 | diag34 + 两轮日志：**PLS 零握手**；SeewoCore 被杀后未及时拉起；diag34 判定出现"文件哈希 vs 证书指纹"错位 | 观测窗口问题 + 判定基准 bug |
| 08-11 22:17~22:23 | diag35（6 分钟 × 8 采样）：SeewoCore 运行但**监听 `0.0.0.0:8883` + 零外连**（不连真云、不连 PLS） | 🔶 行为异常：监听 8883 但从不发起连接 |
| 08-11 22:31~22:37 | diag36（服务全景）：**SeewoCoreService = STOPPED**（进程却活着，看门狗拉起）；`SeewoProxyLayerService` = DEMAND_START + STOPPED；57676 = **SeewoAbility**（PID 13992）；47.99.159.125 防火墙规则在位 | ✅ 服务生态全景 |
| 08-11 22:33~22:38 | diag37：`sc start SeewoCoreService` 失败（PID 6016 启动 5s 后停止）→ **单例冲突**（看门狗进程 16988 活着）；Aikari 杀 16988 后服务模式启动成功（16776）→ **依然零外连** | ✅ 双轨启动机制；❌ 服务模式非断链点 |
| 08-11 22:50~22:55 | diag38：启动 `SeewoProxyLayerService`（PID 1204）→ **SeewoCore 1 秒后自动启动**（PID 8812）→ **依然监听 8883 + 零外连** | ✅ proxy 是启动触发器；❌ proxy 非断链点 |
| 08-11 22:56+ | diag39（CA 侦察）设计完成 | **未执行**（调试暂停，转为本文档编写） |

---

## 4. 实验记录：假设的验证与排除

> 本章按"假设 → 验证手段 → 结论"组织。每个实验的技术机制背景详见 §5。

### 4.1 信任锚来源定位（Procmon 取证，✅）

**待验证假设**：SeewoCore 的 TLS 验证依赖哪个信任锚？

**验证手段**：Procmon 捕获 SeewoCore 完整文件访问序列，与 8883 连接握手事件对齐。

**结论**：SeewoCore 的 MQTT TLS 验证**不依赖 Windows 证书存储**，而是硬编码读取：

```
C:\Program Files (x86)\Seewo\SeewoService\SeewoService_1.6.6.3993\SeewoCore\module\machine\ca.crt   （信任锚）
C:\Program Files (x86)\Seewo\SeewoService\SeewoService_1.6.6.3993\SeewoCore\module\machine\seewo.crt （客户端证书）
C:\Program Files (x86)\Seewo\SeewoService\SeewoService_1.6.6.3993\SeewoCore\module\machine\seewo.key （客户端私钥）
```

- 原厂 `ca.crt` 仅含 CVTE 内部测试 CA（`CN=172.18.165.170, O=Default Company Ltd`）
- `Verify.json` 防篡改清单**只校验 dll，不校验 crt 文件** → 修改 ca.crt 不触发防篡改保护 ✅
- 信任锚文件修改后**需重启 SeewoCore 进程**才生效（进程级缓存，见 §5.1）

**方法学要点**：`C:\Program Files (x86)\Common Files\SSL\cert.pem` 字符串确实存在于 `iot_mqtt.dll` / `paho-mqtt3as.dll` 中（diag21 曾据此误判），但 Procmon 证实实际读取路径是 machine 目录——**二进制字符串只能作为线索，行为观测才是证据**。

### 4.2 证书链健康性排除（diag20–diag30，✅ 全部排除）

**待验证假设**：证书本身（链结构/私钥/扩展/编码）是握手失败原因？

| 实验 | 验证内容 | 结果 |
|---|---|---|
| diag20 | 私钥 DER 格式修复（PKCS#1） | ✅ PLS 监听 `127.11.45.14:8883` 成功 |
| diag22-23 | C# 生成证书部署落盘验证（`machine\ca.crt` 实测 1192B 未变） | ✅ 揭露部署验证假阳性：必须以文件哈希为准 |
| diag25-26 | 写入成功但带 **UTF-8 BOM** 污染（958B2FB6 → 1174B 无 BOM 修复） | ✅ 连接仍失败，排除 BOM 因素 |
| diag27 | 补全 **AKI/SKI 扩展**（新 CA `019B7BA0`） | ✅ 客户端仍在 ServerHelloDone 前断连，排除扩展缺失 |
| diag29 | 杀 SeewoCore 后刷新，PLS 侧加载 leaf `27018D06` + CA `019B7BA0` | ✅ PLS 证书链正常加载 |
| diag30 | 数学验证：私钥 Modulus 与证书公钥一致；leaf 由 CA 签名 = True | ✅ **证书本身完全健康** |

**排除结论**：证书链、私钥、扩展、编码均无问题 → 问题收敛到**客户端侧校验逻辑**（主机名 / pinning）。

### 4.3 主机名校验假设与验证实验（diag31–33 + fix1883，🔶 已提出、验证被零外连现象阻断）

**证据链**：

1. diag31：扫描 Seewo 目录二进制，**无硬编码 CA 指纹 / pinning 常量**（`pinning`/`thumbprint` 关键词零命中）→ 传统 pinning 假设被削弱
2. diag33：`machine_zmodule.dll` 硬编码 `ssl://192.168.153.253:1883`（`dummymachine.VI.192.168.153.253.MP.ip` 等），192.168.153.253 不在本机 ARP 表 → **该地址是"设计好的劫持点"**（假地址）
3. 旧 leaf 证书 SAN = **仅 `DNS:iot-broker.seewo.com`，无任何 IP 条目**（[sslUtils.cpp](../Aikari-Launcher/utils/sslUtils.cpp) `genRSA2048TlsCertWithCa`）
4. 现象学吻合：OpenSSL 客户端**按 IP 直连时校验 SAN 的 IP 条目**，DNS-only SAN → 校验失败 → **静默 RST（-78，无 alert）**，与观测到的失败模式逐字节吻合

**假设陈述**：SeewoCore（或 machine 模块）按 IP（127.11.45.14 / 192.168.153.253）连接 PLS 时，因 leaf SAN 无对应 IP 条目而静默拒绝。

**验证实验设计（fix_ip_san）**：生成带 IP SAN 的新证书集 → 若假设成立，握手应越过 ServerHelloDone。该验证被后续"零外连"现象（§4.6）阻断，**尚未取得决定性结果**。

### 4.4 IP-SAN 证书生成与部署实验（✅ 完成）

**生成**（[gen_ip_san_certs.py](../gen_ip_san_certs.py)，Python cryptography 库，PKCS#1 无 BOM）：

```
CA  ：CN=HugoAura Aikari Root CA, serial 1
leaf：SAN = DNS:iot-broker.seewo.com, DNS:iot-broker-mis.seewo.com,
             IP:127.11.45.14, IP:127.0.0.1, IP:192.168.153.253
mqtt.crt = leaf + ca（2 个 PEM 块拼接）
```

**代码侧**：[sslUtils.cpp](../Aikari-Launcher/utils/sslUtils.cpp) `genRSA2048TlsCertWithCa` 改为多节点 `mbedtls_x509_san_list` 链表（1 DNS 备用 + 3 个 IP 节点），保证**运行时再生成**的证书同样携带 IP SAN。

**部署结果**：

| 位置 | 内容 | 状态 |
|---|---|---|
| Aikari certs（`C:\ProgramData\HugoAura\Aikari\config\certs\`） | ca.crt / ca.key / mqtt.crt / mqtt.key（新 IP-SAN 集） | ✅ fix_ip_san 成功替换 |
| Seewo 锚点（`machine\ca.crt`） | 新 CA 文件（1212B，文件哈希 `E7978B99…`） | ✅ fix_ip_san2 实际成功（验证逻辑有 bug，见 4.5） |

**验证依据**：PLS 启动日志 22:17:01 `MQTT TLS cert already generated ... skipping regeneration` + `issuedByLocalCa` 通过 → PLS 已加载新证书。

### 4.5 双哈希概念：diag34 判定偏差的成因（✅ 确认）

**核心概念**：PEM **文件哈希**（`Get-FileHash` / `certutil -hashfile` 对文件字节计算）≠ X509 **证书指纹**（`Thumbprint`，DER 编码后 SHA1）。两者对同一文件数值必然不同。

| 对象 | 值 |
|---|---|
| 新 CA **文件哈希**（fix_ip_san_certs\ca.crt） | `E7978B998B9EA3033BB695D1F5B14C3B5FE53A36` |
| 新 CA **证书指纹**（DER SHA1） | `A713DC19E944C82B70A0A94598E1DC31004282FC` |
| 旧 CA 证书指纹（fix15 部署到 Seewo 锚点） | `019B7BA0DF7C0A923815AD8CF5CAF58C502B87D3` |

**偏差成因**：diag34 用文件哈希对比证书指纹 → 输出 `ca.crt SHA1: E7978B99... NOT THE NEW CA`，**实际部署成功被误判为失败**；fix_ip_san2 的 `EXPECTED` 值同样将指纹 `A713DC19` 与文件哈希 `E7978B99` 混用 → 验证必然 MISMATCH（复制本身成功）。**方法学结论：判定逻辑必须先声明对比基准（文件哈希 vs 证书指纹），再取值比对。**

### 4.6 零外连行为观测（diag35–38，✅ 实测确认）

**观测现象**：fix_ip_san 系列之后，SeewoCore 行为剧变——**从不发起任何 broker 连接**：

- 无 SYN_SENT → 47.99.159.125:8883（真云）
- 无 ESTABLISHED → 127.11.45.14:8883（本地 PLS）
- 唯一"外联" = 9 条 Established → `127.0.0.1:57676`（**SeewoAbility**，diag36 [4/5] 确认 PID 13992）
- 条件性监听 `0.0.0.0:8883`（见 §5.4）

**排除链**（逐一证伪）：

| 假设 | 验证手段 | 结论 |
|---|---|---|
| 缺 ProxyLayerService 导致不连 | diag38 启动 proxy → 仍零外连 | ❌ |
| 服务模式 vs 看门狗模式行为差异 | diag37 两种模式行为一致 | ❌ |
| hosts 劫持失效导致不连 | diag38：Aikari 退出后仍监听 8883 | ❌ |
| 证书本身问题导致不连 | diag20-30 数学验证全过 | ❌ |

**当前归因（🔶 高置信推断）**：**`machine\ca.crt` 内容被替换后，破坏了 SeewoCore MQTT 模块的初始化校验（信任锚文件指纹/内容不匹配 → MQTT 功能静默禁用，不抛错、不连接）**。关键时序证据：**唯一成功握手轮次（21:31-21:41）全部发生在 fix_ip_san（替换 ca.crt）之前**。

**待执行验证**：恢复 Seewo 出厂 `ca.crt.bak` → 观察是否恢复"连真云 → 回退本地"的连接行为（实验方案见 §8.5）。

### 4.7 服务生态测绘（diag36–38，✅ 实测确认）

| 对象 | 实测规格 |
|---|---|
| **SeewoCoreService** | AUTO_START，失败恢复 = 30 秒后重启；**服务状态 ≠ 进程状态**（看门狗可绕过服务直接拉进程） |
| **SeewoProxyLayerService** | **DEMAND_START（手动按需）**，失败恢复 10 秒；**是 SeewoCore 的启动触发器**（22:50:20 启动 proxy → 22:50:21 SeewoCore 自动启动） |
| **SeewoAbility** | 运行中（PID 13992），监听 `127.0.0.1:57676`，SeewoCore 启动后固定连它 9 条连接（角色未确认，见 §5.5） |
| **SeewoLauncherGuard** | 运行中（看门狗），拉起 SeewoCore.exe（无 `/winService` 参数） |
| **双轨互斥** | 看门狗轨道与 Service 轨道**单例互斥**：看门狗进程活着时 `sc start SeewoCoreService` 必失败（diag37：PID 6016 启动 5 秒后 STOPPED；杀 16988 后服务模式 16776 才成功） |

---

## 5. 技术原理与系统机制（核心章节）

> 本章以技术规格口径记录 SeewoCore 生态与 Aikari 劫持链路中各机制的完整行为。所有条目均可回溯至 §3 时间线中的实测事件。

### 5.1 TLS 信任锚验证机制

**信任锚规格**：

| 角色 | 文件 | 说明 |
|---|---|---|
| 信任锚（CA） | `...\SeewoCore\module\machine\ca.crt` | 每次握手前读取（Procmon 实证）；支持多 PEM 块拼接（OpenSSL 信任链语义） |
| 客户端证书 | `...\SeewoCore\module\machine\seewo.crt` | 握手中随 ClientHello 携带 |
| 客户端私钥 | `...\SeewoCore\module\machine\seewo.key` | 与 seewo.crt 配对 |

**行为规格**：

1. **验证路径**：OpenSSL 文件路径验证模式，信任锚硬编码为 machine 目录下的 `ca.crt`；**不读** OpenSSL 默认路径 `C:\Program Files (x86)\Common Files\SSL\cert.pem`，**不依赖** Windows 证书存储
2. **读取时序**：每次 8883 连接握手期间（TCP Connect → ClientHello 之前）读取 ca.crt / seewo.crt；Procmon 全程 0 次访问 cert.pem
3. **进程级缓存**：信任锚文件在进程生命周期内有缓存，**修改文件后必须重启 SeewoCore 进程**才生效（早期"改完立即生效"的判断已被推翻）
4. **防篡改覆盖**：`Verify.json` 校验清单仅含 dll（如 mp_mqtt.dll），**不含 crt 文件** → 修改 ca.crt 不触发防篡改保护
5. **配置不可切换**：信任锚路径硬编码（非注册表/配置文件可改），IoT 注册表项不承载该路径

**与握手失败的关系**：早期 `alert 48 unknown_ca` 阶段证明"信任锚缺失/不匹配"的失败表现是**明确 alert**；而当前阶段的**静默 RST（-78）** 指向校验链更深处（主机名校验或初始化禁用，见 §4.6）。

### 5.2 SeewoCore 双轨启动机制

SeewoCore 存在两条独立的启动轨道，进程层面**单例互斥**：

```
轨道 A（看门狗）: SeewoLauncherGuard ──拉起──> SeewoCore.exe（无 /winService）
轨道 B（服务）  : SeewoCoreService ──sc start──> SeewoCore.exe /winService
                    │
                    └─ 单例互斥：轨道 A 进程存活 → 轨道 B 启动后 5 秒内自停
```

**时序证据**（diag37）：

| 时刻 | 事件 | 结果 |
|---|---|---|
| 22:33 | `sc start SeewoCoreService` | PID 6016 启动，5 秒后 STOPPED（轨道 A 进程 16988 在位） |
| 22:37:08 | Aikari 杀 16988（ANY 日志 `service.cpp:196 Successfully requested start of service`） | 服务模式启动成功 |
| 22:37:09 | SeewoCoreService RUNNING（PID 16776） | 依然监听 8883 + 零外连 |

**推论**：SeewoCore 存在"确保单实例"的内部互斥（可能是命名互斥体或端口/资源占用检查）。Aikari 的"确保服务运行"逻辑（`service.cpp:196`）在杀进程后自动请求服务启动，说明 Aikari 依赖轨道 B 作为重启路径之一。

### 5.3 MQTT 重连周期状态机

```
[被杀] ──看门狗拉起（20-40s）──> [启动]
  │
  ├─ 直连真云 47.99.159.125:8883（云端下发 IP，绕过 DNS/hosts）
  │     └─ 防火墙出站阻断 → SYN_SENT 悬挂
  │           └─ ~65s 周期重试
  │
  └─ 多轮失败后回退 hosts 劫持地址 127.11.45.14:8883
        └─ TLS 握手（结果取决于证书链路状态）
```

**规格参数**：

- 重连周期 ≈ **65 秒**（失败后周期重试）
- 真云地址来源：**云端配置下发**（直接 IP，绕过 DNS 解析与 hosts）——这是"hosts 劫持为何需要配合防火墙堵真云 IP"的根本原因
- 观测约束：完整周期（杀 → 拉起 → 真云尝试 → 回退本地）**≥ 6 分钟**；短窗口（2.5-5 分钟）观测到的"零握手"为假阴性（diag34 教训）

### 5.4 8883 端口条件性监听

| SeewoCore 进程 | 环境 | 8883 监听 |
|---|---|---|
| 12172 / 16776 / 8812 / 16988 | hosts 劫持在位（Aikari 运行）或 proxy 在位 | `Listen 0.0.0.0:8883` ✅ |
| 16364 | hosts 已删 + proxy 停止 | 不监听 ❌ |

**规格**：

- "监听 8883"是 **SeewoCore 自身的主动占坑行为**（非 Aikari 部署的监听器）
- `127.11.45.14:8883`（PLS）与 `0.0.0.0:8883`（SeewoCore）可在 Windows 上共存（绑定细节未深究）
- 行为不规则（16364 例外），触发条件与 hosts/proxy 状态的相关性**不成立**（8812 在 Aikari 未运行时也监听）
- **任何一轮采样均未观察到 SeewoCore 主动连接 8883**——监听是"待命"而非"发起"

### 5.5 SeewoAbility（127.0.0.1:57676）

- 进程：SeewoAbility（PID 13992，diag36 [4/5] 确认）
- 监听：`127.0.0.1:57676`（本地回环）
- 连接模式：SeewoCore 每次启动固定建立 **9 条 Established 连接**，为 SeewoCore 唯一的外部通信对象
- 角色：未确认（🔶 推测为配置下发 / 能力上报中心；**是否持有 broker 配置来源未知**——若后续确认零外连与配置链路相关，此为深挖方向）

### 5.6 SeewoProxyLayerService：启动触发器

- 二进制：`...\ProxyLayerService\proxyLayerService.exe /winService`
- 服务类型：**DEMAND_START（手动按需）**，失败恢复 = 10 秒
- **触发语义**：`sc start SeewoProxyLayerService` 后 **1 秒内** SeewoCore 自动启动（diag38 实测：22:50:20 启动 proxy → 22:50:21 SeewoCore PID 8812 出现），与当前运行轨道（看门狗/服务）无关
- 推论：proxy 服务是 SeewoCore 生命周期管理链的上游节点；Seewo 生态通过"proxy 在位 → core 必然被拉起"保证核心服务可用性
- 注意：与 Aikari 的 PLS（Proxy Layer Services）**同名不同物**

### 5.7 SeewoKeLiteLady 文件保护驱动

**拦截语义**：`SeewoKeLiteLady` 文件系统驱动拦截对 Seewo 目录的写入，**管理员权限同样被拒**（diag24 实测 "Access denied"，杀进程后依旧）。

**对抗时序窗口**（fix_ip_san2 验证成功）：

```
1. taskkill SeewoCore.exe      （先杀，防运行中回写/占用）
2. sc stop SeewoKeLiteLady
3. 立即复制/写入                （1 秒内完成；守护进程可能 3 秒内抢拉驱动 → 失败码 1056）
4. sc start SeewoKeLiteLady    （恢复保护）
5. 失败则重试整轮
```

**关键参数**：驱动 stop 后守护进程可能抢先拉起（`1056 = ERROR_SERVICE_ALREADY_RUNNING`），写入窗口约 1-3 秒，必须"杀进程 → 停驱动 → 立即写"一气呵成。

### 5.8 hosts 劫持生命周期（Aikari 侧）

```
Aikari 启动：写入 2 条条目（127.11.45.14 iot-broker.seewo.com 等）→ flush DNS 缓存
Aikari 运行：条目在位（network.cpp:273 "Hosts file already contains..."）
Aikari 退出：删除 2 条条目（"Removed 2 Aikari hosts entries"）→ flush DNS
```

**日志机制约束**：Aikari Logger **异步缓冲写盘**——运行中读盘可能为空，只有正常退出（"Flushing logger..."）才完整落盘。**读取日志的时机必须晚于 Aikari 正常退出**，否则会产生"零握手"假象（diag34 两轮空日志即因此）。

---

## 6. 证书部署现状与资产核对

| 项目 | 值 / 路径 | 状态 |
|---|---|---|
| 新 CA 文件哈希 | `E7978B998B9EA3033BB695D1F5B14C3B5FE53A36` | Aikari certs ✅ / Seewo 锚点 ✅ |
| 新 CA 证书指纹 | `A713DC19E944C82B70A0A94598E1DC31004282FC` | — |
| 旧 CA 证书指纹 | `019B7BA0DF7C0A923815AD8CF5CAF58C502B87D3`（已部署过） | 无文件备份 |
| Aikari certs 目录 | `C:\ProgramData\HugoAura\Aikari\config\certs\`（= `C:\Users\All Users\...`） | 新 IP-SAN 4 文件 |
| Seewo 信任锚 | `C:\Program Files (x86)\Seewo\SeewoService\SeewoService_1.6.6.3993\SeewoCore\module\machine\ca.crt` | 新 CA（1212B） |
| Seewo 出厂备份 | 同目录 `ca.crt.bak`（含假 IP 与旧自签名证书） | 存在（diag39 未执行确认） |
| 生成脚本 | `e:\HugoAura-Aikari\gen_ip_san_certs.py` | 可再生成 |
| 生成产物 | `e:\HugoAura-Aikari\fix_ip_san_certs\`（ca.crt/ca.key/mqtt.crt/mqtt.key） | 在库 |
| 部署脚本 | `fix_ip_san.bat` / `fix_ip_san2.bat` | 在库（后者可靠） |
| fix1883 残留 | IP 别名 `192.168.153.253` + portproxy `1883→8883` | **仍在位**（清理见 §8.3） |
| 防火墙 | 47.99.159.125:8883 出站阻断 ✅；121.43.97.62 / 115.227.42.75 无规则 | 配置服务器未堵 |
| 日志 | `C:\ProgramData\HugoAura\Aikari\log\Aikari_{PLS,ANY,Main}_*.log` | 按日命名，启动覆盖 |

---

## 7. 实验方法清单（diag18–diag39）

> 脚本位于 `e:\HugoAura-Aikari\`（`.bat` 为入口，自动提权；`.ps1` 为核心逻辑；CRLF 已转换，勿用 LF 重存）。本章供后续研究者复现或扩展实验。

| 脚本 | 验证 / 观测的技术现象 | Aikari 需运行 | 耗时 | 关键输出 / 判读 |
|---|---|---|---|---|
| diag18-19 | 早期 SSLUtils 私钥/证书格式基础检查 | — | — | 证书生成链路基线 |
| diag20 | PLS TLS 服务端在私钥 DER 修复后是否正常监听 | 是 | ~5 分钟 | `127.11.45.14:8883 LISTENING` ✅ |
| diag21 | 客户端信任锚路径线索（DLL 字符串扫描） | 否 | 2-3 分钟 | `cert.pem` 路径字符串（曾误导，实证见 §5.1） |
| diag22 | C# 证书生成链路（DER 编码 bug 分析） | 否 | — | C# 生成失败 → 路线弃用 |
| diag23 | 证书部署是否实际落盘（文件哈希对比） | 否 | — | 揭露部署验证假阳性（文件未变） |
| diag24 | 驱动对 Seewo 目录写入的拦截是否与进程存活相关 | 否 | — | Access denied → 锁定驱动为拦截者 |
| diag25 | 停驱动后的写入可行性 | 否 | — | 写入成功（发现 BOM 污染） |
| diag26 | UTF-8 BOM 是否为握手失败因素 | 否 | — | 1174B 无 BOM，连接仍失败 → 排除 |
| diag27 | AKI/SKI 扩展缺失是否为失败因素 | 否 | — | CA=019B7BA0，仍失败 → 排除 |
| diag28 | 环境因素隔离（四路对比：SO_REUSEADDR 占坑等） | 否 | — | 暴露占坑等问题 |
| diag29 | PLS 侧证书刷新/加载正确性 | 是 | — | leaf 27018D06 + CA 019B7BA0 加载 ✅ |
| diag30 | 证书数学完备性（私钥-公钥 Modulus / 签名链） | 否 | — | 全部 True → 证书健康 ✅ |
| diag31 | pinning 常量扫描 + machine_zmodule.dll 配置机制测绘 | 否 | 1-3 分钟 | 无硬编码指纹；发现 `ssl://192.168.153.253:1883` |
| diag32 | SeewoCore 连接本地 PLS 时的握手阶段推进与失败点 | 是 | ~5 分钟 | 首次握手上线：server state 5→6、-78 |
| diag33 | machine 模块硬编码劫持点确认 | 否 | — | 192.168.153.253 = 设计劫持点 |
| diag34 | CA 双端部署结果验证（含判定基准错位） | 是 | 2.5 分钟 | ⚠️ 文件哈希 vs 指纹判定 bug |
| diag35 | 长窗口（≥1 重连周期）连接行为采样 | 是 | 6 分钟 | 8883 条件监听 + 零外连 ✅ |
| diag36 | Seewo 服务/进程/端口/防火墙全景测绘（只读） | 否（运行更佳） | 1 分钟 | SeewoCoreService STOPPED；57676=SeewoAbility |
| diag37 | 服务模式 vs 看门狗模式行为差异与单例互斥 | 是 | 6 分钟 | 单例冲突（6016 失败 / 16776 成功）✅ |
| diag38 | ProxyLayerService 对 SeewoCore 的启动触发与连接影响 | 是 | 8 分钟 | proxy → SeewoCore 1s 触发；仍零外连 ✅ |
| diag39 | Seewo 信任锚文件与出厂备份候选只读侦察 | 否 | 1 分钟 | ca.crt.bak 等恢复候选（**未执行**） |

---

## 8. 未决问题与后续研究方向

### 8.1 主机名校验 vs pinning：最终判定实验

**前提状态**（已全部就绪）：新 IP-SAN 证书双端部署 ✅、PLS 监听 ✅、hosts 劫持 ✅、真云 8883 防火墙阻断 ✅。**阻塞项：SeewoCore 零外连（§4.6 归因待验证）**。

**判定标准**（恢复连接行为后）：

- PLS 握手**越过 ServerHelloDone**（出现 client Finished / MQTT CONNECT，无 -78）→ **主机名校验假设成立**，劫持链路打通
- 仍呈 65s 节奏 `-78` RST → **pinning 实锤** → 转入 8.2 二进制 patch 路线

### 8.2 二进制指纹 patch 的技术路径（pinning 确认后）

1. `sc stop SeewoKeLiteLady`（先停驱动）
2. patch `machine_zmodule.dll` / `iot_mqtt.dll`（或其它模块）中的指纹字节
3. 恢复驱动，重启 SeewoCore 验证
4. 前置问题：diag31 扫描未发现 pinning 字符串 → 指纹可能以**原始字节**存在（十六进制搜索 `019B7BA0` / 公钥 SHA1 字节序列）；亦不排除校验逻辑在 `seewo-iot-sdk` 其他组件中

### 8.3 fix1883 网络残留的清理与影响

- 现状：IP 别名 `192.168.153.253` + portproxy `1883→8883` 仍在位
- 清理：`netsh interface ipv4 delete address ...`（原接口/前缀）+ `netsh interface portproxy delete v4tov4 listenport=1883 listenaddress=192.168.153.253`
- 影响分析：清理后 machine 模块的 `ssl://192.168.153.253:1883` 将指向真实网络（未 pin 则连真云，被防火墙堵）——清理时机需与 8.1/8.5 的结论联动

### 8.4 配置服务器的流量阻断策略

- 现状：broker 直连 IP 由云端配置下发（121.43.97.62 / 115.227.42.75，**未堵**）；47.99.159.125:8883 已有出站阻断规则
- 候选策略：对两个配置服务器加出站阻断，杜绝 SeewoCore 获取真云 broker IP
- ⚠️ 干扰因素：堵配置服务器可能改变 SeewoCore 行为（配置拉取失败 → 可能不连），**需与零外连现象（§4.6）做判别实验隔离**

### 8.5 信任锚恢复实验（验证零外连归因，最高优先级）

```
1. 执行 diag39 确认 ca.crt.bak 存在及内容（是否为出厂 CA）
2. 停驱动 → 备份当前 ca.crt → 用 ca.crt.bak 覆盖 machine\ca.crt → 恢复驱动
3. 重启 SeewoCore（或整体重启 Aikari）
4. 6 分钟采样：恢复"连真云 → 回退本地"行为 = 零外连归因成立
5. 归因成立后：将新 CA 追加到 ca.crt（PEM 多块拼接，OpenSSL 信任链语义允许），
   或替换整个文件 → 观察握手阶段推进
```

**研究意义**：该实验同时回答两个未决问题——①零外连是否由信任锚文件内容触发（§4.6）；②主机名校验假设在连接恢复后的最终判定（§8.1）。

---

## 9. 技术踩坑记录

| # | 踩坑点 | 机制 / 教训 | 来源 |
|---|---|---|---|
| 1 | 日志异步缓冲 | Aikari 运行中读盘为空，正常退出（Flushing logger）后才完整；采样时机必须先于日志完整性要求 | diag34 空日志 |
| 2 | 观测窗口不足 | SeewoCore 完整周期（杀→拉起→真云→回退）≥ 6 分钟，短窗口"零握手"必假阴性 | diag34-35 两轮误判 |
| 3 | 文件哈希 ≠ 证书指纹 | 对比基准必须声明（Get-FileHash vs Thumbprint），混用导致部署成功误判为失败 | diag34 判定 bug |
| 4 | 驱动对抗窗口 | 停 SeewoKeLiteLady 后守护可能 3 秒抢拉（1056）；写入窗口 1-3 秒，须"杀进程→停驱动→立即写→恢复" | fix_ip_san 失败 / fix_ip_san2 成功 |
| 5 | 服务状态 ≠ 进程状态 | 看门狗直拉进程绕过服务管理，`sc query` 不可作为进程存活的依据 | diag36-37 |
| 6 | 单例互斥 | SeewoCore 双轨互斥，服务模式启动前必须先清除看门狗轨道进程 | diag37 |
| 7 | PEM 写入 BOM 污染 | PowerShell 默认编码写入会带 UTF-8 BOM，破坏 PEM 解析（958B2FB6 事故） | diag25-26 |
| 8 | PowerShell 5.1 中文乱码 | 无 BOM UTF-8 脚本中的中文注释破坏语法；脚本保持全 ASCII | 多个 diag |
| 9 | 批处理 CRLF | IDE 写 .bat 可能变 LF 导致解析崩溃；交付前 CRLF 转换 + 提权自检 | 多个 diag |
| 10 | Node 终端吞 `$_` | Node 终端执行 PowerShell 时 `$_` 被吞；改用临时 .ps1 文件执行 | 多次 |
| 11 | 静默失效模式 | 客户端可能因信任锚校验失败完全关闭网络功能而不抛任何错误 | diag35-38 零外连 |
| 12 | 字符串扫描 ≠ 行为证据 | 二进制中的路径字符串只能作线索，最终以行为观测（Procmon 文件访问）为准 | 信任锚定位 |
| 13 | 服务依赖链 | ProxyLayerService（DEMAND_START）是 SeewoCore 启动触发器，服务生态分析需按依赖链展开 | diag38 |

---

## 10. 附录：速查表

### 关键路径

| 对象 | 路径 |
|---|---|
| SeewoCore 主程序 | `C:\Program Files (x86)\Seewo\SeewoService\SeewoService_1.6.6.3993\SeewoCore\SeewoCore.exe` |
| 信任锚 / 客户端证书 | `...\SeewoCore\module\machine\{ca.crt, seewo.crt, seewo.key}` |
| ProxyLayerService | `...\ProxyLayerService\proxyLayerService.exe` |
| Aikari 证书 | `C:\ProgramData\HugoAura\Aikari\config\certs\{ca.crt, ca.key, mqtt.crt, mqtt.key}` |
| Aikari 日志 | `C:\ProgramData\HugoAura\Aikari\log\Aikari_{PLS,ANY,Main}_YYYY-MM-DD.log` |
| 生成产物 | `e:\HugoAura-Aikari\fix_ip_san_certs\` |

### 关键服务 / 端口

| 对象 | 类型 | 状态（2026-08-11 22:5x） |
|---|---|---|
| SeewoCoreService | AUTO_START | STOPPED（进程由看门狗维持） |
| SeewoProxyLayerService | DEMAND_START | STOPPED（手动可启） |
| SeewoLauncherGuard | 看门狗 | RUNNING |
| SeewoAbility | 进程 | RUNNING（127.0.0.1:57676） |
| PLS 假 Broker | mbedTLS | 127.11.45.14:8883（Aikari 运行时） |
| 真云 broker | — | 47.99.159.125:8883（防火墙阻断） |
| 配置服务器 | — | 121.43.97.62 / 115.227.42.75（未堵） |
| machine 劫持点 | — | 192.168.153.253:1883（fix1883 别名 + portproxy，残留） |

### 关键哈希

| 对象 | 值 |
|---|---|
| 新 CA 文件哈希（SHA1） | `E7978B998B9EA3033BB695D1F5B14C3B5FE53A36` |
| 新 CA 证书指纹 | `A713DC19E944C82B70A0A94598E1DC31004282FC` |
| 旧 CA 证书指纹 | `019B7BA0DF7C0A923815AD8CF5CAF58C502B87D3` |
| leaf SAN | `DNS:iot-broker.seewo.com, DNS:iot-broker-mis.seewo.com, IP:127.11.45.14, IP:127.0.0.1, IP:192.168.153.253` |
