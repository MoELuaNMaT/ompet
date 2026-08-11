/**
 * 窗口缩放纯函数（Architecture V2 宠物尺寸可调）：
 * 锁定帧比例 192:208（与 SpriteLayout 帧尺寸一致），右下角为锚点，
 * 宽度 = 鼠标到锚点的水平距离（远离锚点放大、靠近缩小）；最小/最大宽度约束。
 * 不依赖 DOM / Tauri API，便于单测。
 */

/** 帧宽高比（高/宽 = 208/192）：height = width × FRAME_ASPECT_RATIO */
export const FRAME_ASPECT_RATIO = 208 / 192;

/** 最小窗口宽度（px）：动画仍清晰、缩放手柄可点；高度 = 120 × 208/192 = 130 */
export const MIN_WINDOW_WIDTH = 120;

/** 默认最大宽度（monitor 信息不可用时的兜底） */
export const DEFAULT_MAX_WINDOW_WIDTH = 600;

/**
 * 由鼠标到右下角锚点的水平距离计算窗口宽度（clamp 到 [MIN_WINDOW_WIDTH, maxWidth]；
 * maxWidth 小于最小宽度时最小宽度优先）。
 */
export function clampScaleWidth(rawWidth: number, maxWidth: number): number {
  return Math.max(Math.min(Math.round(rawWidth), maxWidth), MIN_WINDOW_WIDTH);
}

/** 由宽度计算保持 192:208 比例的高度 */
export function scaleHeight(width: number): number {
  return Math.round(width * FRAME_ASPECT_RATIO);
}
