/**
 * SpriteAnimator 测试（方案 §65 SpriteAnimator）：fake canvas + 注入 clock。
 * 覆盖：IDLE 帧循环、RUNNING 10 分钟/WAITING 10 小时持续循环、
 * 同状态 setState 不重置计时、状态变化重置、stateRows 决定源行。
 */
import { describe, expect, test } from "bun:test";
import { SpriteAnimator } from "../src/lib/sprite-animator.ts";
import type { LoadedPet } from "../src/lib/pet-loader.ts";
import type { StateRowMap, VisiblePetState } from "../../packages/shared/src/index.ts";

/** 记录 drawImage 裁切参数的 fake ctx */
function makeCanvas() {
  const calls: { sx: number; sy: number }[] = [];
  const ctx = {
    clearRect: () => {},
    drawImage: (
      _img: unknown,
      sx: number,
      sy: number,
      _sw: number,
      _sh: number,
      _dx: number,
      _dy: number,
      _dw: number,
      _dh: number,
    ) => {
      calls.push({ sx, sy });
    },
    imageSmoothingEnabled: false,
  };
  const canvas = {
    width: 240,
    height: 280,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
  return { canvas, calls };
}

const stateRows: StateRowMap = {
  IDLE: 0,
  RUNNING: 7,
  WAITING: 6,
  MOVE_LEFT: 2,
  MOVE_RIGHT: 1,
};

function makePet(over: Partial<LoadedPet> = {}): LoadedPet {
  return {
    key: "codex:remilia",
    manifest: { id: "remilia", spritesheetPath: "spritesheet.webp" },
    layout: { version: 1, columns: 8, rows: 9, frameWidth: 192, frameHeight: 208 },
    image: {} as HTMLImageElement,
    stateRows,
    // 默认全行 8 帧（历史行为）；按行帧数测试覆盖 in over
    validFrames: Array(9).fill(8),
    ...over,
  };
}

function makeAnimator() {
  const { canvas, calls } = makeCanvas();
  let now = 0;
  const animator = new SpriteAnimator(canvas, () => now);
  return {
    animator,
    calls,
    /** 推进注入时钟并 tick */
    advance: (ms: number) => {
      now += ms;
      animator.tick(now);
    },
  };
}

describe("SpriteAnimator 帧推进（8fps 纯循环）", () => {
  test("IDLE 帧 0→1→...→7→0 循环，源行 = stateRows[IDLE]", () => {
    const { animator, calls, advance } = makeAnimator();
    animator.setPet(makePet());
    animator.setState("IDLE");
    expect(calls.at(-1)).toEqual({ sx: 0, sy: 0 }); // 帧 0、行 0

    for (let frame = 1; frame <= 8; frame++) {
      advance(125);
      expect(calls.at(-1)).toEqual({ sx: (frame % 8) * 192, sy: 0 });
    }
  });

  test("RUNNING 10 分钟仍循环（无回落无超时），源行 = 7", () => {
    const { animator, calls, advance } = makeAnimator();
    animator.setPet(makePet());
    animator.setState("RUNNING");
    advance(10 * 60 * 1000);
    const frame = Math.floor((10 * 60 * 1000) / 125) % 8;
    expect(calls.at(-1)).toEqual({ sx: frame * 192, sy: 7 * 208 });
  });

  test("WAITING 10 小时仍循环，源行 = 6", () => {
    const { animator, calls, advance } = makeAnimator();
    animator.setPet(makePet());
    animator.setState("WAITING");
    advance(10 * 60 * 60 * 1000);
    const frame = Math.floor((10 * 60 * 60 * 1000) / 125) % 8;
    expect(calls.at(-1)).toEqual({ sx: frame * 192, sy: 6 * 208 });
  });

  test("无宠物/无状态 → 不绘制（清空）", () => {
    const { animator, calls, advance } = makeAnimator();
    advance(1000);
    expect(calls).toEqual([]);
    animator.setPet(makePet());
    advance(1000); // 无状态
    expect(calls).toEqual([]);
  });
});

describe("setState 计时语义（方案 §46）", () => {
  test("同状态 setState → animationStartedAt 不变（帧序连续不重置）", () => {
    const { animator, calls, advance } = makeAnimator();
    animator.setPet(makePet());
    animator.setState("IDLE");
    advance(125 * 3); // 帧 3
    expect(calls.at(-1)?.sx).toBe(3 * 192);
    animator.setState("IDLE"); // 同状态：不重置
    advance(125 * 2); // 继续推进
    expect(calls.at(-1)?.sx).toBe(5 * 192); // 未重置回 0
  });

  test("状态变化 → animationStartedAt 重置（帧回 0）", () => {
    const { animator, calls, advance } = makeAnimator();
    animator.setPet(makePet());
    animator.setState("IDLE");
    advance(125 * 5);
    animator.setState("RUNNING"); // clock=625 → 重置
    advance(0); // 同刻 tick：帧 0
    expect(calls.at(-1)).toEqual({ sx: 0, sy: 7 * 208 });
  });

  test("状态变化 → 源行切换（IDLE 行 0 → MOVE_LEFT 行 2）", () => {
    const { animator, calls } = makeAnimator();
    animator.setPet(makePet());
    animator.setState("IDLE");
    animator.setState("MOVE_LEFT");
    expect(calls.at(-1)).toEqual({ sx: 0, sy: 2 * 208 });
  });
});

describe("setPet", () => {
  test("换宠物 → 状态与计时重置", () => {
    const { animator, calls, advance } = makeAnimator();
    animator.setPet(makePet());
    animator.setState("IDLE");
    advance(125 * 4);
    animator.setPet(makePet({ stateRows: { ...stateRows, IDLE: 5 } }));
    animator.tick(1000); // 无状态 → 不绘制
    animator.setState("IDLE");
    expect(calls.at(-1)).toEqual({ sx: 0, sy: 5 * 208 });
  });
});

describe("状态行映射（VisiblePetState 全五态）", () => {
  test("五个状态各自绘制对应行", () => {
    const { animator, calls } = makeAnimator();
    animator.setPet(makePet());
    const expectedRow: Record<VisiblePetState, number> = {
      IDLE: 0,
      RUNNING: 7,
      WAITING: 6,
      MOVE_LEFT: 2,
      MOVE_RIGHT: 1,
    };
    for (const state of Object.keys(expectedRow) as VisiblePetState[]) {
      animator.setState(state);
      expect(calls.at(-1)).toEqual({ sx: 0, sy: expectedRow[state]! * 208 });
    }
  });
});

describe("每行有效帧数（validFrames 跳过行尾空白帧）", () => {
  /** remilia 实测形态：row0=6、row1=8、row6=6、row7=6 */
  const realFrames = [6, 8, 8, 4, 5, 8, 6, 6, 6];

  test("6 帧行：IDLE 帧 0→5 后回 0（不再播空白帧 6/7）", () => {
    const { animator, calls, advance } = makeAnimator();
    animator.setPet(makePet({ validFrames: realFrames }));
    animator.setState("IDLE");
    expect(calls.at(-1)).toEqual({ sx: 0, sy: 0 });

    advance(125 * 5); // 帧 5
    expect(calls.at(-1)).toEqual({ sx: 5 * 192, sy: 0 });

    advance(125); // 帧 6 → 应回到 0（6 帧循环），而非旧行为 sx=6*192
    expect(calls.at(-1)).toEqual({ sx: 0, sy: 0 });

    // 持续循环：帧 4（=10 % 6）
    advance(125 * 4);
    expect(calls.at(-1)).toEqual({ sx: 4 * 192, sy: 0 });
  });

  test("8 帧行不受影响：MOVE_RIGHT 帧 0→7→0", () => {
    const { animator, calls, advance } = makeAnimator();
    animator.setPet(makePet({ validFrames: realFrames }));
    animator.setState("MOVE_RIGHT");
    for (let frame = 1; frame <= 8; frame++) {
      advance(125);
      expect(calls.at(-1)).toEqual({ sx: (frame % 8) * 192, sy: 1 * 208 });
    }
  });

  test("不同行不同周期：WAITING(6 帧) 与 RUNNING(6 帧) 均在 6 帧处回 0", () => {
    const { animator, calls, advance } = makeAnimator();
    animator.setPet(makePet({ validFrames: realFrames }));

    animator.setState("WAITING");
    advance(125 * 6);
    expect(calls.at(-1)).toEqual({ sx: 0, sy: 6 * 208 });

    animator.setState("RUNNING");
    advance(125 * 6);
    expect(calls.at(-1)).toEqual({ sx: 0, sy: 7 * 208 });
  });

  test("行有效帧数缺失 → 回退 8（防御）", () => {
    const { animator, calls, advance } = makeAnimator();
    // 只提供 3 行数据，WAITING 映射行 6 超出 → 回退 8 帧循环
    animator.setPet(makePet({ validFrames: [6, 8, 8] }));
    animator.setState("WAITING");
    for (let frame = 1; frame <= 8; frame++) {
      advance(125);
      expect(calls.at(-1)).toEqual({ sx: (frame % 8) * 192, sy: 6 * 208 });
    }
  });
});
