/**
 * 移动控制器单测：方向滞回、拖拽结束、业务状态取消。
 * 覆盖方案验收：方向切换需跨过 8px 滞回；移动中进 working/waiting 立即取消。
 */
import { describe, expect, test } from "bun:test";
import { MovementController } from "../src/lib/movement.ts";
import { PET_CONFIG } from "../../packages/shared/src/index.ts";

const HYSTERESIS = PET_CONFIG.movementDirectionHysteresisPx;

describe("MovementController", () => {
  test("初始 none", () => {
    const m = new MovementController();
    expect(m.motion).toBe("none");
  });

  test("增量跨过滞回阈值才切换方向", () => {
    const m = new MovementController();
    m.updateDrag(1, 1000);
    expect(m.motion).toBe("none"); // 未跨过
    m.updateDrag(HYSTERESIS - 1, 1010);
    expect(m.motion).toBe("none");
    m.updateDrag(HYSTERESIS, 1020);
    expect(m.motion).toBe("right");
    m.updateDrag(-HYSTERESIS, 1030);
    expect(m.motion).toBe("left");
  });

  test("同方向连续增量不重置计时（微小坐标修正不重置动画）", () => {
    const m = new MovementController();
    m.updateDrag(HYSTERESIS, 1000);
    expect(m.motion).toBe("right");
    m.updateDrag(2, 2000);
    expect(m.motion).toBe("right");
  });

  test("endDrag 回到 none", () => {
    const m = new MovementController();
    m.updateDrag(HYSTERESIS, 1000);
    expect(m.motion).toBe("right");
    m.endDrag();
    expect(m.motion).toBe("none");
  });

  test("cancel 回到 none（业务状态转 working/waiting 时调用）", () => {
    const m = new MovementController();
    m.updateDrag(-HYSTERESIS, 1000);
    expect(m.motion).toBe("left");
    m.cancel();
    expect(m.motion).toBe("none");
    m.cancel(); // 幂等
    expect(m.motion).toBe("none");
  });

  test("none 状态下 cancel/endDrag 无副作用", () => {
    const m = new MovementController();
    m.cancel();
    m.endDrag();
    expect(m.motion).toBe("none");
  });
});
