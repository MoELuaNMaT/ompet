/**
 * 多会话气泡纯逻辑（Multi-Session Bubbles）：聚合状态 + 单气泡显示状态。
 * 无 DOM / Tauri API 依赖，便于单测。
 *
 * - aggregateActivity：多会话 → 宠物本体动画状态（waiting > working > idle）；
 * - bubbleStatus：单会话显示状态（working/waiting 原样；idle 且 doneAt 在窗口期内 → done，
 *   否则 idle）。doneAt 由调用方在检测到 working/waiting→idle 切换时记录。
 */
import type { Activity } from "../../../packages/shared/src/index.ts";

/** 气泡显示状态：运行中 / 等待回复 / 任务完成（瞬时高亮）/ 待机 */
export type BubbleStatus = "working" | "waiting" | "done" | "idle";

/** working/waiting→idle 切换后「任务完成」高亮时长 */
export const DONE_DURATION_MS = 4000;

export const STATUS_LABEL: Record<BubbleStatus, string> = {
  working: "运行中",
  waiting: "等待回复",
  done: "任务完成",
  idle: "待机中",
};

/** 聚合多会话为宠物本体动画状态：任一 waiting → waiting；任一 working → working；否则 idle */
export function aggregateActivity(activities: Activity[]): Activity {
  if (activities.some((a) => a === "waiting")) return "waiting";
  if (activities.some((a) => a === "working")) return "working";
  return "idle";
}

/**
/** 单气泡显示状态：working/waiting 原样；idle 时若 doneAt 非空且在
 * DONE_DURATION_MS 窗口期内显示 done（任务完成高亮），否则 idle。
 */
export function bubbleStatus(
  activity: Activity,
  doneAt: number | null,
  now: number,
): BubbleStatus {
  if (activity === "working") return "working";
  if (activity === "waiting") return "waiting";
  if (doneAt !== null && now - doneAt < DONE_DURATION_MS) return "done";
  return "idle";
}

/** 二维点（三角形判定用） */
export interface Point {
  x: number;
  y: number;
}

/**
 * 点是否在三角形内（含边界，叉积同号法）。
 * 用于气泡展开判定：以缩略气泡中心为顶点、展开气泡两端为底边构成三角形，
 * 鼠标在该三角形区域内（含两者之间的过渡带）时气泡保持展开。
 */
export function pointInTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  const sign = (p1: Point, p2: Point, p3: Point): number =>
    (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * 点是否在矩形内（含边界，可向外扩展 pad 像素的容差带）。
 * 用于气泡展开热区判定：slot / 展开 bubble 矩形命中（pad 吸收边缘抖动）。
 */
export function pointInRect(
  p: Point,
  rect: { x: number; y: number; width: number; height: number },
  pad = 0,
): boolean {
  return (
    p.x >= rect.x - pad &&
    p.x <= rect.x + rect.width + pad &&
    p.y >= rect.y - pad &&
    p.y <= rect.y + rect.height + pad
  );
}

/** 矩形（DOMRect 的纯数据视图，便于注入测试） */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 点是否在气泡展开热区内（三者并集，不依赖动画阶段）：
 * ① slot 矩形（含 slotPad 容差）——hover 起点/下移早期鼠标仍在触发点，稳定保持；
 *    slotPad 取较大值（24px）：覆盖相邻 slot 间距与「缓慢移动+手抖」的自然活动范围，
 *    避免鼠标在 slot 边缘反复跨越热区边界造成展开-收回往返抖动；
 * ② 展开气泡实时视觉矩形（含 pad 容差）——用气泡自身 bbox 而非整行容器：
 *    既消除「行内空白误保持」（容器矩形远大于气泡视觉范围），
 *    也消除「胶囊溢出部分自缩」（bbox 天然包含 morph 宽度过渡与溢出部分）；
 * ③ slot 中心 → 预留行底边的三角形——覆盖 slot 与预留行之间的过渡带/间隙，
 *    底边保留整行，保证「鼠标提前下移到展开位置等待」时稳定命中。
 */
export function pointInExpandZone(
  p: Point,
  slot: Rect,
  bubble: Rect,
  expanded: Rect,
  pad: number,
  slotPad = pad,
): boolean {
  // ① 鼠标在 slot 矩形内（含 slotPad 容差）→ 下移早期鼠标仍在触发点，稳定保持
  if (pointInRect(p, slot, slotPad)) return true;
  // ② 鼠标在展开气泡实时视觉矩形内（含 pad 容差）→ 动画各阶段/溢出部分稳定命中
  if (pointInRect(p, bubble, pad)) return true;
  // ③ 鼠标在 slot 中心→预留行底边的三角形内 → 覆盖过渡带/间隙
  return pointInTriangle(
    p,
    { x: slot.x + slot.width / 2, y: slot.y + slot.height / 2 }, // 顶点：缩略气泡中心
    { x: expanded.x, y: expanded.y + expanded.height },         // 底边左端：预留行左下
    { x: expanded.x + expanded.width, y: expanded.y + expanded.height }, // 底边右端：预留行右下
  );
}
