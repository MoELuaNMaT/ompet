/**
 * 宠物发现（Architecture V2，方案 §8 / §18）。
 *
 * 固定两个来源：
 * - Codex：~/.codex/pets/<petId>/（完全只读，OMPet 不得写入任何文件）
 * - OMPet 自有：~/.omp/ompet/pets/<petId>/
 *
 * 不再扫描旧目录 ~/.omp/agent/pets（旧路径只在 Migration 阶段读取）。
 * 单个宠物损坏：跳过 + warning，不得导致整个列表失败（方案 §18）。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseCodexPetManifest,
  resolveSpriteLayout,
  SPRITE_LAYOUT_V1,
  SPRITE_LAYOUT_V2,
  type PetKey,
  type PetSource,
  type SpriteLayout,
  type SpriteSheetSize,
} from "../../packages/shared/src/index.ts";

/** 发现结果（方案 §18 DiscoveredPet） */
export interface DiscoveredPet {
  key: PetKey;
  source: PetSource;
  id: string;
  displayName: string;
  petDirectory: string;
  manifestPath: string;
  spritePath: string;
  spriteVersion: 1 | 2;
  rowCount: 9 | 11;
}

/** 发现过程中被跳过的宠物（key 或目录 + 原因），供 UI/日志展示 */
export interface DiscoveryWarning {
  key: string;
  reason: string;
}

/** 两个来源的固定根目录（可注入测试） */
export interface DiscoveryRoots {
  codex?: string;
  ompet?: string;
}

export function defaultDiscoveryRoots(): Required<DiscoveryRoots> {
  return {
    codex: path.join(os.homedir(), ".codex", "pets"),
    ompet: path.join(os.homedir(), ".omp", "ompet", "pets"),
  };
}

/** 当前生效的宠物：按 activeKey 匹配，回退第一只有效宠物（方案 §69 不自动写 config） */
export function resolveActivePet(
  activeKey: PetKey | null,
  pets: DiscoveredPet[],
): DiscoveredPet | null {
  if (pets.length === 0) return null;
  return pets.find((pet) => pet.key === activeKey) ?? pets[0]!;
}

/**
 * 解析 WebP 文件尺寸（VP8X / VP8L / VP8 三种容器，纯字节解析，不依赖 sharp）。
 * 无法识别时返回 null。
 */
export function readWebpSize(buffer: Buffer): SpriteSheetSize | null {
  if (buffer.length < 30) return null;
  if (buffer.toString("latin1", 0, 4) !== "RIFF") return null;
  if (buffer.toString("latin1", 8, 12) !== "WEBP") return null;

  const kind = buffer.toString("latin1", 12, 16);
  if (kind === "VP8X") {
    // VP8X: 12-15 标识、16-19 chunk size、20-23 标志位、
    // 24-26 为 24-bit 宽-1（LE），27-29 为 24-bit 高-1（LE）
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    return { width, height };
  }
  if (kind === "VP8L") {
    // VP8L: 12-15 标识、16-19 chunk size、20 签名 0x2F、
    // 21-24 为 4 字节位域：14-bit 宽-1 | 14-bit 高-1（交错）
    if (buffer[20] !== 0x2f) return null;
    const bits = buffer.readUIntLE(21, 4);
    const width = 1 + (bits & 0x3fff);
    const height = 1 + ((bits >> 14) & 0x3fff);
    return { width, height };
  }
  if (kind === "VP8 ") {
    // VP8 有损：3 字节 frame tag 后，23-24 宽-1（LE），25-26 高-1（LE）
    const width = 1 + (buffer.readUIntLE(23, 2) & 0x3fff);
    const height = 1 + (buffer.readUIntLE(25, 2) & 0x3fff);
    return { width, height };
  }
  return null;
}

/** 扫描两个来源目录（方案 §18 discoverPets） */
export function discoverPets(roots: Required<DiscoveryRoots> = defaultDiscoveryRoots()): {
  pets: DiscoveredPet[];
  warnings: DiscoveryWarning[];
} {
  const pets: DiscoveredPet[] = [];
  const warnings: DiscoveryWarning[] = [];

  const rootsList: { source: PetSource; dir: string }[] = [
    { source: "codex", dir: roots.codex },
    { source: "ompet", dir: roots.ompet },
  ];

  for (const { source, dir } of rootsList) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const petDirectory = path.join(dir, entry.name);
      const manifestPath = path.join(petDirectory, "pet.json");
      if (!fs.existsSync(manifestPath)) continue;

      const key = `${source}:${entry.name}`;
      try {
        const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
        const manifest = parseCodexPetManifest(raw);

        // spritesheetPath 已禁止绝对路径与 ..；再确认解析后仍位于宠物目录内
        const spritePath = path.resolve(petDirectory, manifest.spritesheetPath);
        if (!spritePath.startsWith(petDirectory + path.sep)) {
          warnings.push({ key, reason: "spritesheetPath 逃逸宠物目录" });
          continue;
        }
        if (!fs.existsSync(spritePath)) {
          warnings.push({ key, reason: `缺少图集文件 ${manifest.spritesheetPath}` });
          continue;
        }

        // 图集尺寸 → 布局；无法解析尺寸时仅接受显式声明版本
        let layout: SpriteLayout;
        const size = readWebpSize(fs.readFileSync(spritePath));
        if (size) {
          layout = resolveSpriteLayout(manifest, size); // 尺寸不符会抛错 → 跳过
        } else if (manifest.spriteVersionNumber === 2) {
          layout = SPRITE_LAYOUT_V2;
        } else if (manifest.spriteVersionNumber === 1) {
          layout = SPRITE_LAYOUT_V1;
        } else {
          warnings.push({ key, reason: "无法解析图集尺寸且清单未声明 spriteVersionNumber" });
          continue;
        }

        pets.push({
          key: key as PetKey,
          source,
          id: manifest.id,
          displayName: manifest.displayName ?? manifest.id,
          petDirectory,
          manifestPath,
          spritePath,
          spriteVersion: layout.version,
          rowCount: layout.rows,
        });
      } catch (err) {
        warnings.push({
          key,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { pets, warnings };
}
