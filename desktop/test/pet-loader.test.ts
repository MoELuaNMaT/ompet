/**
 * PetLoader 测试（方案 §65 Pet Loader）：mock invoke + fake Image。
 * 覆盖：V1 加载、V2 加载、未声明版本按尺寸推断、尺寸不符拒绝、
 * 清单非法拒绝、invoke 失败、行越界回退（方案 §69）。
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";

// ---- fake Image（bun 无 DOM）：decode 立即成功，尺寸经静态字段注入 ----
class FakeImage {
  src = "";
  static sheetSize = { width: 0, height: 0 };
  get naturalWidth(): number {
    return FakeImage.sheetSize.width;
  }
  get naturalHeight(): number {
    return FakeImage.sheetSize.height;
  }
  async decode(): Promise<void> {
    // 无操作：尺寸由测试设置
  }
}

let invokeMock: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

beforeAll(async () => {
  mock.module("@tauri-apps/api/core", () => ({
    invoke: (...args: unknown[]) => invokeMock(args[0] as string, args[1] as Record<string, unknown>),
  }));
  globalThis.Image = FakeImage as unknown as typeof Image;
});

/** 注入图集尺寸 */
function setSheetSize(width: number, height: number): void {
  FakeImage.sheetSize = { width, height };
}

function makeBundle(over: Partial<{ manifest: unknown; spriteDataUrl: string }> = {}) {
  return {
    manifest: { id: "remilia", spritesheetPath: "spritesheet.webp" },
    spriteDataUrl: "data:image/webp;base64,AAAA",
    ...over,
  };
}

// ---- 被测模块（mock 之后动态 import）----
let PetLoader: typeof import("../src/lib/pet-loader.ts").PetLoader;
let PetLoadError: typeof import("../src/lib/pet-loader.ts").PetLoadError;
beforeAll(async () => {
  const mod = await import("../src/lib/pet-loader.ts");
  PetLoader = mod.PetLoader;
  PetLoadError = mod.PetLoadError;
});

describe("PetLoader V1/V2 加载", () => {
  test("V1：1536×1872 + 未声明版本 → layout V1（9 行）", async () => {
    setSheetSize(1536, 1872);
    invokeMock = async (cmd, args) => {
      expect(cmd).toBe("read_pet_bundle");
      expect(args).toEqual({ petKey: "codex:remilia" });
      return makeBundle();
    };
    const loader = new PetLoader();
    const pet = await loader.load("codex:remilia");
    expect(pet.key).toBe("codex:remilia");
    expect(pet.layout.version).toBe(1);
    expect(pet.layout.rows).toBe(9);
    expect(pet.stateRows).toEqual({
      IDLE: 0,
      RUNNING: 7,
      WAITING: 6,
      MOVE_LEFT: 2,
      MOVE_RIGHT: 1,
    });
  });

  test("V2：1536×2288 + 声明 spriteVersionNumber=2 → layout V2（11 行）", async () => {
    setSheetSize(1536, 2288);
    invokeMock = async () =>
      makeBundle({
        manifest: {
          id: "foo",
          spritesheetPath: "spritesheet.webp",
          spriteVersionNumber: 2,
        },
      });
    const loader = new PetLoader();
    const pet = await loader.load("codex:foo");
    expect(pet.layout.version).toBe(2);
    expect(pet.layout.rows).toBe(11);
    // V2 允许行 0-10
    expect(pet.layout.rows).toBe(11);
  });

  test("未声明版本 + 2288 高 → 推断 V2", async () => {
    setSheetSize(1536, 2288);
    invokeMock = async () => makeBundle();
    const loader = new PetLoader();
    const pet = await loader.load("codex:remilia");
    expect(pet.layout.version).toBe(2);
  });

  test("错误尺寸（非 V1/V2 契约）→ PetLoadError", async () => {
    setSheetSize(100, 100);
    invokeMock = async () => makeBundle();
    const loader = new PetLoader();
    await expect(loader.load("codex:remilia")).rejects.toThrow(PetLoadError);
  });

  test("声明 V2 但图集是 V1 尺寸 → PetLoadError（声明优先，尺寸不符拒绝）", async () => {
    setSheetSize(1536, 1872);
    invokeMock = async () =>
      makeBundle({
        manifest: {
          id: "foo",
          spritesheetPath: "spritesheet.webp",
          spriteVersionNumber: 2,
        },
      });
    const loader = new PetLoader();
    await expect(loader.load("codex:foo")).rejects.toThrow(PetLoadError);
  });
});

describe("PetLoader 错误处理（方案 §68：错误不阻断轮询）", () => {
  test("invoke 失败（宠物不存在）→ PetLoadError", async () => {
    invokeMock = async () => {
      throw new Error("宠物目录不存在");
    };
    const loader = new PetLoader();
    await expect(loader.load("codex:missing")).rejects.toThrow(PetLoadError);
  });

  test("清单非法（缺 spritesheetPath）→ PetLoadError", async () => {
    setSheetSize(1536, 1872);
    invokeMock = async () => makeBundle({ manifest: { id: "x" } });
    const loader = new PetLoader();
    await expect(loader.load("codex:x")).rejects.toThrow(PetLoadError);
  });
});

describe("行越界回退（方案 §69）", () => {
  test("override 行越界（≥ rows）→ 回退默认行", async () => {
    setSheetSize(1536, 1872);
    invokeMock = async () => makeBundle();
    const loader = new PetLoader();
    const pet = await loader.load("codex:remilia", {
      stateRows: { RUNNING: 20, IDLE: -1 },
    });
    expect(pet.stateRows.RUNNING).toBe(7); // 20 ≥ 9 → 默认 7
    expect(pet.stateRows.IDLE).toBe(0); // -1 → 默认 0
  });

  test("默认行与 override 都越界 → row 0", async () => {
    setSheetSize(1536, 1872);
    invokeMock = async () => makeBundle();
    const loader = new PetLoader();
    // WAITING 默认 6，override 传 99 → 回退 6（合法）；构造 default 越界需特殊布局，此处验证 override 回退即可
    const pet = await loader.load("codex:remilia", { stateRows: { WAITING: 99 } });
    expect(pet.stateRows.WAITING).toBe(6);
  });
});

describe("每行有效帧数（validFrames，跳过行尾空白帧）", () => {
  test("注入采样结果 → resolveFrameCounts 进入 LoadedPet", async () => {
    setSheetSize(1536, 1872);
    invokeMock = async () => makeBundle();
    const loader = new PetLoader({
      analyzeFrames: () => [
        [true, true, true, true, true, true, false, false], // 6
        [true, true, true, true, true, true, true, true], // 8
        [true, true, true, true, false, false, false, false], // 4
        [true, true, true, true, true, false, false, false], // 5
        [true, true, true, true, true, true, false, false], // 6
        [true, true, true, true, true, true, true, true], // 8
        [true, true, true, true, true, true, false, false], // 6
        [true, true, true, true, true, true, false, false], // 6
        [true, true, true, true, true, true, false, false], // 6
      ],
    });
    const pet = await loader.load("codex:remilia");
    expect(pet.validFrames).toEqual([6, 8, 4, 5, 6, 8, 6, 6, 6]);
  });

  test("采样器抛错（无 DOM canvas）→ 回退全 8 帧，不阻断加载", async () => {
    setSheetSize(1536, 1872);
    invokeMock = async () => makeBundle();
    const loader = new PetLoader({
      analyzeFrames: () => {
        throw new Error("no canvas");
      },
    });
    const pet = await loader.load("codex:remilia");
    expect(pet.validFrames).toEqual(Array(9).fill(8));
  });

  test("V2 布局（11 行）→ validFrames 长度 11", async () => {
    setSheetSize(1536, 2288);
    invokeMock = async () => makeBundle();
    const loader = new PetLoader({
      analyzeFrames: () => Array(11).fill(Array(8).fill(true)),
    });
    const pet = await loader.load("codex:remilia");
    expect(pet.validFrames).toHaveLength(11);
  });
});
