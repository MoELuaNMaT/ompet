/**
 * 旧配置迁移测试（方案 §65/§20）：
 * 有旧 lines / 无旧 lines / 部分映射 / 非法映射 / 重复启动幂等；
 * 只读旧目录：迁移后旧 pet.json 字节不变、旧目录文件不删除。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigStore } from "../src/config-store.ts";
import {
  convertLegacyLines,
  legacyPetsDir,
  migrateLegacyPets,
} from "../src/migration.ts";
import type { OMPetConfig } from "../../packages/shared/src/index.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ompet-migrate-"));
const CONFIG_PATH = path.join(TMP, "config.json");
const LEGACY_ROOT = path.join(TMP, "legacy-pets");

/** 迁移函数内部读 legacyPetsDir()（真实 ~/.omp/agent/pets）——测试前替换 */
const realHomedir = os.homedir();

beforeEach(() => {
  fs.rmSync(CONFIG_PATH, { force: true });
  fs.rmSync(LEGACY_ROOT, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function seedLegacyPet(name: string, manifest: Record<string, unknown>): void {
  const dir = path.join(LEGACY_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pet.json"), JSON.stringify(manifest, null, 2));
}

describe("convertLegacyLines（纯函数）", () => {
  test("只迁移五个正式状态", () => {
    const rows = convertLegacyLines({
      "0": "IDLE",
      "1": "MOVE_RIGHT",
      "2": "MOVE_LEFT",
      "6": "WAITING",
      "7": "RUNNING",
    });
    expect(rows).toEqual({
      IDLE: 0,
      MOVE_RIGHT: 1,
      MOVE_LEFT: 2,
      WAITING: 6,
      RUNNING: 7,
    });
  });

  test("非五态枚举忽略（REVIEW/FAILED/WAVING/JUMPING/REVEAL）", () => {
    const rows = convertLegacyLines({
      "3": "WAVING",
      "5": "FAILED",
      "8": "REVIEW",
      "0": "IDLE",
    });
    expect(rows).toEqual({ IDLE: 0 });
  });

  test("非法行号忽略", () => {
    const rows = convertLegacyLines({ "-1": "IDLE", "x": "IDLE", "1.5": "IDLE", "7": "RUNNING" });
    expect(rows).toEqual({ RUNNING: 7 });
  });

  test("未知枚举忽略", () => {
    const rows = convertLegacyLines({ "0": "NOPE", "7": "RUNNING" });
    expect(rows).toEqual({ RUNNING: 7 });
  });
});

describe("migrateLegacyPets", () => {
  test("有旧 lines → 迁移为 petOverrides，migrationVersion=1", async () => {
    seedLegacyPet("remilia", {
      id: "remilia",
      spritesheetPath: "spritesheet.webp",
      lines: { "0": "IDLE", "3": "WAVING", "7": "RUNNING", "8": "REVIEW" },
    });
    const store = new ConfigStore({ configPath: CONFIG_PATH });
    await migrateLegacyPets(store, LEGACY_ROOT);
    const config = store.get();
    expect(config.migrationVersion).toBe(1);
    // 只迁移五态：IDLE=0、RUNNING=7；WAVING/REVIEW 忽略
    expect(config.petOverrides["ompet:remilia"]?.stateRows).toEqual({
      IDLE: 0,
      RUNNING: 7,
    });
    // 迁移修改配置 → revision 增加（desktop 感知新映射）
    expect(config.revision).toBeGreaterThan(0);
  });

  test("无旧目录 → 仅标记 migrationVersion=1，无 override", async () => {
    const store = new ConfigStore({ configPath: CONFIG_PATH });
    await migrateLegacyPets(store, LEGACY_ROOT);
    expect(store.get().migrationVersion).toBe(1);
    expect(store.get().petOverrides).toEqual({});
  });

  test("无 lines 字段 → 不迁移映射，仅标记版本", async () => {
    seedLegacyPet("plain", { id: "plain", spritesheetPath: "spritesheet.webp" });
    const store = new ConfigStore({ configPath: CONFIG_PATH });
    await migrateLegacyPets(store, LEGACY_ROOT);
    expect(store.get().migrationVersion).toBe(1);
    expect(store.get().petOverrides).toEqual({});
  });

  test("部分映射（仅 IDLE+RUNNING）→ 只迁移这两个", async () => {
    seedLegacyPet("p", {
      id: "p",
      spritesheetPath: "spritesheet.webp",
      lines: { "0": "IDLE", "7": "RUNNING" },
    });
    const store = new ConfigStore({ configPath: CONFIG_PATH });
    await migrateLegacyPets(store, LEGACY_ROOT);
    expect(store.get().petOverrides["ompet:p"]?.stateRows).toEqual({
      IDLE: 0,
      RUNNING: 7,
    });
  });

  test("非法映射（未知枚举）→ 不产生 override", async () => {
    seedLegacyPet("bad", {
      id: "bad",
      spritesheetPath: "spritesheet.webp",
      lines: { "0": "NOPE" },
    });
    const store = new ConfigStore({ configPath: CONFIG_PATH });
    await migrateLegacyPets(store, LEGACY_ROOT);
    expect(store.get().petOverrides).toEqual({});
    expect(store.get().migrationVersion).toBe(1);
  });

  test("损坏宠物包跳过，不阻断迁移", async () => {
    const dir = path.join(LEGACY_ROOT, "broken");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "pet.json"), "{broken");
    seedLegacyPet("good", { id: "good", spritesheetPath: "s.webp", lines: { "7": "RUNNING" } });
    const store = new ConfigStore({ configPath: CONFIG_PATH });
    await migrateLegacyPets(store, LEGACY_ROOT);
    expect(store.get().migrationVersion).toBe(1);
    expect(store.get().petOverrides["ompet:good"]?.stateRows?.RUNNING).toBe(7);
  });

  test("重复启动幂等：第二次调用不重复迁移、不改变 revision", async () => {
    seedLegacyPet("remilia", {
      id: "remilia",
      spritesheetPath: "spritesheet.webp",
      lines: { "7": "RUNNING" },
    });
    const store = new ConfigStore({ configPath: CONFIG_PATH });
    await migrateLegacyPets(store, LEGACY_ROOT);
    const afterFirst = store.get().revision;
    // 模拟重启：新 store 读盘
    const store2 = new ConfigStore({ configPath: CONFIG_PATH });
    await migrateLegacyPets(store2);
    expect(store2.get().migrationVersion).toBe(1);
    expect(store2.get().petOverrides["ompet:remilia"]?.stateRows?.RUNNING).toBe(7);
    expect(store2.get().revision).toBe(afterFirst); // 未重复迁移
  });

  test("只读旧目录：迁移后旧 pet.json 字节不变", async () => {
    const manifest = {
      id: "remilia",
      spritesheetPath: "spritesheet.webp",
      lines: { "0": "IDLE", "7": "RUNNING" },
    };
    seedLegacyPet("remilia", manifest);
    const manifestPath = path.join(LEGACY_ROOT, "remilia", "pet.json");
    const before = fs.readFileSync(manifestPath);
    const store = new ConfigStore({ configPath: CONFIG_PATH });
    await migrateLegacyPets(store, LEGACY_ROOT);
    const after = fs.readFileSync(manifestPath);
    expect(after.equals(before)).toBe(true);
    // 目录仍然存在，未删除
    expect(fs.existsSync(path.join(LEGACY_ROOT, "remilia"))).toBe(true);
  });
});
