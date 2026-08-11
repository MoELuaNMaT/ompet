/**
 * ConfigStore 测试（方案 §65 ConfigStore）。
 * 注入临时目录 configPath，不触碰真实 ~/.omp/ompet/config.json。
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigStore,
  sanitizeConfig,
} from "../src/config-store.ts";
import type { OMPetConfig } from "../../packages/shared/src/index.ts";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ompet-config-"));
  configPath = join(dir, "config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readConfig(): OMPetConfig {
  return JSON.parse(readFileSync(configPath, "utf8")) as OMPetConfig;
}

describe("ConfigStore 默认配置", () => {
  test("无文件 → 内存默认配置（不落盘）", async () => {
    const store = new ConfigStore({ configPath });
    expect(store.get()).toEqual({
      schemaVersion: 1,
      revision: 0,
      enabled: true,
      activePet: null,
      petOverrides: {},
      migrationVersion: 0,
    });
    expect(existsSync(configPath)).toBe(false);
  });

  test("load() 契约返回配置", async () => {
    const store = new ConfigStore({ configPath });
    const config = await store.load();
    expect(config.enabled).toBe(true);
  });
});

describe("ConfigStore revision 语义（方案 §17）", () => {
  test("setEnabled 变化 → revision++ 且写盘", async () => {
    const store = new ConfigStore({ configPath });
    await store.setEnabled(false);
    expect(store.get().revision).toBe(1);
    expect(store.get().enabled).toBe(false);
    expect(readConfig().enabled).toBe(false);
    expect(readConfig().revision).toBe(1);
  });

  test("setEnabled 同值 → 不写盘不 ++revision", async () => {
    const store = new ConfigStore({ configPath });
    await store.setEnabled(true); // 与默认相同
    expect(store.get().revision).toBe(0);
    expect(existsSync(configPath)).toBe(false);
  });

  test("setActivePet 变化 → revision++", async () => {
    const store = new ConfigStore({ configPath });
    await store.setActivePet("codex:remilia");
    expect(store.get().activePet).toBe("codex:remilia");
    expect(store.get().revision).toBe(1);
  });

  test("setActivePet 同值 → 不写不 ++revision", async () => {
    const store = new ConfigStore({ configPath });
    await store.setActivePet("codex:remilia");
    await store.setActivePet("codex:remilia");
    expect(store.get().revision).toBe(1);
  });

  test("setStateRow 变化 → revision++ 且写入 override", async () => {
    const store = new ConfigStore({ configPath });
    await store.setStateRow("codex:remilia", "RUNNING", 3);
    expect(store.get().revision).toBe(1);
    expect(store.get().petOverrides["codex:remilia"]?.stateRows?.RUNNING).toBe(3);
  });

  test("setStateRow 同值 → 不写不 ++revision", async () => {
    const store = new ConfigStore({ configPath });
    await store.setStateRow("codex:remilia", "RUNNING", 3);
    const rev = store.get().revision;
    await store.setStateRow("codex:remilia", "RUNNING", 3);
    expect(store.get().revision).toBe(rev);
  });

  test("setStateRow 重复保存同值（多状态同一行）不产生 revision", async () => {
    const store = new ConfigStore({ configPath });
    await store.setStateRow("codex:remilia", "RUNNING", 7);
    await store.setStateRow("codex:remilia", "WAITING", 7);
    expect(store.get().revision).toBe(2);
    expect(store.get().petOverrides["codex:remilia"]?.stateRows).toEqual({
      RUNNING: 7,
      WAITING: 7,
    });
  });

  test("setStateRow 拒绝非五态状态", async () => {
    const store = new ConfigStore({ configPath });
    expect(() =>
      store.setStateRow("codex:remilia", "WAVING" as never, 3),
    ).toThrow(/五个正式状态/);
    expect(store.get().revision).toBe(0);
  });

  test("setStateRow 拒绝非法行号", async () => {
    const store = new ConfigStore({ configPath });
    expect(() =>
      store.setStateRow("codex:remilia", "IDLE", -1),
    ).toThrow(/非负整数/);
    expect(() =>
      store.setStateRow("codex:remilia", "IDLE", 1.5),
    ).toThrow(/非负整数/);
  });

  test("resetStateRows 删除 override（不写默认值）", async () => {
    const store = new ConfigStore({ configPath });
    await store.setStateRow("codex:remilia", "RUNNING", 3);
    await store.resetStateRows("codex:remilia");
    expect(store.get().petOverrides["codex:remilia"]?.stateRows).toBeUndefined();
    expect(store.get().revision).toBe(2);
  });

  test("resetStateRows 无 override → 不写不 ++revision", async () => {
    const store = new ConfigStore({ configPath });
    await store.resetStateRows("codex:remilia");
    expect(store.get().revision).toBe(0);
    expect(existsSync(configPath)).toBe(false);
  });
});

describe("ConfigStore 原子写", () => {
  test("写盘后无 .tmp 残留，正式文件存在", async () => {
    const store = new ConfigStore({ configPath });
    await store.setEnabled(false);
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(`${configPath}.tmp`)).toBe(false);
  });

  test("写失败不 throw（只 warning）", async () => {
    const store = new ConfigStore({ configPath: join(dir, "nonexistent", "sub", "config.json") });
    await store.setEnabled(false);
    expect(store.get().enabled).toBe(false); // 内存已更新
  });
});

describe("ConfigStore 损坏容错（方案 §37 / §69）", () => {
  test("损坏 JSON → 默认配置", () => {
    writeFileSync(configPath, "{ not json");
    const store = new ConfigStore({ configPath });
    expect(store.get().revision).toBe(0);
    expect(store.get().enabled).toBe(true);
  });

  test("schemaVersion 非法 → 默认配置", () => {
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 99, revision: 5 }));
    const store = new ConfigStore({ configPath });
    expect(store.get().revision).toBe(0);
  });

  test("字段级非法值逐字段回退", () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 3,
        enabled: "yes",
        activePet: "bad-key",
        petOverrides: { "codex:remilia": { stateRows: { RUNNING: "x", IDLE: 2 } } },
        migrationVersion: -1,
      }),
    );
    const store = new ConfigStore({ configPath });
    expect(store.get().revision).toBe(3);
    expect(store.get().enabled).toBe(true);
    expect(store.get().activePet).toBeNull();
    expect(store.get().petOverrides["codex:remilia"]?.stateRows).toEqual({ IDLE: 2 });
    expect(store.get().migrationVersion).toBe(0);
  });

  test("合法文件 → 完整读取", async () => {
    const store = new ConfigStore({ configPath });
    await store.setStateRow("codex:remilia", "RUNNING", 4);
    const reopened = new ConfigStore({ configPath });
    expect(reopened.get().petOverrides["codex:remilia"]?.stateRows?.RUNNING).toBe(4);
    expect(reopened.get().revision).toBe(1);
  });
});

describe("sanitizeConfig", () => {
  test("非对象 → 默认", () => {
    expect(sanitizeConfig(null)).toEqual(expect.objectContaining({ schemaVersion: 1 }));
    expect(sanitizeConfig("x")).toEqual(expect.objectContaining({ schemaVersion: 1 }));
  });
});
