// @ts-check

/**
 * 自定义屏保图片 (Issue #15)
 *
 * 原理: 希沃的屏幕保护画面由 SeewoAbility 渲染, 播放图片固定读取
 * %APPDATA%\seewo\SeewoAbility\screen_saver 目录。启用本功能后, 把用户
 * 预先放入 <auraDir>\screensaver\ 的图片 (jpg / jpeg / png) 循环覆盖到
 * 上述目录 —— 保持原文件名不变 (与社区 "狸猫换太子" 脚本同思路),
 * 下次屏保启动即显示新图。
 *
 * 备份与还原:
 *   - 首次替换前, 原图完整备份到 <auraDir>\screensaver\backup_original\
 *     (已有备份时不动, 避免把已替换的图当成原图);
 *   - 关闭功能时把备份原样复制回去。
 *
 * 兼容: 管家内置 Node 较老, 只用老 fs API (copyFileSync / readdirSync /
 * unlinkSync 等), 不使用 fs.cpSync / fs.rmSync。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const IMAGE_EXT_RE = /\.(jpe?g|png)$/i;
const BACKUP_DIR_NAME = "backup_original";

/** 目录条目白名单之外的文件不动 (只处理文件, 忽略子目录) */
const listFiles = (dir) => {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .sort();
};

const listImages = (dir) => listFiles(dir).filter((name) => IMAGE_EXT_RE.test(name));

/**
 * 纯函数: 生成替换计划 (保持目标原文件名, 源图循环取用)。
 * @param {string[]} targetNames 目标目录里的文件名 (即被替换后保留的名字)
 * @param {string[]} sourceImages 源图文件名
 * @returns {{targetName: string, sourceName: string}[]}
 */
const buildReplacePlan = (targetNames, sourceImages) => {
  const plan = [];
  if (!targetNames.length || !sourceImages.length) return plan;
  targetNames.forEach((targetName, idx) => {
    plan.push({
      targetName,
      sourceName: sourceImages[idx % sourceImages.length],
    });
  });
  return plan;
};

/** 屏保图目录 (SeewoAbility 固定读取位置) */
const resolveTargetDir = () => {
  const appData =
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "seewo", "SeewoAbility", "screen_saver");
};

/** 用户自备图目录 */
const resolveSourceDir = () =>
  path.join(global.__HUGO_AURA__.auraDir, "screensaver");

const resolveBackupDir = (sourceDir) => path.join(sourceDir, BACKUP_DIR_NAME);

/**
 * 用自备图替换屏保图。
 * @param {{sourceDir?: string, targetDir?: string, backupDir?: string}} [dirs]
 * @returns {{replaced: number, sourceCount: number, targetCount: number, backupCreated: boolean}}
 */
const applyCustomScreenSaver = (dirs = {}) => {
  const sourceDir = dirs.sourceDir || resolveSourceDir();
  const targetDir = dirs.targetDir || resolveTargetDir();
  const backupDir = dirs.backupDir || resolveBackupDir(sourceDir);

  if (!fs.existsSync(targetDir)) {
    throw new Error("TARGET_DIR_NOT_FOUND");
  }
  const sourceImages = listImages(sourceDir);
  if (!sourceImages.length) {
    throw new Error("NO_SOURCE_IMAGES");
  }
  const targetNames = listFiles(targetDir);
  if (!targetNames.length) {
    throw new Error("TARGET_DIR_EMPTY");
  }

  // 首次替换前备份原图 (已有备份时不覆盖, 保证还原的始终是原图)
  let backupCreated = false;
  const existingBackup = listFiles(backupDir);
  if (!existingBackup.length) {
    fs.mkdirSync(backupDir, { recursive: true });
    for (const name of targetNames) {
      fs.copyFileSync(path.join(targetDir, name), path.join(backupDir, name));
    }
    backupCreated = true;
  }

  const plan = buildReplacePlan(targetNames, sourceImages);
  for (const { targetName, sourceName } of plan) {
    fs.copyFileSync(path.join(sourceDir, sourceName), path.join(targetDir, targetName));
  }

  console.log(
    `[HugoAura / CustomScreenSaver] Replaced ${plan.length} image(s) with ${sourceImages.length} custom image(s).`
  );
  return {
    replaced: plan.length,
    sourceCount: sourceImages.length,
    targetCount: targetNames.length,
    backupCreated,
  };
};

/**
 * 还原屏保原图 (关闭功能时调用; 未备份过则不动)。
 * @param {{sourceDir?: string, targetDir?: string, backupDir?: string}} [dirs]
 * @returns {{restored: number, backupHadFiles: boolean}}
 */
const restoreScreenSaver = (dirs = {}) => {
  const sourceDir = dirs.sourceDir || resolveSourceDir();
  const targetDir = dirs.targetDir || resolveTargetDir();
  const backupDir = dirs.backupDir || resolveBackupDir(sourceDir);

  const backupFiles = listFiles(backupDir);
  if (!backupFiles.length) {
    return { restored: 0, backupHadFiles: false };
  }
  if (!fs.existsSync(targetDir)) {
    throw new Error("TARGET_DIR_NOT_FOUND");
  }
  for (const name of backupFiles) {
    fs.copyFileSync(path.join(backupDir, name), path.join(targetDir, name));
  }
  console.log(
    `[HugoAura / CustomScreenSaver] Restored ${backupFiles.length} original image(s).`
  );
  return { restored: backupFiles.length, backupHadFiles: true };
};

/** 读取开关 (配置缺失/未合并时安全回退为 false) */
const isEnabled = () => {
  try {
    const cfg = global.__HUGO_AURA_CONFIG__;
    return Boolean(
      cfg && cfg.auraSettings && cfg.auraSettings.customScreenSaver
        ? cfg.auraSettings.customScreenSaver.enabled
        : false
    );
  } catch {
    return false;
  }
};

/** 管家启动时调用: 开关开启才执行, 任何失败只记日志不影响启动 */
const applyIfEnabled = () => {
  if (!isEnabled()) return null;
  try {
    return applyCustomScreenSaver();
  } catch (err) {
    console.error(
      `[HugoAura / CustomScreenSaver] Apply failed: ${
        err && err.message ? err.message : err
      }`
    );
    return null;
  }
};

module.exports = {
  buildReplacePlan,
  applyCustomScreenSaver,
  restoreScreenSaver,
  applyIfEnabled,
  isEnabled,
  IMAGE_EXT_RE,
};
