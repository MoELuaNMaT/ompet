/**
 * Codex 清单解析与 Sprite 布局测试（方案 §65 Shared）。
 */
import { describe, expect, test } from "bun:test";
import {
  isEscapingPath,
  ManifestParseError,
  parseCodexPetManifest,
  resolveSpriteLayout,
  SPRITE_SHEET_V1,
  SPRITE_SHEET_V2,
  SPRITE_LAYOUT_V1,
  SPRITE_LAYOUT_V2,
} from "../src/codex-contract.ts";

describe("parseCodexPetManifest", () => {
  test("合法清单（最小字段）", () => {
    const manifest = parseCodexPetManifest({
      id: "remilia",
      spritesheetPath: "spritesheet.webp",
    });
    expect(manifest).toEqual({
      id: "remilia",
      spritesheetPath: "spritesheet.webp",
    });
  });

  test("合法清单（完整字段）", () => {
    const manifest = parseCodexPetManifest({
      id: "elaina",
      displayName: "Elaina",
      description: "cute",
      spritesheetPath: "spritesheet.webp",
      spriteVersionNumber: 2,
    });
    expect(manifest.displayName).toBe("Elaina");
    expect(manifest.spriteVersionNumber).toBe(2);
  });

  test("id 缺失/空 → 抛错", () => {
    expect(() => parseCodexPetManifest({ spritesheetPath: "s.webp" })).toThrow(
      ManifestParseError,
    );
    expect(() => parseCodexPetManifest({ id: "", spritesheetPath: "s.webp" })).toThrow(
      ManifestParseError,
    );
  });

  test("spritesheetPath 缺失/空 → 抛错", () => {
    expect(() => parseCodexPetManifest({ id: "x" })).toThrow(ManifestParseError);
    expect(() => parseCodexPetManifest({ id: "x", spritesheetPath: "" })).toThrow(
      ManifestParseError,
    );
  });

  test("非对象输入 → 抛错", () => {
    expect(() => parseCodexPetManifest(null)).toThrow(ManifestParseError);
    expect(() => parseCodexPetManifest("x")).toThrow(ManifestParseError);
  });

  test("spriteVersionNumber 非法 → 抛错", () => {
    expect(() =>
      parseCodexPetManifest({ id: "x", spritesheetPath: "s.webp", spriteVersionNumber: 3 }),
    ).toThrow(ManifestParseError);
  });

  test("不得识别 OMPet 自定义 lines 作为运行配置", () => {
    const manifest = parseCodexPetManifest({
      id: "x",
      spritesheetPath: "s.webp",
      lines: { "0": "IDLE" },
    });
    expect(manifest).not.toHaveProperty("lines");
  });
});

describe("路径逃逸校验（方案 §19）", () => {
  test("拒绝绝对路径", () => {
    expect(isEscapingPath("/abs/s.webp")).toBe(true);
    expect(isEscapingPath("C:\\abs\\s.webp")).toBe(true);
    expect(isEscapingPath("D:/abs/s.webp")).toBe(true);
  });

  test("拒绝 .. 段", () => {
    expect(isEscapingPath("../s.webp")).toBe(true);
    expect(isEscapingPath("sub/../s.webp")).toBe(true);
    expect(isEscapingPath("sub\\..\\s.webp")).toBe(true);
  });

  test("接受相对路径", () => {
    expect(isEscapingPath("spritesheet.webp")).toBe(false);
    expect(isEscapingPath("assets/s.webp")).toBe(false);
    expect(isEscapingPath("a/b/c.webp")).toBe(false);
  });

  test("parse 层同样拒绝逃逸路径", () => {
    expect(() =>
      parseCodexPetManifest({ id: "x", spritesheetPath: "../s.webp" }),
    ).toThrow(ManifestParseError);
    expect(() =>
      parseCodexPetManifest({ id: "x", spritesheetPath: "/abs/s.webp" }),
    ).toThrow(ManifestParseError);
  });
});

describe("Sprite 布局解析（方案 §10 / §43）", () => {
  const v1Manifest = parseCodexPetManifest({
    id: "x",
    spritesheetPath: "s.webp",
  });
  const v2Manifest = parseCodexPetManifest({
    id: "x",
    spritesheetPath: "s.webp",
    spriteVersionNumber: 2,
  });

  test("V1 尺寸 → V1 布局", () => {
    const layout = resolveSpriteLayout(v1Manifest, SPRITE_SHEET_V1);
    expect(layout).toEqual(SPRITE_LAYOUT_V1);
    expect(layout.rows).toBe(9);
  });

  test("未声明版本 + 2288 高 → 推断 V2", () => {
    const layout = resolveSpriteLayout(v1Manifest, SPRITE_SHEET_V2);
    expect(layout).toEqual(SPRITE_LAYOUT_V2);
    expect(layout.rows).toBe(11);
  });

  test("声明 V2 + V2 尺寸 → V2 布局", () => {
    const layout = resolveSpriteLayout(v2Manifest, SPRITE_SHEET_V2);
    expect(layout).toEqual(SPRITE_LAYOUT_V2);
  });

  test("声明 V2 + V1 尺寸 → 抛错（声明优先，尺寸不符拒绝）", () => {
    expect(() => resolveSpriteLayout(v2Manifest, SPRITE_SHEET_V1)).toThrow(
      ManifestParseError,
    );
  });

  test("未声明版本 + 其他尺寸 → 抛错", () => {
    expect(() =>
      resolveSpriteLayout(v1Manifest, { width: 100, height: 100 }),
    ).toThrow(ManifestParseError);
  });

  test("V1/V2 契约帧参数固定", () => {
    expect(SPRITE_LAYOUT_V1).toEqual({
      version: 1,
      columns: 8,
      rows: 9,
      frameWidth: 192,
      frameHeight: 208,
    });
    expect(SPRITE_LAYOUT_V2).toEqual({
      version: 2,
      columns: 8,
      rows: 11,
      frameWidth: 192,
      frameHeight: 208,
    });
  });
});
