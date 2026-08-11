import { describe, expect, test } from "bun:test";
import {
  aggregateActivity,
  bubbleStatus,
  DONE_DURATION_MS,
  pointInExpandZone,
  pointInRect,
  pointInTriangle,
  STATUS_LABEL,
} from "../src/lib/bubbles.ts";

describe("aggregateActivity", () => {
  test("任一 waiting → waiting（优先级最高）", () => {
    expect(aggregateActivity(["idle", "working", "waiting"])).toBe("waiting");
  });

  test("无 waiting、任一 working → working", () => {
    expect(aggregateActivity(["idle", "working", "idle"])).toBe("working");
  });

  test("全 idle → idle", () => {
    expect(aggregateActivity(["idle", "idle"])).toBe("idle");
  });

  test("空数组 → idle", () => {
    expect(aggregateActivity([])).toBe("idle");
  });
});

describe("bubbleStatus", () => {
  test("working/waiting 原样（不受 doneAt 影响）", () => {
    expect(bubbleStatus("working", null, 0)).toBe("working");
    expect(bubbleStatus("waiting", 999, 0)).toBe("waiting");
  });

  test("idle + doneAt 在窗口期 → done", () => {
    expect(bubbleStatus("idle", 1000, 1000 + DONE_DURATION_MS - 1)).toBe("done");
  });

  test("idle + doneAt 过期 → idle", () => {
    expect(bubbleStatus("idle", 1000, 1000 + DONE_DURATION_MS)).toBe("idle");
    expect(bubbleStatus("idle", null, 0)).toBe("idle");
  });

  test("STATUS_LABEL 四态齐全", () => {
    expect(STATUS_LABEL.done).toBe("任务完成");
    expect(STATUS_LABEL.working).toBe("运行中");
    expect(STATUS_LABEL.waiting).toBe("等待回复");
    expect(STATUS_LABEL.idle).toBe("待机中");
  });
});

describe("pointInTriangle", () => {
  // 三角形：顶点 (0,0)，底边两端 (-10,10) / (10,10)
  const apex = { x: 0, y: 0 };
  const bl = { x: -10, y: 10 };
  const br = { x: 10, y: 10 };

  test("三角形内部 → true", () => {
    expect(pointInTriangle({ x: 0, y: 5 }, apex, bl, br)).toBe(true);
    expect(pointInTriangle({ x: -5, y: 7 }, apex, bl, br)).toBe(true);
    expect(pointInTriangle({ x: 4, y: 9 }, apex, bl, br)).toBe(true);
  });

  test("三角形外部 → false", () => {
    expect(pointInTriangle({ x: 0, y: 11 }, apex, bl, br)).toBe(false);
    expect(pointInTriangle({ x: 12, y: 5 }, apex, bl, br)).toBe(false);
    expect(pointInTriangle({ x: 0, y: -2 }, apex, bl, br)).toBe(false);
    expect(pointInTriangle({ x: -12, y: 5 }, apex, bl, br)).toBe(false);
  });

  test("边界（顶点/底边）→ true（含边界）", () => {
    expect(pointInTriangle(apex, apex, bl, br)).toBe(true);
    expect(pointInTriangle({ x: 0, y: 10 }, apex, bl, br)).toBe(true);
    expect(pointInTriangle({ x: 5, y: 5 }, apex, bl, br)).toBe(true);
  });
});

describe("pointInRect", () => {
  // 矩形：x∈[10,40]，y∈[20,60]
  const rect = { x: 10, y: 20, width: 30, height: 40 };

  test("矩形内部（含边界）→ true", () => {
    expect(pointInRect({ x: 20, y: 30 }, rect)).toBe(true);
    expect(pointInRect({ x: 10, y: 20 }, rect)).toBe(true); // 左上角
    expect(pointInRect({ x: 40, y: 60 }, rect)).toBe(true); // 右下角
    expect(pointInRect({ x: 40, y: 20 }, rect)).toBe(true); // 右上角
  });

  test("矩形外部 → false", () => {
    expect(pointInRect({ x: 9, y: 30 }, rect)).toBe(false);
    expect(pointInRect({ x: 41, y: 30 }, rect)).toBe(false);
    expect(pointInRect({ x: 20, y: 19 }, rect)).toBe(false);
    expect(pointInRect({ x: 20, y: 61 }, rect)).toBe(false);
  });

  test("pad 容差带内（距边界 ≤ pad）→ true", () => {
    expect(pointInRect({ x: 4, y: 20 }, rect, 6)).toBe(true);   // 左边外 6px
    expect(pointInRect({ x: 46, y: 20 }, rect, 6)).toBe(true);  // 右边外 6px
    expect(pointInRect({ x: 10, y: 14 }, rect, 6)).toBe(true);  // 上边外 6px
    expect(pointInRect({ x: 10, y: 66 }, rect, 6)).toBe(true);  // 下边外 6px
    expect(pointInRect({ x: 4, y: 14 }, rect, 6)).toBe(true);   // 角（双轴均在带内）
  });

  test("pad 容差带外 → false", () => {
    expect(pointInRect({ x: 3, y: 20 }, rect, 6)).toBe(false);  // 左边外 7px
    expect(pointInRect({ x: 47, y: 20 }, rect, 6)).toBe(false); // 右边外 7px
    expect(pointInRect({ x: 10, y: 13 }, rect, 6)).toBe(false); // 上边外 7px
    expect(pointInRect({ x: 10, y: 67 }, rect, 6)).toBe(false); // 下边外 7px
    expect(pointInRect({ x: 3, y: 13 }, rect, 6)).toBe(false);  // 角（双轴均在带外）
  });

  test("pad=0 时无容差（与无 pad 等价）", () => {
    expect(pointInRect({ x: 9, y: 30 }, rect, 0)).toBe(false);
    expect(pointInRect({ x: 10, y: 30 }, rect, 0)).toBe(true);
  });
});

describe("pointInExpandZone（气泡展开热区：slot ① + 气泡 bbox ② + 过渡带三角形 ③）", () => {
  // 布局数字与 240 宽窗口一致：slot x89..117 / y42..70，预留行 x24..216 / y76..104
  const slot = { x: 89, y: 42, width: 28, height: 28 };
  const expanded = { x: 24, y: 76, width: 192, height: 28 };
  const pad = 10;
  // 非溢出胶囊（居中）：x51..189
  const capsule = { x: 51, y: 76, width: 138, height: 28 };
  // 长项目名溢出胶囊（居中溢出容器）：x8..232
  const overflowCapsule = { x: 8, y: 76, width: 224, height: 28 };
  // 阶段 1 圆球形态（orb 28px 居中于预留行）：x106..134
  const orb = { x: 106, y: 76, width: 28, height: 28 };

  test("① slot 内 → true（hover 起点/下移早期）", () => {
    expect(pointInExpandZone({ x: 103, y: 56 }, slot, capsule, expanded, pad)).toBe(true);
  });

  test("① slot 容差带内（距边界 ≤ pad）→ true", () => {
    expect(pointInExpandZone({ x: 127, y: 80 }, slot, capsule, expanded, pad)).toBe(true);
  });

  test("② 展开胶囊内（slot 外）→ true", () => {
    expect(pointInExpandZone({ x: 120, y: 90 }, slot, capsule, expanded, pad)).toBe(true);
  });

  test("② 胶囊溢出部分（bbox 含溢出、容器矩形外）→ true（修复悬停自缩）", () => {
    expect(pointInExpandZone({ x: 9, y: 90 }, slot, overflowCapsule, expanded, pad)).toBe(true);
    expect(pointInExpandZone({ x: 230, y: 90 }, slot, overflowCapsule, expanded, pad)).toBe(true);
  });

  test("② 胶囊外行内空白 → false（修复整行容器导致的该收不收）", () => {
    // x=220 在容器 x24..216+10 容差内、胶囊 x51..189 外、三角形底边外
    expect(pointInExpandZone({ x: 220, y: 90 }, slot, capsule, expanded, pad)).toBe(false);
  });

  test("动画进行中热区放宽（bubble=整行容器）：行内提前到位 → true（移动中不误收）", () => {
    // 展开动画期间（morph 锁未清）②以容器矩形判定：鼠标提前移到胶囊旁行内等待
    // 不被中途收窄的实时 bbox 误判移出；动画完成收窄后由上一用例保证行内空白收回
    expect(pointInExpandZone({ x: 200, y: 90 }, slot, expanded, expanded, pad)).toBe(true);
    expect(pointInExpandZone({ x: 40, y: 90 }, slot, expanded, expanded, pad)).toBe(true);
  });

  test("slotPad 独立放大：slot 外 24px 内命中（缓慢移动/手抖不脱离热区）", () => {
    // slot x89..117，slotPad=24 → ① x65..141 / y18..94
    expect(pointInExpandZone({ x: 130, y: 56 }, slot, capsule, expanded, pad, 24)).toBe(true);
    expect(pointInExpandZone({ x: 70, y: 56 }, slot, capsule, expanded, pad, 24)).toBe(true);
    // slotPad 之外（x=150 仍远）→ 靠 ②/③ 判定
    expect(pointInExpandZone({ x: 150, y: 56 }, slot, capsule, expanded, pad, 24)).toBe(false);
  });

  test("slotPad 不影响 ② 容差：胶囊外行内空白仍 false（该收不收不回潮）", () => {
    expect(pointInExpandZone({ x: 205, y: 90 }, slot, capsule, expanded, pad, 24)).toBe(false);
  });

  test("③ slot 与预留行之间的过渡带 → true", () => {
    expect(pointInExpandZone({ x: 103, y: 72 }, slot, capsule, expanded, pad)).toBe(true);
  });

  test("③ 鼠标提前下移到展开位置等待（orb 窄 bbox 外、三角形内）→ true", () => {
    expect(pointInExpandZone({ x: 150, y: 80 }, slot, orb, expanded, pad)).toBe(true);
  });

  test("③ 提前下移等待但偏出行内（三角形底边外）→ false", () => {
    expect(pointInExpandZone({ x: 220, y: 80 }, slot, orb, expanded, pad)).toBe(false);
  });

  test("完全外部 → false", () => {
    expect(pointInExpandZone({ x: 20, y: 120 }, slot, capsule, expanded, pad)).toBe(false);
  });
});
