// @ts-check

/**
 * 构建插件系统测试包 (一次性工具, 产物不入库)。
 *
 * 产出 (Artifacts/test-plugins/):
 *   - aura-test-main.zip  主进程测试插件: 验证配置读取 / 存储目录 / 事件总线 /
 *                         心跳存活 / onUnload 清理
 *   - aura-test-ui.zip    界面测试插件: 验证渲染层加载 / DOM 注入 / IPC 调用
 *
 * 用法: node scripts/build-test-plugins.js
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const { unzipToDir } = require("../src/aura/utils/zip.js");

const OUT_DIR = path.join(__dirname, "..", "Artifacts", "test-plugins");
const SRC_DIR = path.join(OUT_DIR, "src");

/** 与 test/zip.test.js 相同的构造逻辑 (deflate 压缩 + 中央目录 + EOCD) */
const buildZip = (entries) => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const payload = zlib.deflateRawSync(raw);
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名标志
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }

  const cdStart = offset;
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
};

// >>> 测试插件 1: 主进程 <<<

const MAIN_MANIFEST = {
  id: "com.aura.test.main",
  name: "Aura 测试插件 (主进程)",
  version: "1.2.0",
  author: "HugoAura",
  description:
    "验证主进程插件运行时: 配置读取 / 存储目录写入 / 事件总线订阅 / 设置项读写 / 心跳存活 / 卸载清理。启用后每 60 秒输出一条心跳日志。",
  type: "main",
  main: "main.js",
  apiLevel: 1,
  configUI: [
    {
      key: "heartbeatSeconds",
      label: "心跳间隔 (秒)",
      type: "input",
      placeholder: "60",
      description: "修改并保存后, 下次启用时生效",
    },
    {
      key: "logLevel",
      label: "日志级别",
      type: "select",
      options: ["debug", "info", "warn"],
    },
    {
      key: "verbose",
      label: "详细输出",
      type: "switch",
    },
  ],
  permissions: [
    {
      key: "storage",
      label: "私有存储",
      description: "插件可读写自己的持久化设置 (storage/settings.json)",
    },
    {
      key: "network",
      label: "联网",
      description: "插件可发起经安全校验的网络请求",
    },
    {
      key: "events",
      label: "事件总线",
      description: "插件可订阅/发布自己命名空间的事件",
    },
  ],
  capabilities: { events: ["settingsChanged"] },
};

const MAIN_CODE = `// 测试插件: 验证主进程沙箱运行时的各项能力 (无 require/fs/central)
var savedCtx = null;
var heartbeatTimer = null;
var tickCount = 0;

module.exports = {
  onLoad(ctx) {
    savedCtx = ctx;
    ctx.logger.log("onLoad: 测试主进程插件已加载 (vm 沙箱), Aura 版本", ctx.auraVersion);

    // 1) 配置只读快照 (settingsPassword* 已脱敏)
    var config = ctx.config.get();
    ctx.logger.log("config 可读:", Boolean(config && config.auraSettings));

    // 2) 插件私有设置: 宿主持久化到 storage/settings.json (无文件系统访问)
    ctx.logger.log("已保存的插件设置:", JSON.stringify(ctx.settings.get()));
    ctx.settings.set({
      lastLoadedAt: new Date().toISOString(),
      auraVersion: ctx.auraVersion,
    });
    ctx.logger.log("设置已写回 (storage 权限)");

    // 3) 事件总线: 仅可订阅/发布自己命名空间 ($aura.plugin.<id>.*)
    ctx.eventBus.on(
      "$aura.plugin." + ctx.manifest.id + ".settingsChanged",
      function (valuesJson) {
        ctx.logger.log("eventBus: 设置已更新", valuesJson);
      }
    );
    ctx.logger.log("eventBus 订阅成功 (命名空间: $aura.plugin." + ctx.manifest.id + ".* )");

    // 4) 心跳: 沙箱定时器 (上限 16 个, 卸载时宿主强制回收)
    var settings = ctx.settings.get();
    var intervalMs = (Number(settings.heartbeatSeconds) > 0 ? Number(settings.heartbeatSeconds) : 60) * 1000;
    heartbeatTimer = ctx.timers.setInterval(function () {
      tickCount += 1;
      ctx.logger.log("heartbeat #" + tickCount);
    }, intervalMs);
    ctx.logger.log("心跳已启动 (" + intervalMs + "ms 间隔)");
  },

  onUnload() {
    if (heartbeatTimer && savedCtx) {
      savedCtx.timers.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  },
};`;

// 沙箱契约下 onUnload 通过闭包里的 savedCtx 清理定时器, 无需修正前缀
const MAIN_CODE_FIXED = MAIN_CODE;

// >>> 测试插件 2: 渲染层 <<<

const UI_MANIFEST = {
  id: "com.aura.test.ui",
  name: "Aura 测试插件 (界面)",
  version: "1.1.0",
  author: "HugoAura",
  description:
    "验证渲染层插件运行时: 在注入页面左下角显示加载徽章, 点击徽章测试 IPC 调用 (列出已装插件数量)。停用后下次页面注入时消失。",
  type: "ui",
  main: "main.js",
};

const UI_CODE = `// 测试插件: 验证 UI 沙箱运行时 (声明式 DOM 桥 + IPC 白名单)
module.exports = {
  onLoad(ctx) {
    var badgeId = ctx.dom.createEl("div", {
      style:
        "position:fixed;left:12px;bottom:12px;z-index:2147483646;" +
        "background:rgba(33,143,255,0.92);color:#fff;padding:6px 12px;" +
        "border-radius:999px;font:12px 'Microsoft YaHei',sans-serif;" +
        "box-shadow:0 4px 14px rgba(0,0,0,0.25);cursor:pointer;user-select:none;",
      title: "com.aura.test.ui — 点击测试 IPC",
    });
    ctx.dom.setText(badgeId, "Aura UI 插件已加载 (沙箱) ✓ v" + ctx.manifest.version);
    ctx.dom.appendToBody(badgeId);

    ctx.dom.on(badgeId, "click", function () {
      ctx.ipc.invoke("$aura.plugin.list").then(function (res) {
        var count = res && res.success ? (res.data || []).length : "?";
        ctx.dom.setText(badgeId, "插件列表: " + count + " 个");
      });
    });

    ctx.logger.log("徽章已挂载 (DOM 桥)");
  },
};
`;

const buildPluginZip = (manifest, code, zipName) => {
  const pluginDir = path.join(SRC_DIR, manifest.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(pluginDir, "main.js"), code);

  const zipPath = path.join(OUT_DIR, zipName);
  fs.writeFileSync(
    zipPath,
    buildZip([
      { name: "manifest.json", data: JSON.stringify(manifest, null, 2) },
      { name: "main.js", data: code },
    ])
  );

  // 回读校验: 用 Aura 自己的解压器验证产物可用
  const verifyDir = path.join(OUT_DIR, `_verify_${manifest.id}`);
  fs.rmSync(verifyDir, { recursive: true, force: true });
  const res = unzipToDir(zipPath, verifyDir);
  const roundTrip = JSON.parse(fs.readFileSync(path.join(verifyDir, "manifest.json"), "utf8"));
  fs.rmSync(verifyDir, { recursive: true, force: true });

  if (roundTrip.id !== manifest.id) throw new Error("zip 回读校验失败");
  return { zipPath, files: res.files };
};

const main = () => {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const mainZip = buildPluginZip(MAIN_MANIFEST, MAIN_CODE_FIXED, "aura-test-main.zip");
  const uiZip = buildPluginZip(UI_MANIFEST, UI_CODE, "aura-test-ui.zip");

  console.log("测试插件构建完成 (已用 Aura 解压器回读校验):");
  console.log(`  [主进程] ${mainZip.zipPath}`);
  mainZip.files.forEach((f) => console.log(`      - ${f.name} (${f.size} bytes)`));
  console.log(`  [界  面] ${uiZip.zipPath}`);
  uiZip.files.forEach((f) => console.log(`      - ${f.name} (${f.size} bytes)`));
  console.log("");
  console.log("安装验证: 配置页 -> 插件管理 -> 本地导入 -> 选择 zip -> 确认安装 -> 启用");
  console.log("  主进程插件: 日志出现 onLoad/心跳, 停用后心跳停止");
  console.log("  界面插件  : 注入页面左下角出现蓝色徽章, 点击测试 IPC");
};

main();
