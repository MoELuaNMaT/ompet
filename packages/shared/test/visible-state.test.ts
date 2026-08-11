/**
 * resolveVisibleState 真值表测试（方案 §65 Shared）。
 * Activity(3) × Motion(3) 全组合 → 五态。
 */
import { describe, expect, test } from "bun:test";
import type { Activity } from "../src/activity.ts";
import type { Motion } from "../src/visible-state.ts";
import { resolveVisibleState } from "../src/visible-state.ts";

const activities: readonly Activity[] = ["idle", "working", "waiting"];
const motions: readonly Motion[] = ["none", "left", "right"];

describe("resolveVisibleState 优先级真值表", () => {
  test("waiting 恒为 WAITING（业务最高优先）", () => {
    for (const motion of motions) {
      expect(resolveVisibleState("waiting", motion)).toBe("WAITING");
    }
  });

  test("working 恒为 RUNNING（业务优先于移动）", () => {
    for (const motion of motions) {
      expect(resolveVisibleState("working", motion)).toBe("RUNNING");
    }
  });

  test("idle + left → MOVE_LEFT", () => {
    expect(resolveVisibleState("idle", "left")).toBe("MOVE_LEFT");
  });

  test("idle + right → MOVE_RIGHT", () => {
    expect(resolveVisibleState("idle", "right")).toBe("MOVE_RIGHT");
  });

  test("idle + none → IDLE", () => {
    expect(resolveVisibleState("idle", "none")).toBe("IDLE");
  });

  test("全组合覆盖且无遗漏", () => {
    const seen = new Set<string>();
    for (const activity of activities) {
      for (const motion of motions) {
        seen.add(resolveVisibleState(activity, motion));
      }
    }
    expect([...seen].sort()).toEqual([
      "IDLE",
      "MOVE_LEFT",
      "MOVE_RIGHT",
      "RUNNING",
      "WAITING",
    ]);
  });
});
