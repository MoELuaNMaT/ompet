/**
 * 气泡外观状态同步：形态类与业务状态类分别维护，避免每轮 poll 重写 className
 * 重新启动左侧 b-icon 的 CSS 动画。
 */
import type { BubbleStatus } from "./bubbles.ts";

export type BubbleShape = "orb" | "capsule";

/** DOMTokenList 的最小接口，便于在不依赖 DOM 的单测中验证同步语义。 */
export interface BubbleClassList {
  add(...names: string[]): void;
  remove(...names: string[]): void;
  toggle(name: string, force?: boolean): boolean;
  contains(name: string): boolean;
}

const SHAPE_CLASSES: readonly BubbleShape[] = ["orb", "capsule"];
const STATUS_CLASSES: readonly BubbleStatus[] = ["working", "waiting", "done", "idle"];

/**
 * 将气泡同步到指定形态与状态。
 * 同一状态已存在时不重新 add 状态类，从而保持 b-icon 当前 CSS animation 时间线。
 */
export function syncBubbleAppearance(
  classList: BubbleClassList,
  shape: BubbleShape,
  status: BubbleStatus,
): void {
  for (const shapeClass of SHAPE_CLASSES) {
    classList.toggle(shapeClass, shapeClass === shape);
  }

  const nextStatusClass = `s-${status}`;
  for (const statusValue of STATUS_CLASSES) {
    const statusClass = `s-${statusValue}`;
    if (statusClass !== nextStatusClass) classList.remove(statusClass);
  }
  if (!classList.contains(nextStatusClass)) classList.add(nextStatusClass);
}
