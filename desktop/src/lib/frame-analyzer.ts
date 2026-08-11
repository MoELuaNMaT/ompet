/**
 * FrameAnalyzer：对已解码图集做像素采样，判定每帧格子是否为空（纯透明）。
 *
 * - 采样步长 4px：每帧 192×208 → 48×52 ≈ 2500 点，全图 72 格一次遍历；
 * - 非空判定：不透明（alpha > FRAME_ALPHA_OPAQUE_THRESHOLD）像素占比
 *   > FRAME_NONEMPTY_RATIO_THRESHOLD（实测空白 0.0% vs 非空 38%+，余量大）；
 * - 返回 nonEmptyFlags[row][frame]（true = 有内容），供 resolveFrameCounts 求每行有效帧数；
 * - 依赖 DOM canvas（真实 WebView 环境）；bun 测试环境无 DOM，由 PetLoader
 *   注入 fake 实现（PetLoaderOptions.analyzeFrames）。
 */
import type { SpriteLayout } from "../../../packages/shared/src/index.ts";
import {
  FRAME_ALPHA_OPAQUE_THRESHOLD,
  FRAME_NONEMPTY_RATIO_THRESHOLD,
} from "../../../packages/shared/src/index.ts";

/** 图集 → 每帧非空标记矩阵（row × frame） */
export type FrameAnalyzer = (image: HTMLImageElement, layout: SpriteLayout) => boolean[][];

export function analyzeFrameEmptiness(
  image: HTMLImageElement,
  layout: SpriteLayout,
  sampleStep = 4,
): boolean[][] {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("无法获取 canvas 2d 上下文");
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

  const { frameWidth, frameHeight, columns, rows } = layout;
  const flags: boolean[][] = [];
  for (let row = 0; row < rows; row++) {
    const rowFlags: boolean[] = [];
    for (let col = 0; col < columns; col++) {
      let opaque = 0;
      let total = 0;
      for (let y = row * frameHeight; y < (row + 1) * frameHeight; y += sampleStep) {
        for (let x = col * frameWidth; x < (col + 1) * frameWidth; x += sampleStep) {
          total++;
          if (data[(y * canvas.width + x) * 4 + 3] > FRAME_ALPHA_OPAQUE_THRESHOLD) {
            opaque++;
          }
        }
      }
      rowFlags.push(opaque / total > FRAME_NONEMPTY_RATIO_THRESHOLD);
    }
    flags.push(rowFlags);
  }
  return flags;
}
