/**
 * Codex 宠物包数据契约（OMPet Architecture V2，方案 §9 / §10 / §19）。
 *
 * Codex 宠物文件（pet.json + spritesheet.webp）对 OMPet 完全只读：
 * 不得修改 pet.json、不得写入 lines/fps/rowFrames 等任何 OMPet 元数据。
 * 所有 OMPet 配置放 OMPet 自己的 Global Config。
 */

/** Sprite Sheet 布局契约（方案 §10） */
export interface SpriteLayout {
  version: 1 | 2;
  columns: 8;
  rows: 9 | 11;
  frameWidth: 192;
  frameHeight: 208;
}

/** V1：8 列 × 9 行，帧 192×208，图集 1536×1872 */
export const SPRITE_LAYOUT_V1: SpriteLayout = {
  version: 1,
  columns: 8,
  rows: 9,
  frameWidth: 192,
  frameHeight: 208,
};

/** V2：8 列 × 11 行，帧 192×208，图集 1536×2288（第 9/10 行本轮无特殊含义） */
export const SPRITE_LAYOUT_V2: SpriteLayout = {
  version: 2,
  columns: 8,
  rows: 11,
  frameWidth: 192,
  frameHeight: 208,
};

export interface SpriteSheetSize {
  width: number;
  height: number;
}

/** V1 图集尺寸 */
export const SPRITE_SHEET_V1: SpriteSheetSize = { width: 1536, height: 1872 };
/** V2 图集尺寸 */
export const SPRITE_SHEET_V2: SpriteSheetSize = { width: 1536, height: 2288 };

/** Codex pet.json 清单（方案 §19；OMPet 自定义 lines 等字段一律不识别） */
export interface CodexPetManifest {
  id: string;
  displayName?: string;
  description?: string;
  spritesheetPath: string;
  spriteVersionNumber?: number;
}

/** 清单解析/校验错误 */
export class ManifestParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestParseError";
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** 路径逃逸检查：绝对路径（Windows 盘符 / POSIX 根）或含 `..` 段 */
export function isEscapingPath(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("\\")) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  return value.split(/[\\/]/).some((segment) => segment === "..");
}

/**
 * 解析并校验 Codex pet.json（方案 §19）。
 * 校验：id 非空、spritesheetPath 非空、不允许绝对路径、不允许 `..`。
 * spriteVersionNumber 若存在必须为 1 或 2。
 */
export function parseCodexPetManifest(raw: unknown): CodexPetManifest {
  if (typeof raw !== "object" || raw === null) {
    throw new ManifestParseError("pet.json 必须是 JSON 对象");
  }
  const record = raw as Record<string, unknown>;

  const id = record["id"];
  if (!isNonEmptyString(id)) {
    throw new ManifestParseError("pet.json 缺少非空 id");
  }

  const spritesheetPath = record["spritesheetPath"];
  if (!isNonEmptyString(spritesheetPath)) {
    throw new ManifestParseError("pet.json 缺少非空 spritesheetPath");
  }
  if (isEscapingPath(spritesheetPath)) {
    throw new ManifestParseError(
      `spritesheetPath 不允许绝对路径或 ..：${spritesheetPath}`,
    );
  }

  const spriteVersionNumber = record["spriteVersionNumber"];
  if (
    spriteVersionNumber !== undefined &&
    spriteVersionNumber !== 1 &&
    spriteVersionNumber !== 2
  ) {
    throw new ManifestParseError(
      `spriteVersionNumber 必须为 1 或 2：${String(spriteVersionNumber)}`,
    );
  }

  const displayName = record["displayName"];
  const description = record["description"];

  return {
    id,
    spritesheetPath,
    ...(isNonEmptyString(displayName) ? { displayName } : {}),
    ...(isNonEmptyString(description) ? { description } : {}),
    ...(spriteVersionNumber !== undefined ? { spriteVersionNumber } : {}),
  };
}

/**
 * 解析 Sprite 布局（方案 §43）：
 * - manifest 声明 spriteVersionNumber → 直接采用对应布局；
 * - 未声明 → height == 2288 推断 V2，否则按 V1。
 * 随后校验实际图集尺寸与布局一致（V1=1536×1872，V2=1536×2288）。
 * 尺寸不符抛 ManifestParseError，不得自动猜任意网格。
 */
export function resolveSpriteLayout(
  manifest: CodexPetManifest,
  size: SpriteSheetSize,
): SpriteLayout {
  const declared = manifest.spriteVersionNumber;
  const layout =
    declared === 2
      ? SPRITE_LAYOUT_V2
      : declared === 1
        ? SPRITE_LAYOUT_V1
        : size.height === SPRITE_SHEET_V2.height
          ? SPRITE_LAYOUT_V2
          : SPRITE_LAYOUT_V1;

  const expected =
    layout.version === 2 ? SPRITE_SHEET_V2 : SPRITE_SHEET_V1;
  if (size.width !== expected.width || size.height !== expected.height) {
    throw new ManifestParseError(
      `图集尺寸 ${size.width}x${size.height} 与 Sprite V${layout.version} 契约 ` +
        `${expected.width}x${expected.height} 不符`,
    );
  }
  return layout;
}
