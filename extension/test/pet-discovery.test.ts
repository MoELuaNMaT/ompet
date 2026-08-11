/**
 * pet-discovery 测试（方案 §18）。
 * 用真实 remilia/elaina-2 宠物包拷贝到临时目录，验证发现、跳过与 webp 尺寸解析。
 * 素材包不随仓库分发（版权未确认）；素材目录缺失时相关用例自动跳过。
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverPets,
  readWebpSize,
  type DiscoveryRoots,
} from "../src/pet-discovery.ts";

const REPO_PETS = join(import.meta.dir, "..", "..", "remilia");
const HAS_REPO_PETS = existsSync(REPO_PETS);

let dir: string;
let codexDir: string;
let ompetDir: string;
let roots: Required<DiscoveryRoots>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ompet-pets-"));
  codexDir = join(dir, "codex-pets");
  ompetDir = join(dir, "ompet-pets");
  roots = { codex: codexDir, ompet: ompetDir };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedRemilia(): string {
  const petDir = join(codexDir, "remilia");
  cpSync(REPO_PETS, petDir, { recursive: true });
  return petDir;
}

describe("readWebpSize（纯字节解析，不依赖 sharp）", () => {
  test("垃圾输入 → null", () => {
    expect(readWebpSize(Buffer.from("not a webp file at all"))).toBeNull();
    expect(readWebpSize(Buffer.alloc(4))).toBeNull();
  });
});

describe.skipIf(!HAS_REPO_PETS)("readWebpSize（真实图集）", () => {
  test("真实 remilia spritesheet → 1536×1872", () => {
    const buffer = readFileSync(join(REPO_PETS, "spritesheet.webp"));
    expect(readWebpSize(buffer)).toEqual({ width: 1536, height: 1872 });
  });
});

describe("discoverPets（无需真实素材）", () => {
  test("pet.json 非法（逃逸路径）跳过", () => {
    const bad = join(codexDir, "evil");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "pet.json"), JSON.stringify({ id: "evil", spritesheetPath: "../x.webp" }));
    const { pets, warnings } = discoverPets(roots);
    expect(pets).toHaveLength(0);
    expect(warnings[0]?.key).toBe("codex:evil");
  });

  test("缺 spritesheet 跳过", () => {
    const petDir = join(codexDir, "nosprite");
    mkdirSync(petDir, { recursive: true });
    writeFileSync(join(petDir, "pet.json"), JSON.stringify({ id: "nosprite", spritesheetPath: "s.webp" }));
    const { pets, warnings } = discoverPets(roots);
    expect(pets).toHaveLength(0);
    expect(warnings[0]?.reason).toContain("缺少图集");
  });

  test("目录不存在 → 空结果", () => {
    const { pets, warnings } = discoverPets(roots);
    expect(pets).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe.skipIf(!HAS_REPO_PETS)("discoverPets（真实素材）", () => {
  test("codex 来源正常发现（key/source/displayName/rowCount）", () => {
    seedRemilia();
    const { pets, warnings } = discoverPets(roots);
    expect(warnings).toEqual([]);
    expect(pets).toHaveLength(1);
    const pet = pets[0]!;
    expect(pet.key).toBe("codex:remilia");
    expect(pet.source).toBe("codex");
    expect(pet.id).toBe("remilia");
    expect(pet.displayName).toBe("蕾米");
    expect(pet.spriteVersion).toBe(1);
    expect(pet.rowCount).toBe(9);
    expect(existsSync(pet.manifestPath)).toBe(true);
    expect(existsSync(pet.spritePath)).toBe(true);
  });

  test("ompet 来源发现", () => {
    cpSync(REPO_PETS, join(ompetDir, "my-pet"), { recursive: true });
    const { pets } = discoverPets(roots);
    expect(pets[0]?.key).toBe("ompet:my-pet");
    expect(pets[0]?.source).toBe("ompet");
  });

  test("两个来源同名宠物 → 两个独立 key", () => {
    seedRemilia();
    cpSync(REPO_PETS, join(ompetDir, "remilia"), { recursive: true });
    const { pets } = discoverPets(roots);
    expect(pets.map((p) => p.key).sort()).toEqual(["codex:remilia", "ompet:remilia"]);
  });

  test("缺 pet.json 的目录跳过", () => {
    seedRemilia();
    cpSync(REPO_PETS, join(codexDir, "nope"), { recursive: true });
    rmSync(join(codexDir, "nope", "pet.json"));
    const { pets } = discoverPets(roots);
    expect(pets).toHaveLength(1);
  });

  test("损坏 pet.json 跳过并记录 warning，不影响其他宠物", () => {
    seedRemilia();
    const bad = join(codexDir, "broken");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "pet.json"), "{ broken");
    const { pets, warnings } = discoverPets(roots);
    expect(pets).toHaveLength(1);
    expect(warnings.some((w) => w.key === "codex:broken")).toBe(true);
  });

  test("声明 spriteVersionNumber=2 但图集尺寸不符 → 跳过", () => {
    const petDir = join(codexDir, "fakev2");
    mkdirSync(petDir, { recursive: true });
    cpSync(REPO_PETS, petDir, { recursive: true });
    // 覆盖 pet.json 声明 V2，但图集是 V1 尺寸
    writeFileSync(
      join(petDir, "pet.json"),
      JSON.stringify({ id: "fakev2", spritesheetPath: "spritesheet.webp", spriteVersionNumber: 2 }),
    );
    const { pets, warnings } = discoverPets(roots);
    expect(pets).toHaveLength(0);
    expect(warnings.some((w) => w.key === "codex:fakev2")).toBe(true);
  });
});
