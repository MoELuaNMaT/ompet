/**
 * PetLoader（Architecture V2，方案 §41–§43）：按 PetKey 加载宠物包并校验。
 *
 * - 数据来自 Rust read_pet_bundle（manifest + spritesheet data URL，16 MiB 限制）；
 * - 尺寸校验：V1 = 1536×1872，V2 = 1536×2288；manifest 未声明版本按高度推断；
 *   其他尺寸 → PetLoadError（不得自动猜任意网格，方案 §43）；
 * - stateRows：DEFAULT_STATE_ROWS + config override（方案 §15）。
 */
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_STATE_ROWS,
  parseCodexPetManifest,
  resolveFrameCounts,
  resolveSpriteLayout,
  resolveStateRows,
  STATE_ROW_KEYS,
  type CodexPetManifest,
  type PetKey,
  type PetOverride,
  type SpriteLayout,
  type StateRowMap,
} from "../../../packages/shared/src/index.ts";
import { analyzeFrameEmptiness, type FrameAnalyzer } from "./frame-analyzer.ts";

export interface LoadedPet {
  key: PetKey;
  manifest: CodexPetManifest;
  layout: SpriteLayout;
  /** 已解码的 spritesheet（每次 pet load 只 decode 一次，方案 §67） */
  image: HTMLImageElement;
  /** 生效的状态行映射（default + override） */
  stateRows: StateRowMap;
  /**
   * 每行有效帧数（像素检测非空帧，跳过行尾空白帧；全空行回退 1）。
   * 与 layout.rows 等长；动画播放周期 = validFrames[行号]。
   */
  validFrames: number[];
}

export interface PetLoaderOptions {
  /** 帧非空检测注入（测试用；缺省真实像素采样） */
  analyzeFrames?: FrameAnalyzer;
}

export class PetLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PetLoadError";
  }
}

/** Rust read_pet_bundle 返回值 */
interface PetBundlePayload {
  manifest: unknown;
  spriteDataUrl: string;
}

export class PetLoader {
  private readonly analyzeFrames: FrameAnalyzer;

  constructor(options: PetLoaderOptions = {}) {
    this.analyzeFrames = options.analyzeFrames ?? analyzeFrameEmptiness;
  }

  /**
   * 加载宠物。失败（包缺失/清单非法/尺寸不符/超限）→ PetLoadError，
   * 由调用方捕获：不得影响轮询与窗口（方案 §68）。
   */
  async load(petKey: PetKey, override?: PetOverride): Promise<LoadedPet> {
    let bundle: PetBundlePayload;
    try {
      bundle = (await invoke("read_pet_bundle", { petKey })) as PetBundlePayload;
    } catch (err) {
      throw new PetLoadError(`读取宠物包失败：${String(err)}`);
    }

    let manifest: CodexPetManifest;
    try {
      manifest = parseCodexPetManifest(bundle.manifest);
    } catch (err) {
      throw new PetLoadError(`pet.json 校验失败：${err instanceof Error ? err.message : String(err)}`);
    }

    const image = new Image();
    image.src = bundle.spriteDataUrl;
    try {
      await image.decode();
    } catch {
      throw new PetLoadError("图集解码失败");
    }
    if (image.naturalWidth === 0 || image.naturalHeight === 0) {
      throw new PetLoadError("图集尺寸无效");
    }

    let layout: SpriteLayout;
    try {
      layout = resolveSpriteLayout(manifest, {
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    } catch (err) {
      throw new PetLoadError(
        err instanceof Error ? err.message : "图集尺寸与 Sprite 契约不符",
      );
    }

    // 行越界回退（方案 §69）：row 非法 → DEFAULT_STATE_ROWS[state]；
    // default 同样越界 → row 0。保证渲染期行号恒合法。
    const stateRows = resolveStateRows(override);
    for (const state of STATE_ROW_KEYS) {
      let row = stateRows[state];
      if (row < 0 || row >= layout.rows) row = DEFAULT_STATE_ROWS[state];
      if (row < 0 || row >= layout.rows) row = 0;
      stateRows[state] = row;
    }

    // 每行有效帧数（跳过行尾空白帧）：像素采样失败（异常环境/图集异常）
    // 回退整行 8 帧（现状行为），不阻断加载。
    let validFrames: number[];
    try {
      validFrames = resolveFrameCounts(this.analyzeFrames(image, layout));
    } catch {
      validFrames = Array(layout.rows).fill(layout.columns);
    }

    return {
      key: petKey,
      manifest,
      layout,
      image,
      stateRows,
      validFrames,
    };
  }
}
