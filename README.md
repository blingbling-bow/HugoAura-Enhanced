<center><img src="https://s2.loli.net/2025/04/18/IpZL7qMw2KFEi8o.png" /></center>

<h1 align="center">HugoAura<br/>Enhanced</h1>
<h4 align="center">下一代希沃管家注入式修改方案</h4>
<div align="center">
  <a href="https://github.com/blingbling-bow/HugoAura-Enhanced">首页</a> · <a href="https://github.com/blingbling-bow/HugoAura-Enhanced/issues">反馈</a> · <a href="https://forum.smart-teach.cn/t/hugoaura">社区</a>
</div>

> [!TIP]
> HugoAura 的首个预览版已发布! [查看安装教程](https://github.com/HugoAura/HugoAura/wiki)

> [!TIP]
> 在[此处](https://docs.aurax.cc/)查看 HugoAura 的文档与安装教程

> [!WARNING]
>
> 我们正在进行品牌形象更新, 本仓库 (`HugoAura/Seewo-HugoAura` / HugoAura SSA Electron Injection Loader) 将会逐渐改称 `HugoAura-Main`。这是为了区分 Project HugoAura 与 HugoAura SSA Electron Injection Loader 二者。

> [!WARNING]
>
> ~~我们正在使用 C++ 重构 PLS, 新的子项目代号为 [Aikari-Next]，是一款针对希沃易+系列软件的全面调整的体验工具。通过细分模块，让用户对希沃易+软件获得更高的自由度、更好的用户体验。其将集成 MQTT 消息中转、HugoAura 自动更新、特权操作辅助等功能。~~
> 
> 由于个人技术能力有限，本项目中的 SeewoCore MQTT TLS 劫持部分（Aikari PLS 子功能）已停止开发。整个 TLS 握手链路涉及 mbedTLS 服务端配置、证书校验与协议层细节，远超我的技术处理范围，暂时无法突破。
> 
> 我已将全部实验记录、机制分析与未决问题整理成技术文档 SeewoCore_TLS_Interception_Manual.md ，供后续有能力、有兴趣的开发者参考。欢迎 fork 本仓库并继续推进这一课题，让这部分功能得以完成。
> 
> 您依然可以提出 Feature Request 或 Bug Report。开发者将在能力 / 时间限度内尽可能处理。

> [!WARNING]
>
> ~~这是 HugoAura-Main 的一个分支。请查看主仓库 [HugoAura/Seewo-HugoAura](https://github.com/HugoAura/Seewo-HugoAura/)~~
> 主仓库已失效，请以本仓库为准。

> [!IMPORTANT]
> 已经过测试的希沃管家版本: v1.6.7.4010

> [!IMPORTANT]
> **温馨提示**：本项目有部分成分由**氛围编程 (Vibe Coding)** 方式编写。
> 
> 如果您对此类项目有固有的排斥感，请无视此项目，谢谢。

> [!NOTE]
> **社群信息**
>
> - [QQ 群 (用户自治，已禁言)](https://qm.qq.com/q/buo7m9oHBK)
> - [Telegram 公告频道](https://t.me/HugoAura)
> - [Telegram 群组](https://t.me/HugoAura_Chat)

![Repobeats](https://repobeats.axiom.co/api/embed/69b5be5daacef624b8f5e4b8966a0b5898439a22.svg "Repobeats analytics image")

## ✨ 概览

[天下](https://www.bilibili.com/video/BV1UN4y1k7bA) [苦希沃管家](https://www.bilibili.com/video/BV18Z421j7Lf) [久矣](https://github.com/255doesnotexist/SeewoAssistantPasswordRecovery), 如此~~好用~~的一款集控软件, 让广大电教委员对它~~爱不释手~~。

~~古往今来~~, 无数仁人志士尝试破解希沃管家, 却无不被希沃官方修复。

然而, 如果看看希沃管家的安装目录...

<center><img src="https://s2.loli.net/2025/04/18/uc7tOQdwYbFkeWK.png" /></center>

好吧... Electron 受害者 +1

## 💻 功能

- [x] 修改希沃管家密码认证组件 (自定义密码 / 解除密码 / 重设认证方式 / ...)
- [x] 阻止希沃管家前端 Audit 上报行为
- [x] 屏蔽屏幕锁 / 自定义屏幕锁行为
- [ ] Aura 代理层服务 (篡改上报数据 / 欺骗冰冻状态)
- [x] 窥屏提醒
- [ ] 插件功能
- [x] 禁用屏幕保护
- [x] 禁止希沃管家自动更新
- [x] 阻止远程关机

> [!WARNING]
> 画饼中.jpg

## 📷 屏幕截图

> [!IMPORTANT]
> 演示图片, 请以实际安装后效果为准

<center><img src="https://s2.loli.net/2025/11/24/CUNDch9yps5IY1L.png" /></center>

<center><img src="https://s2.loli.net/2025/04/18/2lANiTpX79FcwfC.png" /></center>

<center><img src="https://s2.loli.net/2025/11/24/YgOqytCkxncRAs7.png" /></center>

## ⚡ 安装与使用

~~请参阅 [Wiki](https://github.com/HugoAura/HugoAura/wiki) 以了解安装流程。~~
Wiki已失效，将在不久后重新编写。

## 🤖 AIGC 声明

![HugoAura-README_AIGC_Declaration](https://s2.loli.net/2025/06/30/MLHYONTp3E7ZbDW.png)

## 📦 贡献准则

![HugoAura-README_Community_Standards](https://s2.loli.net/2025/06/30/bFBhfYLMR45GJAd.png)

## 🎉 鸣谢

Thanks goes to these wonderful people:

[![Contributors](https://contrib.rocks/image?repo=blingbling-bow/HugoAura-Enhanced)](https://github.com/blingbling-bow/HugoAura-Enhanced/graphs/contributors)

## ❗ 免责声明

本项目仅用于研究或教育目的, 请勿将本项目用于可能违反当地法律、侵犯著作权或其他软件 EULA 的用途。若将本项目用于非法用途, 一切后果由使用者承担。开发者不承担此类行为带来的任何后果或责任。

## ⚖ 许可证

本项目基于 [GNU GPL-3.0](https://github.com/HugoAura/HugoAura/blob/master/LICENSE) 许可证开源。
