// @ts-check

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * pruneStaleStages 回归测试 (代码审查发现 P0 后补)。
 *
 * 事故: 清理过期暂存时误用 path.dirname(stage.dir) —— stage.dir 本身是
 * mkdtemp 出来的独立目录, dirname 指向整个用户临时目录, 递归删除会造成
 * 全系统临时文件丢失。本测试锁定 "只删暂存目录本身, 父目录必须完好"。
 */

const {
  pruneStaleStages,
  stagedInstalls,
} = require("../src/aura/init/main/ipcModules/pluginIpcHandler");

test("pruneStaleStages: 只删过期暂存目录本身, 不碰父目录与其他文件", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "aura-prune-parent-"));
  const stageDir = path.join(parent, "aura-plugin-stagetest-1");
  fs.mkdirSync(stageDir);
  fs.writeFileSync(path.join(stageDir, "manifest.json"), "{}");
  // 父目录里的无关文件必须幸存
  fs.writeFileSync(path.join(parent, "unrelated.txt"), "keep me");

  stagedInstalls.set("stage-test-1", {
    dir: stageDir,
    manifestDir: stageDir,
    manifest: { id: "com.test" },
    createdAt: Date.now() - 31 * 60 * 1000, // 超过 30 分钟 TTL
  });
  stagedInstalls.set("stage-test-fresh", {
    dir: path.join(parent, "aura-plugin-stagetest-2"),
    manifestDir: path.join(parent, "aura-plugin-stagetest-2"),
    manifest: { id: "com.test.fresh" },
    createdAt: Date.now(), // 未过期, 必须保留
  });
  fs.mkdirSync(path.join(parent, "aura-plugin-stagetest-2"));

  try {
    pruneStaleStages();

    assert.equal(
      fs.existsSync(stageDir),
      false,
      "过期暂存目录应被删除"
    );
    assert.equal(
      stagedInstalls.has("stage-test-1"),
      false,
      "过期条目应从暂存表移除"
    );
    assert.equal(
      fs.existsSync(path.join(parent, "unrelated.txt")),
      true,
      "父目录中的无关文件必须完好 (dirname 误删回归点)"
    );
    assert.equal(
      fs.existsSync(path.join(parent, "aura-plugin-stagetest-2")),
      true,
      "未过期暂存必须保留"
    );
    assert.equal(stagedInstalls.has("stage-test-fresh"), true);
  } finally {
    stagedInstalls.delete("stage-test-1");
    stagedInstalls.delete("stage-test-fresh");
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
