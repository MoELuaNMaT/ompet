/**
 * 可见动画状态与合成函数（OMPet Architecture V2，方案 §3.3）。
 *
 * 两层状态（Activity × Motion）合成唯一可见动画状态：
 * - 业务状态（idle/working/waiting）由 extension 推导；
 * - 移动状态（none/left/right）由 Desktop 本地 MovementController 产生，
 *   不进入 Snapshot、不写磁盘、不由 extension 感知。
 *
 * 优先级固定：waiting > working > left > right > idle。
 * 禁止在 shared 之外重复实现该优先级（方案 §3.3 / §61）。
 */
import type { Activity } from "./activity.ts";

/** 桌面本地移动状态（方案 §3.2） */
export type Motion = "none" | "left" | "right";

/** 可见动画状态：五种正式状态（方案 §1 / §3.3） */
export type VisiblePetState =
  | "IDLE"
  | "RUNNING"
  | "WAITING"
  | "MOVE_LEFT"
  | "MOVE_RIGHT";

/** 五种正式可见状态（顺序固定，用于遍历/校验） */
export const VISIBLE_PET_STATES: readonly VisiblePetState[] = [
  "IDLE",
  "RUNNING",
  "WAITING",
  "MOVE_LEFT",
  "MOVE_RIGHT",
] as const;

/**
 * 合成最终可见动画状态（方案 §3.3 唯一实现）。
 * 业务状态一旦为 working/waiting，移动立即让位。
 */
export function resolveVisibleState(
  activity: Activity,
  motion: Motion,
): VisiblePetState {
  if (activity === "waiting") return "WAITING";
  if (activity === "working") return "RUNNING";
  if (motion === "left") return "MOVE_LEFT";
  if (motion === "right") return "MOVE_RIGHT";
  return "IDLE";
}
