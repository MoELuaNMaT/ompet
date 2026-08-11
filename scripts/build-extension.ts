/**
 * 构建扩展发布目录（Architecture V2，方案 §59 / §12）：
 * 1. bundle：extension src + packages/shared → extension/dist/index.js
 *    （@oh-my-pi/* 与 node:* 保持 external，由 host 提供/运行时可用）
 * 2. 薄入口 index.ts → export { default } from "./dist/index.js"
 * 3. 宠物包 → ~/.omp/ompet/pets/<id>/（用户数据目录，与二进制分离）
 * 4. 桌面 exe → 扩展目录根（ompet-desktop.exe，不进入 pets 数据目录）
 * 5. 部署：入口 + dist + package.json → ~/.omp/agent/extensions/ompet/
 *
 * 用法：bun scripts/build-extension.ts [--no-install]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const EXT_DIR = path.join(REPO_ROOT, "extension");
const DIST_DIR = path.join(EXT_DIR, "dist");
const PET_DIRS = ["remilia", "elaina-2"];
const TARGET_PETS_DIR =
  process.env.OMPET_PETS_DIR ?? path.join(os.homedir(), ".omp", "ompet", "pets");
// 扩展加载规则（loader.ts）：扫描 `extensions/<ext>/index.ts` 作为入口
const ENTRY_FILE = path.join(EXT_DIR, "index.ts");
// 桌面端可执行文件（构建产物），部署到扩展目录根（与用户数据分离）
const DESKTOP_EXE = path.join(
  REPO_ROOT,
  "desktop",
  "src-tauri",
  "target",
  "release",
  "ompet-desktop.exe",
);

function copyDir(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

async function main() {
  const noInstall = process.argv.includes("--no-install");

  // 1. bundle（shared 打进单文件；@oh-my-pi/* 由 host 提供故 external。
  //    注意：node:* 内置模块绝不能显式 external——bun 会对解析失败的 external
  //    降级为空对象（fs4 = (() => ({}))），导致运行时 existsSync undefined；
  //    去掉后 bun 按内置模块处理，运行时由 host 环境提供）
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const bundle = spawnSync(
    "bun",
    [
      "build",
      path.join(EXT_DIR, "src", "index.ts"),
      "--outfile",
      path.join(DIST_DIR, "index.js"),
      "--target",
      "bun",
      "--external",
      "@oh-my-pi/*",
    ],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
  if (bundle.status !== 0) {
    console.error("bundle 失败，中止部署");
    process.exit(1);
  }

  // 2. 薄入口：extensions/<ext>/index.ts（loader 规则 2，不递归更深层）
  fs.writeFileSync(ENTRY_FILE, 'export { default } from "./dist/index.js";\n');

  // 3. 宠物包 → ~/.omp/ompet/pets/<id>/（含 pet.json + spritesheet.webp）
  for (const dir of PET_DIRS) {
    const src = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(path.join(src, "pet.json"))) {
      console.warn(`跳过 ${dir}：缺少 pet.json`);
      continue;
    }
    copyDir(src, path.join(TARGET_PETS_DIR, dir));
    console.log(`pet: ${dir} → ${path.join(TARGET_PETS_DIR, dir)}`);
  }

  // 4. 桌面 exe → 扩展目录根（二进制与用户数据分离，方案 §12）
  const TARGET_EXT_DIR =
    process.env.OMPET_EXT_DIR ??
    path.join(os.homedir(), ".omp", "agent", "extensions", "ompet");
  // 目标目录必须先于 exe 拷贝创建：首次部署时目录尚不存在，copyFileSync 会抛 ENOENT 中止
  fs.mkdirSync(TARGET_EXT_DIR, { recursive: true });
  if (fs.existsSync(DESKTOP_EXE)) {
    const destExe = path.join(TARGET_EXT_DIR, "ompet-desktop.exe");
    // 运行中的桌面端会锁定已部署 exe，直接覆盖会 EBUSY 中止整次构建；
    // 内容未变化（仅扩展改动）时跳过拷贝，避免每轮部署都被锁文件阻断
    let exeSame = false;
    try {
      exeSame =
        fs.existsSync(destExe) &&
        fs.statSync(DESKTOP_EXE).size === fs.statSync(destExe).size &&
        fs.readFileSync(DESKTOP_EXE).equals(fs.readFileSync(destExe));
    } catch {
      exeSame = false;
    }
    if (exeSame) {
      console.log("desktop exe 未变化，跳过拷贝（避免锁文件 EBUSY）");
    } else {
      fs.copyFileSync(DESKTOP_EXE, destExe);
      console.log("desktop exe →", destExe);
    }
  } else {
    console.warn(
      "未找到桌面端 exe（先构建：cd desktop && bunx tauri build --no-bundle --ci）——宠物将不会自动跟随 omp 启动",
    );
  }

  // 5. 部署扩展本体：入口 + dist bundle + 依赖清单（不再复制 src/packages）
  fs.copyFileSync(ENTRY_FILE, path.join(TARGET_EXT_DIR, "index.ts"));
  copyDir(DIST_DIR, path.join(TARGET_EXT_DIR, "dist"));
  fs.copyFileSync(path.join(EXT_DIR, "package.json"), path.join(TARGET_EXT_DIR, "package.json"));
  console.log("ext:", TARGET_EXT_DIR);

  if (!noInstall) {
    spawnSync("bun", ["install"], { cwd: TARGET_EXT_DIR, stdio: "inherit" });
  }
  console.log("完成。重启 omp 会话后生效。");
}

await main();
