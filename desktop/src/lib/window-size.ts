/** 默认窗口宽度（与 tauri.conf.json 保持一致）。 */
export const DEFAULT_WINDOW_WIDTH = 240;

/**
 * 选择前端布局使用的初始窗口宽度。
 *
 * Tauri 在 setup 阶段会先恢复持久化窗口尺寸；前端必须优先采用随后读取到的
 * 外部宽度，不能在首轮布局时用默认值覆盖恢复结果。
 */
export function resolveInitialWindowWidth(restoredWidth: number): number {
  return Number.isFinite(restoredWidth) && restoredWidth > 0
    ? Math.round(restoredWidth)
    : DEFAULT_WINDOW_WIDTH;
}

/**
 * 判断异步布局读取结果是否仍属于当前窗口状态。
 *
 * 气泡布局读取窗口外部位置/尺寸期间，用户可能已经完成一次缩放；
 * 旧读取结果必须丢弃，不能把旧宽度重新写回窗口。
 */
export function isCurrentWindowBoundsRequest(
  requestId: number,
  currentRequestId: number,
  requestedWidth: number,
  currentWidth: number,
): boolean {
  return requestId === currentRequestId && requestedWidth === currentWidth;
}
