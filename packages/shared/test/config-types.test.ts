/**
 * resolveStateRows / 默认映射 / 配置语义测试（方案 §65 Shared）。
 */
import { describe, expect, test } from "bun:test";
import {
  createDefaultConfig,
  DEFAULT_FPS,
  DEFAULT_STATE_ROWS,
  resolveStateRows,
  type OMPetConfig,
  type PetOverride,
  type StateRowMap,
} from "../src/config-types.ts";
import type { VisiblePetState } from "../src/visible-state.ts";

describe("DEFAULT_STATE_ROWS 固定契约（方案 §11）", () => {
  test("五个状态的行号固定", () => {
    expect(DEFAULT_STATE_ROWS).toEqual({
      IDLE: 0,
      MOVE_RIGHT: 1,
      MOVE_LEFT: 2,
      WAITING: 6,
      RUNNING: 7,
    });
  });

  test("默认 FPS = 8", () => {
    expect(DEFAULT_FPS).toBe(8);
  });
});

describe("resolveStateRows", () => {
  test("无 override → 默认映射（新对象，非引用 default）", () => {
    const rows = resolveStateRows();
    expect(rows).toEqual({ ...DEFAULT_STATE_ROWS });
    expect(rows).not.toBe(DEFAULT_STATE_ROWS);
  });

  test("partial override 合并：只覆盖给定状态", () => {
    const rows = resolveStateRows({ stateRows: { RUNNING: 3 } });
    expect(rows.RUNNING).toBe(3);
    expect(rows.IDLE).toBe(0);
    expect(rows.WAITING).toBe(6);
    expect(rows.MOVE_LEFT).toBe(2);
    expect(rows.MOVE_RIGHT).toBe(1);
  });

  test("多个状态允许共享同一行（不互斥、不抢占）", () => {
    const rows = resolveStateRows({
      stateRows: { RUNNING: 7, WAITING: 7 },
    });
    expect(rows.RUNNING).toBe(7);
    expect(rows.WAITING).toBe(7);
  });

  test("非法值（非数字）忽略，保留默认", () => {
    const override = {
      stateRows: { RUNNING: "x" as unknown as number },
    };
    const rows = resolveStateRows(override);
    expect(rows.RUNNING).toBe(7);
  });

  test("空 override → 默认；反复调用不污染 default object", () => {
    const a = resolveStateRows({ stateRows: { IDLE: 5 } });
    expect(a.IDLE).toBe(5);
    expect(DEFAULT_STATE_ROWS.IDLE).toBe(0);
    const b = resolveStateRows();
    expect(b.IDLE).toBe(0);
  });

  test("默认映射行号均可被覆盖为 0–10 范围外的值（越界校验由调用方负责）", () => {
    const rows = resolveStateRows({ stateRows: { IDLE: 10 } });
    expect(rows.IDLE).toBe(10);
  });
});

describe("createDefaultConfig（方案 §69 fallback）", () => {
  test("默认配置字段", () => {
    const config: OMPetConfig = createDefaultConfig();
    expect(config.schemaVersion).toBe(1);
    expect(config.revision).toBe(0);
    expect(config.enabled).toBe(true);
    expect(config.activePet).toBeNull();
    expect(config.petOverrides).toEqual({});
    expect(config.migrationVersion).toBe(0);
  });
});

describe("PetOverride 契约", () => {
  test("fps 为可选统一帧率字段", () => {
    const override: PetOverride = { stateRows: { RUNNING: 3 }, fps: 12 };
    const rows: StateRowMap = resolveStateRows(override);
    expect(rows.RUNNING).toBe(3);
    expect(override.fps).toBe(12);
  });

  test("stateRows 键必须是五个正式状态", () => {
    const key: keyof StateRowMap = "WAITING" satisfies VisiblePetState;
    expect(key).toBe("WAITING");
  });
});
