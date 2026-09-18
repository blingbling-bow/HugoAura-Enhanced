# SeewoCore 技术分析与 TLS 劫持研究（合并版）

| 项目 | 内容 |
|------|------|
| 文档版本 | v2.0（合并版） |
| 合并日期 | 2026-09-12 |
| 时间跨度 | 2026-08-10 ~ 2026-08-30（diag18 ~ diag174） |
| 分析对象 | SeewoService **1.6.6.3993**（早期实验）/ **1.6.7.4010**（实际运行与终局分析）、HugoAura-Aikari |
| 适用范围 | 自有/授权管理设备的运维与安全分析 |
| 结论状态 | **已定性：TLS MITM 路线证伪（SChannel + SPKI pinning），管控走出网阻断** |

> **文档性质**：本文档记录对已安装希沃客户端组件的架构分析、二进制构成、TLS 校验层定位、劫持实验全过程、以及设备数据出网路径的完整测绘。用于设备所有者/IT 管理员理解并管控本机数据流向，不构成对任何第三方系统的攻击指导。
>
> **合并来源**：
> - 文档 A：`SeewoCore-技术分析文档.md`（v1.0，2026-08-30，终局定性，导入表级证据）
> - 文档 B：`SeewoCore_TLS_Interception_Manual.md`（2026-08-10~11，diag18–39 过程研究）
>
> **合并原则**：以证据链更晚、更硬的文档 A 为准；文档 B 中被后续实证修正的解释**保留行为观测、标注机制重述**。证据可信度标注沿用：✅ = 实测确认；🔶 = 高置信推断；❌ = 已证伪。

---

## 0. 关键结论演进对照（先读这里）

| 议题 | 文档 B（08-11）阶段认识 | 文档 A（08-30）终局定性 | 合并判定 |
|------|------------------------|------------------------|----------|
| TLS 后端 | 按 **OpenSSL 文件路径验证模式**解释信任锚行为 | 导入表实证：**Paho MQTT C 的 SChannel 构建**，校验走 CryptoAPI | ✅ 采用文档 A；文档 B 的行为观测（读文件/进程缓存）仍有效，机制重述见 §6 |
| 握手失败原因 | 主机名校验假设（leaf 缺 IP SAN）→ 待定 | **公钥（SPKI）pinning**，与 DN/SAN 内容无关（diag74 实证） | ❌ 主机名假设被取代；❌ 任何本地 CA/自签证书均无效 |
| 信任锚来源 | `machine\ca.crt` 文件（Procmon 实证，不读系统存储） | 同左，经 `CertOpenStore` 文件存储加载 | ✅ 一致 |
| OpenSSL 符号补丁 | 8.2 节列为 pinning 确认后的候选路线 | 实测无效：**符号在 SChannel 构建中不存在** | ❌ 原理性无效，路线关闭 |
| 零外连现象 | 归因🔶：ca.crt 替换破坏 MQTT 模块初始化校验 | 未直接讨论；diag74 已能做 DN 探测，说明连接行为已恢复 | 🔶 阶段性现象，归因未完全闭环（见 §9.3） |
| 版本基线 | 实验基于 `SeewoService_1.6.6.3993` 路径 | 本机实际运行 **1.6.7.4010**，二进制分析必须以 4010 为准 | 文件偏移一律以文档 A 附录 B 为准 |
| 真云 broker IP | 47.99.159.125:8883 | 121.40.135.143:8883（A 记录） | IP 由云端配置下发、随时间变化，两者均为实测值 |
| 最终路线 | 拟转入二进制 patch 路线 | **出网层阻断**（防火墙 + hosts），不触碰 TLS | ✅ 采用文档 A |

---

## 1. 环境与版本基线

### 1.1 主机与组件

| 项 | 值 |
|----|-----|
| OS | Windows 10 (10.0.19045) x64 |
| SeewoService（已安装，实际运行） | **1.6.7.4010** — `C:\Program Files (x86)\Seewo\SeewoService\SeewoService_1.6.7.4010\` |
| SeewoCore.exe | 1.6.7.4010，`...\SeewoCore\SeewoCore.exe` |
| 早期实验/桌面参考副本 | 1.6.6.3993 — `C:\Users\admin\Desktop\Aikari\SeewoService_1.6.6.3993\` |
| HugoAura-Aikari | `C:\Program Files\HugoAura\Aikari\` |
| SeewoAbility.exe | 1.6.5.2990（自报版本），`...\SeewoAbility\` |

> ⚠️ 文档 B 迁移记录为 1.6.6.3993，但实际运行 1.6.7.4010。**任何二进制分析以 4010 为准**，否则逆错版本。

### 1.2 已安装的相关服务与驱动

| 服务名 | 启动类型 | 二进制 / 说明 |
|--------|----------|--------------|
| `SeewoCoreService` | AUTO_START（失败恢复 30s 重启） | `SeewoCore.exe /winService` |
| `SeewoProxyLayerService` | DEMAND_START（失败恢复 10s） | `proxyLayerService.exe /winService`；**是 SeewoCore 的启动触发器**（见 §10.5） |
| `SeewoFreezeUpdateAssist` / `freeze` | — | 本地 RPC，端口 6082 |
| `SeewoLauncherGuard` | 看门狗 | 拉起 SeewoCore.exe（无 `/winService`） |
| `HugoAuraAikari` | AUTO_START | `Aikari-Launcher.exe --service runAs`（LocalSystem） |
| `SeewoKeLiteLady` | 内核驱动 | 自防护（SWSelfDefense），拦截 Seewo 目录写入（见 §10.6） |

---

## 2. HugoAura-Aikari 架构与劫持链路设计

### 2.1 模块组成

| 模块 | 职责 |
|---|---|
| **Launcher**（Main） | 生命周期管理、WebSocket 服务（`wss://127.0.0.1:22077`）、注册表/文件系统/配置管理、TLS 证书初始化 |
| **PLS**（Proxy Layer Services） | **核心**：创建假 MQTT Broker + 假 Client，修改 hosts，对 SeewoCore 的 MQTT 流量做 MITM（伪造上报、伪造集控指令） |
| **Aikari-Shared** | 日志（spdlog）、遥测（sentry）、配置、ITC 消息队列、hosts/服务/进程工具 |
| **Aikari-UI-Settings** | QML 前端，经 WebSocket 与 Launcher 通信 |

> **命名冲突提示**：README 中 PLS = "Proxy Layer Services"（Aikari 的代理层），希沃生态自身也有 `SeewoProxyLayerService` 服务，**同名不同物**。

### 2.2 PLS 劫持链路（`Aikari-PLS\init.cpp`）

```
① 探测 SeewoService profile（版本、SeewoCore 路径、broker 主机/端口）
② 加载规则脚本（resources\pls\rules，Lua）
③ 确保 MQTT TLS 证书（config\certs\mqtt.crt/.key，CN=broker 主机名，本地 CA 签发）
④ 写 hosts：127.11.45.14 iot-broker.seewo.com（带 HugoAura 标记行）→ flush DNS 缓存
⑤ 启动本地假 Broker（mbedTLS 3.6.4，ssl://<broker>:8883）
⑥ 杀 SeewoCore 进程 → 重启 SeewoCoreService（使新 hosts/证书生效）
⑦ 退出回滚：删除 hosts 条目、杀 SeewoCore、flush 日志
```

### 2.3 启动流程与配置资产

```
main()
 ├─ 解析 CLI（--service runAs / install / uninstall）
 ├─ 注册 Windows 服务（WinSvcManager）
 ├─ launchAikari()
 │   ├─ 状态/文件系统/注册表/配置管理器初始化
 │   ├─ WebSocket TLS 证书初始化（wss.crt）
 │   ├─ ws 服务启动 → wss://127.0.0.1:22077
 │   ├─ 加载子模块 PLS（DLL）
 │   └─ 运行时模式等待（NORMAL/DEBUG 信号退出 / SERVICE 等停事件）
 └─ 退出清理
```

| 文件 | 路径 | 说明 |
|------|------|------|
| 主配置 | `C:\ProgramData\HugoAura\Aikari\config\config.json` | `module=launcher`，`wsPreferPort=22077` |
| PLS 配置 | `...\config\config-pls.json` | broker 覆盖、规则开关（本机现有：`softwareReportPost{enabled,setAsEmpty}`、`freezeDiskInfoPost{frozenDisks:["c"]}`） |
| MQTT 证书 | `...\config\certs\mqtt.crt` / `mqtt.key` | 本地 CA 签发 |
| 本地 CA | `...\config\certs\ca.crt` / `ca.key`（含 `.bak`） | Root CA |
| WS 证书 | `...\config\certs\wss.crt` / `wss.key` | 供 `wss://127.0.0.1:22077` |
| 日志 | `C:\ProgramData\HugoAura\Aikari\log\Aikari_{PLS,ANY,Main}_YYYY-MM-DD.log` | 按日命名；**异步缓冲，正常退出才完整落盘** |

---

## 3. SeewoCore 二进制构成分析

### 3.1 框架定性

| 属性 | 值 |
|------|-----|
| 文件大小 | 2,275,168 字节 |
| PE 格式 | PE32（`0x010B`），i386 / x86（`0x014C`），运行于 WOW64 |
| 编译工具链 | MSVC 2015–2022（UCRT + VC Runtime） |
| **框架定性** | **原生 Win32 C++，无托管层** |

排除项（字符串与依赖核查）：

| 疑似框架 | 结论 | 依据 |
|----------|------|------|
| Electron / CEF | **排除** | 字符串 `Electron` 实为 "PNY Electronics" 误匹配 |
| Node.js | **排除** | `node` 实为 `httpserver.h1.node` 内部概念 |
| .NET / CLR | **排除** | 无 `mscoree`/CLR 导入 |
| Qt / Go / Rust | **排除** | 无对应符号特征 |

> 推论：**Frida / objection / SSL-unpinning 类工具不适用**（面向 Android/iOS 或托管运行时，本目标为无托管层原生 x86 进程）。

### 3.2 依赖 DLL 清单（SeewoCore 目录）

| 类别 | DLL | 说明 |
|------|-----|------|
| **MQTT 客户端** | `paho-mqtt3as.dll` | Eclipse Paho MQTT C（异步版） |
| **TLS 封装** | `iot_mqtt.dll` | 希沃自封装，基于 Paho |
| **业务插件** | `IotManagerPlugin.dll`、`IotPlugin.dll`、`IotPluginModule.dll`、`MachineClient.dll`、`PluginFrame.dll` | 插件框架与机器上报 |
| **网络** | `libcurl.dll`、`HttpClient.dll` | HTTP 客户端 |
| **序列化** | `jsoncpp.dll` | JSON（另有 protobuf） |
| **遥测/日志/XML** | `sentry.dll`、`apm_client.dll`、`crashpad_wer.dll`、`glog.dll`、`tinyxml2.dll` | — |
| **业务功能** | `media_capture_client.dll`、`screen_capture_client.dll`、`system_notify.dll` | 媒体/截屏/通知 |
| **自防护** | `GuardClient.dll`、`SWSelfDefense_SDK.dll` | 防护 |

### 3.3 `module\machine\`（机器上报核心，mTLS 材料所在）

| 文件 | 大小 | 说明 |
|------|------|------|
| `machine_zmodule.dll` | 1,237,608 B | 机器上报业务模块（**硬编码内网劫持点**，见 §11.2） |
| `mp_mqtt.dll` | 441,856 B | MQTT 包装层（仅导入 Paho Async 系列） |
| `paho-mqtt3as.dll` | 2,205,184 B | Paho MQTT C |
| `ca.crt` | 1,306 B | **信任锚**（原厂仅含 CVTE 内部测试 CA `CN=172.18.165.170`） |
| `seewo.crt` / `seewo.key` | 1,262 / 1,706 B | 客户端证书 / RSA 私钥（mTLS） |
| `seewo.csr` | 1,046 B | CSR |
| `hidapi.dll` / `lib_hid.dll` | — | HID 设备支持 |

---

## 4. TLS 后端定性（核心结论）

> **SeewoCore 的 MQTT-over-TLS 客户端栈是 `Paho MQTT C 的 Windows/SChannel 构建`。证书链校验走 Windows CryptoAPI（Crypt32），不存在 OpenSSL / mbedTLS 用户态实现。**

### 4.1 证据：导入表（rizin `ii`）

**`iot_mqtt.dll`（32 位）导入：**

```
CRYPT32.dll   CertOpenStore / CertFindCertificateInStore / CertEnumCertificatesInStore
              CertGetCertificateContextProperty / CertDuplicateCertificateContext
              CertFreeCertificateContext / CertCloseStore
bcrypt.dll    BCryptGenRandom
WS2_32.dll    ioctlsocket
paho-mqtt3as.dll  MQTTAsync_connect / MQTTAsync_sendMessage / MQTTAsync_subscribe
                  MQTTAsync_disconnect / MQTTAsync_createWithOptions / MQTTAsync_reconnect ...
```

**`module\machine\paho-mqtt3as.dll` 导入：**

```
CRYPT32.dll   CertOpenStore / CertFindCertificateInStore / CertEnumCertificatesInStore
              CertGetCertificateContextProperty / CertDuplicateCertificateContext
              CertFreeCertificateContext / CertCloseStore
              CryptBinaryToStringA / CryptStringToBinaryA
WS2_32.dll    connect / socket / recv / send / select / getaddrinfo / WSASend ...
```

### 4.2 推论

1. TLS 握手与证书校验由 **Paho 的 SChannel 端口**调用 Windows CryptoAPI 完成；信任锚来自 `machine\ca.crt`（经 `CertOpenStore` 文件存储打开）；客户端身份来自 `seewo.crt` + `seewo.key`（mTLS）。
2. 任何针对 **OpenSSL 符号**（`SSL_CTX_set_verify`、`X509_verify_cert`）的补丁**在该进程中不存在对应函数**，必然无效（已实测，见 §9.4）。
3. 配合 **SPKI pinning**（diag74 实证），本地 CA / 自签证书一律被拒 → **文档 A 判定：PLS 拦截方案对 4010 无效，TLS MITM 路线证伪**。

---

## 5. 劫持拓扑与握手行为演化

### 5.1 拦截拓扑

```
SeewoCore.exe
   │  (hosts: iot-broker.seewo.com -> 127.11.45.14)
   ▼
HugoAura PLS MQTT Broker  (mbedTLS 3.6.4 server, ssl://iot-broker.seewo.com:8883)
   │
   ▼ (假 Client，同 clientId/username/password/keepAlive)
真实云端 Broker (iot-broker.seewo.com:8883)
```

### 5.2 失败现象的五个阶段

| 阶段 | 现象 | 判定 |
|------|------|------|
| ① alert 48（早期） | 客户端发 fatal alert `[2:48] certificate_unknown`，error `-30592` | 信任锚缺失/不匹配 → 表现为**明确 alert**（后经本地 CA 部署修复） |
| ② 静默 RST（diag32-33，08-11） | 握手推进至 `server state: 5`（ServerHelloDone 写出）→ 对端 TCP 直接 RST，无任何 alert；PLS 侧 `f_send` 失败返回 **-78**（`MBEDTLS_ERR_SSL_CONN_EOF`）；约 **65 秒周期**重复 | 校验在 TLS 协议层之外直接断开 → 指向主机名校验或 pinning |
| ③ 零外连（diag35-38，08-11） | IP-SAN 证书双端部署后，SeewoCore **从不发起任何 broker 连接**，仅监听 0.0.0.0:8883 | 🔶 归因：ca.crt 内容替换破坏 MQTT 模块初始化校验（见 §9.3） |
| ④ DN 探测（diag74） | 客户端恢复连接后，对 `CN=*.seewo.com` 的自签证书**依然拒绝** | ✅ **pin 的是 broker 公钥（SPKI），与证书 DN/链内容无关** |
| ⑤ 补丁无效实测（diag97/171/173/174） | patch `X509_verify_cert`→`mov eax,1;ret`（@0x156fc0）、`SSL_CTX_set_verify` mode 3→0（@0x14c543）后：alert 消失但改为 `-78 NET/WSA 10053`（连接被 RST），握手仍未完成 | ✅ 两处补丁均未生效——OpenSSL 符号在 SChannel 构建中不存在，写入的是无关字节 |

### 5.3 出网路径测绘（数据流向）

| 进程 | 目标 | 端口 | 协议 | 用途 |
|------|------|------|------|------|
| `SeewoCore.exe` | `121.40.135.143`（文档 B 期为 `47.99.159.125`） | 8883 | MQTT over TLS | 真实云端 broker（`iot-broker.seewo.com` A 记录） |
| `SeewoCore.exe` | `192.168.153.253` | 1883 | MQTT | **内网 fallback broker = 设计好的劫持点**（machine 模块硬编码，见 §11.2） |
| `SeewoAbility.exe` | `60.188.7.227` | 443 | HTTPS | 云端 API / 配置 |

**云端配置下发通道（broker 地址来源）**：SeewoCore 的目标 broker 地址并非硬编码，而是由 **8002 端口的云端配置下发**（SeewoAbility 内字符串 `CLOUD-CONFIG.acIpListV1`、`http://%s:8002/api/v2/file/check`、`DistributeCloudConfig`、`AC ServerList:`）动态提供。切断 8002 即从源头阻断 broker 寻址。

**本地 RPC 面（`HKLM\SOFTWARE\WOW6432Node\Zeus\Rpc`）**：

```
SeewoGuard / SeewoMachine / SeewoProxy : SeewoCore.exe       ZEUS_RPC
SeewoProxyHttp                         : SeewoCore.exe       HTTPS
tcpProxyServer                         : SeewoCore.exe       port 8883
SeewoHugoHttp                          : SeewoAbility.exe    HTTPS
SeewoMediaCapture                      : media_capture.exe   ZEUS_RPC
freeze                                 : SeewoFreezeUpdateAssist  port 6082
```

> 唯一出网一跳是 SeewoCore 的 MQTT-over-TLS；其余为本地/进程间通信。

---

## 6. TLS 信任锚与证书机制规格

> 以下**行为规格**由文档 B Procmon 实测确立，全部保留有效；**机制解释**按文档 A 的 SChannel 定性重述。

### 6.1 信任锚规格

| 角色 | 文件 | 说明 |
|---|---|---|
| 信任锚（CA） | `...\SeewoCore\module\machine\ca.crt` | 每次握手前读取（Procmon 实证）；支持多 PEM 块拼接 |
| 客户端证书 | `...\SeewoCore\module\machine\seewo.crt` | 握手中随 ClientHello 携带 |
| 客户端私钥 | `...\SeewoCore\module\machine\seewo.key` | 与 seewo.crt 配对 |

### 6.2 行为规格

1. **验证路径**：信任锚硬编码为 machine 目录下的 `ca.crt`；**不读** `C:\Program Files (x86)\Common Files\SSL\cert.pem`（该字符串存在于 DLL 中，但 Procmon 证实 0 次访问——*字符串扫描 ≠ 行为证据*）；**不依赖** Windows 证书存储。机制上由 Paho SChannel 端口经 `CertOpenStore`（文件存储）加载。
2. **读取时序**：每次 8883 连接握手期间（TCP Connect → ClientHello 之前）读取三个文件。
3. **进程级缓存**：信任锚文件在进程生命周期内有缓存，**修改文件后必须重启 SeewoCore 进程**才生效。
4. **防篡改覆盖**：`Verify.json` 校验清单仅含 dll（如 mp_mqtt.dll），**不含 crt 文件** → 修改 ca.crt 不触发防篡改保护；CRC 机制确存在且可绕过写保护（先停驱动写入）。
5. **配置不可切换**：信任锚路径硬编码（非注册表/配置文件可改）。

### 6.3 Pinning 定性（diag74，✅）

客户端在 DN 为 `CN=*.seewo.com` 的情况下依然拒绝自签证书 → **pin 的是 broker 公钥（SPKI），与证书 DN/链内容无关**。IP-SAN 补全（diag27、fix_ip_san）同样无效。

---

## 7. 实验时间线总表（diag18 → diag174）

| 时间（2026-08） | diag | 事件 | 阶段结论 |
|---|---|---|---|
| 08-10 21:27 | — | `real_broker.crt` 抓取（真云证书 1678B） | SAN/签发者比对基准 |
| 08-11 00:10 | — | Procmon 取证：每次握手读 `machine\{ca.crt, seewo.crt, seewo.key}`，从不读 cert.pem / 系统存储 | ✅ 信任锚 = machine\ca.crt 文件 |
| 08-11 21:31~21:35 | diag32 | SeewoCore 首次连到本地 PLS（127.11.45.14:8883），`server state: 5→6` 后对端 RST | ✅ hosts 劫持链路打通；失败点 = ServerHelloDone 之后 |
| 08-11 21:33~21:41 | diag33 + fix1883 | `machine_zmodule.dll` 硬编码 `ssl://192.168.153.253:1883` → IP 别名 + portproxy 1883→8883 → PLS 收到握手（仍 -78） | ✅ machine 模块经 portproxy 连到 PLS；主机名校验假设提出 |
| 08-11 21:45~22:0x | fix_ip_san / fix_ip_san2 | 生成 IP-SAN 新证书集；Seewo 侧 ca.crt 部署成功（需停驱动窗口，文件哈希 E7978B99） | ✅ 新 CA 双端就位 |
| 08-11 22:0x~22:5x | diag34–38 | 判定基准 bug（文件哈希 vs 指纹）；**零外连**观测；服务生态测绘（双轨互斥、proxy 触发器） | 🔶 归因 ca.crt 破坏初始化；diag39 未执行 |
| — | diag74 | DN 探测：`CN=*.seewo.com` 仍被拒 | ✅ **SPKI pinning 实锤** |
| — | diag97 | patch `SSL_CTX_set_verify` mode 3→0（@0x14c543） | ❌ 无效（OpenSSL 符号不存在） |
| — | diag125/141 | 出网实测（8883/1883/443 目标确认） | ✅ 出网路径测绘 |
| — | diag161 | `fix_ca.crt` 实验 | pinning 佐证 |
| — | diag171 | 内存注入 patch（WriteProcessMemory） | ❌ 方向错误（OpenSSL 符号） |
| — | diag173 | 磁盘补丁写前停驱动 → 写成功；patch `X509_verify_cert`（@0x156fc0） | ❌ 无效；✅ 驱动对抗窗口验证 |
| — | diag174 | 合并补丁 + CRC/Verify.json 同步 | ❌ 无效；✅ Verify.json CRC 机制确证 |

---

## 8. 假设验证与排除汇总

| # | 假设 | 验证手段 | 结论 |
|---|------|----------|------|
| 1 | 信任锚在系统证书存储 / cert.pem | Procmon 全程文件访问对齐 | ❌ 硬编码 `machine\ca.crt`，不读系统存储 |
| 2 | 证书链/私钥/扩展/编码问题（diag20-30） | DER 修复、BOM 排除、AKI/SKI 补全、数学验证（Modulus/签名链） | ✅ 全部排除，证书完全健康 |
| 3 | 主机名校验（leaf 缺 IP SAN） | IP-SAN 证书集生成与双端部署 | ❌ 被取代——DN/IP SAN 均无效，实为 SPKI pinning |
| 4 | 缺 ProxyLayerService 导致零外连 | diag38 启动 proxy → 仍零外连 | ❌ |
| 5 | 服务模式 vs 看门狗模式行为差异 | diag37 两模式一致 | ❌ |
| 6 | hosts 劫持失效导致不连 | diag38：Aikari 退出后仍监听 8883 | ❌ |
| 7 | 零外连 = ca.crt 替换破坏初始化校验 | 时序证据：唯一成功握手轮次全部发生在替换前 | 🔶 高置信，未完全闭环（恢复出厂 ca.crt.bak 实验未执行） |
| 8 | OpenSSL 符号补丁可关闭校验 | diag97/171/173/174 四轮实测 | ❌ **符号在 SChannel 构建中不存在，原理性无效** |
| 9 | DN 伪装（`CN=*.seewo.com`）可过校验 | diag74 | ❌ pinning 比对公钥，DN 无关 |

---

## 9. 服务生态与运行时机制

### 9.1 SeewoCore 双轨启动机制（✅）

```
轨道 A（看门狗）: SeewoLauncherGuard ──拉起──> SeewoCore.exe（无 /winService）
轨道 B（服务）  : SeewoCoreService ──sc start──> SeewoCore.exe /winService
                    └─ 单例互斥：轨道 A 进程存活 → 轨道 B 启动后 5 秒内自停
```

- 时序证据（diag37）：22:33 `sc start` → PID 6016 启动 5 秒后 STOPPED（看门狗进程 16988 在位）；22:37 杀 16988 后服务模式 16776 成功。
- **服务状态 ≠ 进程状态**：看门狗可绕过服务直接拉进程，`sc query` 不可作为进程存活依据。
- Aikari 的"确保服务运行"逻辑（`service.cpp:196`）依赖轨道 B 作为重启路径之一。

### 9.2 MQTT 重连周期状态机

```
[被杀] ──看门狗拉起（20-40s）──> [启动]
  ├─ 直连真云（云端下发 IP，绕过 DNS/hosts）
  │     └─ 防火墙出站阻断 → SYN_SENT 悬挂 → ~65s 周期重试
  └─ 多轮失败后回退 hosts 劫持地址 127.11.45.14:8883
        └─ TLS 握手（结果取决于证书链路状态）
```

- 重连周期 ≈ **65 秒**；真云地址来自**云端配置下发**（直接 IP，绕过 DNS）——这是"hosts 劫持必须配合防火墙堵真云 IP"的根本原因。
- 完整周期（杀 → 拉起 → 真云尝试 → 回退本地）**≥ 6 分钟**；短窗口观测"零握手"为假阴性（diag34 教训）。

### 9.3 零外连行为（diag35-38，🔶 归因未闭环）

- 现象：SeewoCore 仅监听 `0.0.0.0:8883` + 9 条 Established → `127.0.0.1:57676`（SeewoAbility），无任何 broker 外连。
- 条件性监听：8883 监听是 SeewoCore 自身的**主动占坑待命**行为，与 hosts/proxy 状态的相关性不成立；任何一轮采样均未观察到其主动连 8883。
- 当前归因（🔶）：`machine\ca.crt` 内容被替换 → 破坏 MQTT 模块初始化校验 → **功能静默禁用**（不抛错、不连接）。关键时序：唯一成功握手轮次全部发生在替换前。
- 后续（文档 A 期）diag74 能做 DN 探测，说明连接行为已恢复（恢复过程两份文档均未记录）；**归因闭环实验（恢复出厂 ca.crt.bak）未执行**。

### 9.4 SeewoAbility（127.0.0.1:57676）

- SeewoCore 每次启动固定建立 **9 条 Established 连接**，是其唯一外部通信对象；角色未确认（🔶 推测配置下发/能力上报中心；是否持有 broker 配置来源未知）。

### 9.5 SeewoProxyLayerService：启动触发器（✅）

- DEMAND_START；`sc start SeewoProxyLayerService` 后 **1 秒内** SeewoCore 自动启动（diag38：22:50:20 → 22:50:21），与运行轨道无关。服务生态分析需按依赖链展开。

### 9.6 SeewoKeLiteLady 文件保护驱动

- 拦截 Seewo 目录写入，**管理员权限同样被拒**；杀进程后依旧。
- **对抗时序窗口**（fix_ip_san2 验证成功）：

```
1. taskkill SeewoCore.exe      （先杀，防占用）
2. sc stop SeewoKeLiteLady
3. 立即复制/写入                （1-3 秒窗口；守护进程可能抢拉驱动 → 1056）
4. sc start SeewoKeLiteLady    （恢复保护）
5. 失败则重试整轮
```

### 9.7 hosts 劫持生命周期与日志机制约束

- Aikari 启动写入条目（127.11.45.14 等）→ flush DNS；运行中条目在位；退出删除条目 → flush DNS。
- **日志异步缓冲**：运行中读盘可能为空，只有正常退出（"Flushing logger..."）才完整落盘。读取日志时机必须晚于 Aikari 正常退出，否则产生"零握手"假象。

---

## 10. 方案尝试总表（8 项，全量）

| # | 方案 | 手段 | 结果 | 原因 |
|---|------|------|------|------|
| 1 | TLS MITM（替换 ca.crt） | 劫持 8883 | 失败 | 客户端 pinning；驱动保护阻止替换（后经停驱动窗口突破，见 #7） |
| 2 | DN 匹配伪装（`CN=*.seewo.com`） | 自签同名证书（diag74） | 失败 | pinning 比对公钥，DN 无关 |
| 3 | Patch `SSL_CTX_set_verify` mode 3→0 | diag97 `@0x14c543` | 无效 | OpenSSL 符号在 SChannel 构建中不存在 |
| 4 | Patch `X509_verify_cert` 返回 1 | diag173 `@0x156fc0` | 无效 | 同上 |
| 5 | 合并补丁 + CRC/Verify.json 同步 | diag174 | 无效 | 同上；CRC 机制确存在且可绕过写保护 |
| 6 | 磁盘补丁写前停驱动 | diag173 | 写成功 | 需先 `sc stop SeewoKeLiteLady` + 停 SeewoCoreService |
| 7 | PLS 本地 broker 拦截（含 IP-SAN 证书） | HugoAura + fix_ip_san | 失败 | SChannel + SPKI pinning 拒绝本地证书 |
| 8 | 内存注入 patch（diag171） | WriteProcessMemory | 未验证/方向错误 | 目标函数同为 OpenSSL 符号 |

**共性结论**：#3–5、8 的共同错误是**在与 TLS 后端不匹配的符号上下刀**；#1、2、7 的共同障碍是**公钥 pinning**。

---

## 11. 当前资产与二进制状态核对

### 11.1 二进制状态（08-30 核实，✅ 未修改）

| 校验项 | 值 |
|--------|-----|
| `iot_mqtt.dll` SHA256（已安装 = 原始备份，逐字节一致） | `156D50E7B9119642297E75E6275C53AA57C3A9F3C30482069094759DF7E39A0D` |
| 文件 CRC32（hexLE） | `96e3646f`（原始值） |
| `@0x156fc0` | `56 8b 74 24 08 57`（原始函数序言） |
| `@0x14c542` | `6a 03`（原始值） |

> 两处实验性补丁**已不在磁盘上**，`Verify.json` CRC 为原始值，系统处于未修改状态，无需还原。历史备份：`C:\Users\admin\Desktop\HugoAura-Aikari\diag165\iot_mqtt.dll.orig`、`diag97_patch\iot_mqtt.dll.pre_*`。

### 11.2 证书与网络资产

| 项目 | 值 / 路径 | 状态 |
|---|---|---|
| 新 CA 文件哈希（SHA1） | `E7978B998B9EA3033BB695D1F5B14C3B5FE53A36` | Aikari certs ✅ / Seewo 锚点 ✅ |
| 新 CA 证书指纹（DER SHA1） | `A713DC19E944C82B70A0A94598E1DC31004282FC` | — |
| 旧 CA 证书指纹 | `019B7BA0DF7C0A923815AD8CF5CAF58C502B87D3` | 无文件备份 |
| leaf SAN | `DNS:iot-broker.seewo.com, DNS:iot-broker-mis.seewo.com, IP:127.11.45.14, IP:127.0.0.1, IP:192.168.153.253` | 已部署（无效果） |
| Aikari certs 目录 | `C:\ProgramData\HugoAura\Aikari\config\certs\` | 新 IP-SAN 4 文件 |
| Seewo 信任锚 | `...\SeewoCore\module\machine\ca.crt`（出厂备份 `ca.crt.bak` 存在） | 已被替换（🔴 与出厂不一致） |
| 生成/部署脚本 | `e:\HugoAura-Aikari\gen_ip_san_certs.py`、`fix_ip_san_certs\`、`fix_ip_san*.bat` | 在库 |
| fix1883 残留 | IP 别名 `192.168.153.253` + portproxy `1883→8883` | **仍在位**（清理见 §14.3） |
| 防火墙 | 47.99.159.125:8883 出站阻断 ✅；配置服务器 121.43.97.62 / 115.227.42.75 未堵 | 见 §12 |
| ⚠️ 遗留风险 | Seewo 侧 `machine\ca.crt` 仍为新 CA 而非出厂值 | 建议按 §14.5 恢复实验一并处理 |

---

## 12. 出网管控（推荐路线）

### 12.1 管控脚本（`C:\Users\admin\Desktop\Aikari-Next\scripts\`）

| 文件 | 作用 |
|------|------|
| `block-seewo-outbound.ps1` | 出网阻断：防火墙出站规则 + hosts DNS 兜底 + 自动验证 |
| `unblock-seewo-outbound.ps1` | 回滚：移除全部规则、恢复 hosts、刷新 DNS |
| `SeewoCore-Reverse-Analyzer.py` | 逆向辅助框架（字符串/proto 提取，仅供参考） |

### 12.2 阻断覆盖范围

| 规则名 | 进程 | 目标 |
|--------|------|------|
| Block-SeewoCore-Cloud-Broker-8883 / -All | SeewoCore | 121.40.135.143 (8883 / 任意端口) |
| Block-SeewoCore-Internal-Broker-1883 / -All | SeewoCore | 192.168.153.253 (1883 / 任意端口) |
| Block-SeewoAbility-Cloud-443 / -All | SeewoAbility | 60.188.7.227 (443 / 任意端口) |
| Block-SeewoCore-Outbound-8883 / -1883-Global | SeewoCore | 互联网 IP 对应端口（兜底） |
| **Block-SeewoCore-CloudConfig-8002-Global** | SeewoCore | 互联网 IP:8002（配置下发，**源头阻断**） |

hosts 兜底条目（→ `127.0.0.1`）：`iot-broker.seewo.com`、`cloud-config.seewo.com`、`appstore.seewo.com`、`update.seewo.com`、`device.seewo.com`、`api.seewo.com`、`report.seewo.com`、`seewo.com`、`api.cvte.com` 等 12 条。

**特性**：防火墙规则持久化、重启有效、脚本幂等；执行后自动验证 DNS 解析、防火墙规则状态、残留连接。

```powershell
cd C:\Users\admin\Desktop\Aikari-Next
.\scripts\block-seewo-outbound.ps1     # 阻断出网
.\scripts\unblock-seewo-outbound.ps1   # 需要恢复时
```

---

## 13. 总结论

1. **SeewoCore 为原生 Win32 C++**，MQTT 客户端为 Paho C（Windows/SChannel 构建），mTLS 材料在 `module\machine\`。
2. **TLS 证书校验走 Windows CryptoAPI**，不存在 OpenSSL/mbedTLS 用户态路径；配合**公钥（SPKI）pinning**，本地 CA / 自签证书 / DN 伪装 / IP-SAN 补全一律被拒。
3. **所有针对 OpenSSL 符号的补丁在原理上无效**（符号不存在于该构建中），已四轮实测确认。
4. **Frida / objection / SSL-unpinning 类工具不适用**（目标为无托管层的原生 x86 进程）。
5. **数据出网路径明确**：broker 寻址来自 8002 配置下发 → 8883/1883 MQTT 上报；443 辅助通道；真云 IP 动态变化且绕过 DNS。
6. **管控本机数据流向无需触碰 TLS**：出网层（防火墙 + hosts）阻断即可，一次性配置、零长期维护。
7. **Aikari PLS 的 MITM 设计（假 Broker + 本地 CA）在 1.6.7.4010 上被证伪**；其工程价值保留于：hosts 劫持链路打通、驱动对抗窗口、服务生态测绘、Lua 规则引擎（可服务于自建采集方案）。
8. **静默失效模式**是本研究最重要的行为学发现：客户端可能因信任锚校验失败**完全关闭网络功能而不抛任何错误**——排查此类问题时，"无报错"本身就是关键信号。

---

## 14. 未决问题与后续研究方向

### 14.1 ~~主机名校验 vs pinning~~（已收束）

由 diag74（DN 无关）+ 导入表定性（SChannel）+ 四轮补丁无效收束为：**SPKI pinning，无用户态绕过价值**。不再投入。

### 14.2 信任锚恢复实验（验证零外连归因，若继续研究则为最高优先级）

```
1. 执行 diag39 确认 ca.crt.bak 存在及内容（是否为出厂 CA）
2. 停驱动 → 备份当前 ca.crt → 用 ca.crt.bak 覆盖 machine\ca.crt → 恢复驱动
3. 重启 SeewoCore（或整体重启 Aikari）
4. 6 分钟采样：恢复"连真云 → 回退本地"行为 = 零外连归因成立
```

> 该实验同时回答：①零外连是否由信任锚文件内容触发；②顺带把 Seewo 侧 ca.crt 恢复出厂状态（清理 §11.2 遗留风险）。

### 14.3 fix1883 网络残留清理

```
netsh interface ipv4 delete address ...   （原接口/前缀）
netsh interface portproxy delete v4tov4 listenport=1883 listenaddress=192.168.153.253
```

清理后 machine 模块的 `ssl://192.168.153.253:1883` 将指向真实网络（被防火墙 1883 兜底规则阻断）。

### 14.4 配置服务器流量阻断

121.43.97.62 / 115.227.42.75 未堵；候选策略为加出站阻断杜绝 SeewoCore 获取真云 broker IP。⚠️ 堵配置服务器可能改变 SeewoCore 行为，需与零外连现象做判别实验隔离。

### 14.5 建议的合规管控路径

- **出网管控（推荐，即时生效）**：见 §12。
- **自建设备管理（长期）**：① 在 HugoAura 中新增设备信息采集模块（系统/磁盘/进程/网络）；② 部署自建接收后端，数据完全落在自有基础设施；③ 如需推送/控制能力，用开源 MDM（如 MeshCentral）替代厂商云。与出网阻断互补："数据不出网 + 数据自己管"。
- **不建议继续的方向**：OpenSSL 语义补丁（后端不匹配）；动态 unpinning 工具（不适用原生进程，且属对抗系统级校验）；与 `SWSelfDefense`/`SeewoKeLiteLady` 驱动层对抗（风险高、不可持续）。

---

## 15. 技术踩坑记录（13 条，全程有效）

| # | 踩坑点 | 机制 / 教训 |
|---|---|---|
| 1 | 日志异步缓冲 | Aikari 运行中读盘为空，正常退出后才完整；采样时机先于日志完整性要求 |
| 2 | 观测窗口不足 | 完整重连周期 ≥ 6 分钟，短窗口"零握手"必假阴性 |
| 3 | 文件哈希 ≠ 证书指纹 | 对比基准必须先声明（Get-FileHash vs Thumbprint），混用导致成功误判为失败 |
| 4 | 驱动对抗窗口 | 停驱动后守护可能 3 秒抢拉（1056）；写入窗口 1-3 秒，须"杀进程→停驱动→立即写→恢复" |
| 5 | 服务状态 ≠ 进程状态 | 看门狗直拉进程绕过服务管理，`sc query` 不可作为进程存活依据 |
| 6 | 单例互斥 | 双轨互斥，服务模式启动前必须先清除看门狗轨道进程 |
| 7 | PEM 写入 BOM 污染 | PowerShell 默认编码带 UTF-8 BOM，破坏 PEM 解析 |
| 8 | PowerShell 5.1 中文乱码 | 无 BOM UTF-8 脚本中的中文注释破坏语法；脚本保持全 ASCII |
| 9 | 批处理 CRLF | .bat 被写成 LF 会导致解析崩溃；交付前 CRLF 转换 + 提权自检 |
| 10 | Node 终端吞 `$_` | 改用临时 .ps1 文件执行 |
| 11 | 静默失效模式 | 信任锚校验失败可能表现为完全关闭网络功能且不抛错 |
| 12 | 字符串扫描 ≠ 行为证据 | 二进制字符串只能作线索，最终以 Procmon 行为观测为准 |
| 13 | **在与 TLS 后端不匹配的符号上下刀** | 补丁前必须先定性目标构建的 TLS 后端（导入表定性），否则全部无效 |
| 14* | 版本错位 | 迁移文档记录版本 ≠ 实际运行版本；二进制分析前先核实安装版本 |

---

## 16. 附录

### 16.1 证据文件索引

| 证据 | 位置 |
|------|------|
| TLS 后端导入表 | §4.1（rizin `ii` 于 `iot_mqtt.dll`、`paho-mqtt3as.dll`） |
| 握手失败日志 | `C:\ProgramData\HugoAura\Aikari\log\Aikari_PLS_2026-08-14.log`、`..._2026-08-30.log` |
| 出网实测 | `HugoAura-Aikari\diag141_result.txt`、`diag125_result.txt` |
| 配置下发通道 | `diag126_result.txt`、`diag108_result.txt`、`diag109_result.txt` |
| DN/公钥 pinning 实验 | `diag74_dn_probe.ps1`、`diag161_fix_ca.crt.ps1` |
| 补丁脚本 | `diag97_patch_iot.ps1`、`diag171_patch_immediate.ps1`、`diag173_diskpatch.ps1`、`diag174_combined_patch.ps1` |
| 服务配置 | `sc qc HugoAuraAikari` / `SeewoCoreService` / `SeewoProxyLayerService` |
| PLS 源码 / 启动源码 | `HugoAura-Aikari\Aikari-PLS\init.cpp`、`HugoAura-Aikari\Aikari-Launcher\entrypoint.cpp` |
| 证书生成产物 | `e:\HugoAura-Aikari\fix_ip_san_certs\`、`gen_ip_san_certs.py` |

### 16.2 diag 脚本清单（复现参考）

| 脚本 | 验证 / 观测现象 | Aikari 需运行 | 关键输出 |
|---|---|---|---|
| diag18-19 | 私钥/证书格式基础检查 | — | 证书生成链路基线 |
| diag20 | PLS TLS 服务端监听（私钥 DER 修复后） | 是 | `127.11.45.14:8883 LISTENING` ✅ |
| diag21 | 信任锚路径线索（DLL 字符串扫描） | 否 | `cert.pem` 字符串（曾误导） |
| diag22-23 | C# 证书生成 / 部署落盘验证 | 否 | 揭露部署验证假阳性 |
| diag24 | 驱动写入拦截与进程存活相关性 | 否 | Access denied → 锁定驱动 |
| diag25-26 | 停驱动写入可行性 / BOM 因素排除 | 否 | 写入成功；BOM 排除 |
| diag27 | AKI/SKI 扩展缺失排除 | 否 | 仍失败 → 排除 |
| diag28 | 环境因素隔离（SO_REUSEADDR 占坑等） | 否 | 暴露占坑问题 |
| diag29-30 | PLS 证书加载正确性 / 数学完备性 | 是 | 证书健康 ✅ |
| diag31 | pinning 常量扫描 + machine 模块配置测绘 | 否 | 无硬编码指纹；发现 192.168.153.253 |
| diag32-33 | 握手阶段推进与失败点 / 硬编码劫持点确认 | 是 | server state 5→6、-78 |
| diag34 | CA 双端部署验证（判定基准错位） | 是 | ⚠️ 文件哈希 vs 指纹 bug |
| diag35 | 长窗口连接行为采样（6 分钟 × 8） | 是 | 8883 条件监听 + 零外连 ✅ |
| diag36 | 服务/进程/端口/防火墙全景（只读） | 否 | SeewoCoreService STOPPED；57676=SeewoAbility |
| diag37 | 服务 vs 看门狗模式差异与单例互斥 | 是 | 6016 失败 / 16776 成功 ✅ |
| diag38 | ProxyLayerService 启动触发 | 是 | proxy → SeewoCore 1s 触发；仍零外连 ✅ |
| diag39 | 信任锚与出厂备份只读侦察 | 否 | **未执行** |
| diag74 / 97 / 125 / 141 / 161 / 165 / 171 / 173 / 174 | 见 §7 时间线 | — | pinning 实锤 / 补丁无效 / 出网测绘 |

### 16.3 关键常量与路径速查

```
# 拦截/阻断相关
hostTargetAddress = 127.11.45.14
hostMarker        = "# This line is generated by HugoAura-Aikari, ..."
swCoreProcName    = SeewoCore.exe
brokerHosts       = iot-broker.seewo.com / iot-broker-mis.seewo.com
brokerPort        = 8883
wsServer          = wss://127.0.0.1:22077

# 出网目标（IP 随云端下发变化，均为实测值）
cloudBroker       = 121.40.135.143:8883   （文档 B 期实测 47.99.159.125:8883）
internalBroker    = 192.168.153.253:1883  （machine 模块硬编码劫持点）
abilityCloud      = 60.188.7.227:443
cloudConfig       = http://<ac-server>:8002/api/v2/file/check   (acIpListV1)

# 关键路径
SeewoCore         = C:\Program Files (x86)\Seewo\SeewoService\SeewoService_1.6.7.4010\SeewoCore\
信任锚/mTLS 材料  = ...\SeewoCore\module\machine\{ca.crt, seewo.crt, seewo.key}
Aikari 证书       = C:\ProgramData\HugoAura\Aikari\config\certs\
Aikari 日志       = C:\ProgramData\HugoAura\Aikari\log\Aikari_{PLS,ANY,Main}_YYYY-MM-DD.log

# 文件偏移（iot_mqtt.dll 4010，均无效，当前为原始字节）
@0x14c542  原 6A 03
@0x156fc0  原 56 8B 74 24 08 57
```

### 16.4 关键哈希速查

| 对象 | 值 |
|---|---|
| `iot_mqtt.dll` SHA256（原始 = 当前） | `156D50E7B9119642297E75E6275C53AA57C3A9F3C30482069094759DF7E39A0D` |
| `iot_mqtt.dll` CRC32（hexLE） | `96e3646f` |
| 新 CA 文件哈希（SHA1） | `E7978B998B9EA3033BB695D1F5B14C3B5FE53A36` |
| 新 CA 证书指纹（DER SHA1） | `A713DC19E944C82B70A0A94598E1DC31004282FC` |
| 旧 CA 证书指纹 | `019B7BA0DF7C0A923815AD8CF5CAF58C502B87D3` |

---

*文档结束。合并自《SeewoCore-技术分析文档.md》（2026-08-30）与《SeewoCore_TLS_Interception_Manual.md》（2026-08-11），冲突项以证据链更晚者为准，演进对照见 §0。*
