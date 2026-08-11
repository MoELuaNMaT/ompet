/**
 * 本地移动控制器（方案 6.1/7.5）：维护 MotionState（none/left/right）。
 *
 * - 拖拽是移动触发源（决策 A：拖拽即移动）：pointermove 增量喂给 updateDrag，
 *   方向切换需跨过 movementDirectionHysteresisPx（8px）避免左右抖动；
 * - 业务状态转 working/waiting 时调用 cancel() 立即取消移动（方案 6.2）；
 * - 到达目标/取消后回到 none（自动 targetX 移动留二期，接口已预留 startMove）。
 */
import { PET_CONFIG, type Motion } from "../../../packages/shared/src/index.ts";

export interface MotionState {
  mode: Motion;
  /** 目标 x（自动移动二期用；拖拽模式为 null） */
  targetX: number | null;
  /** 进入当前移动方向的时刻 */
  startedAt: number;
}

export class MovementController {
  private state: MotionState = { mode: "none", targetX: null, startedAt: 0 };

  get motion(): Motion {
    return this.state.mode;
  }

  /** 拖拽方向增量（px，正=右）→ 更新移动状态；未跨过滞回阈值不切换 */
  updateDrag(deltaX: number, nowMs: number): void {
    const hysteresis = PET_CONFIG.movementDirectionHysteresisPx;
    let next: Motion = this.state.mode;
    if (deltaX <= -hysteresis) next = "left";
    else if (deltaX >= hysteresis) next = "right";
    if (next === this.state.mode) return;
    this.state = { mode: next, targetX: null, startedAt: nowMs };
  }

  /** 拖拽结束：回到 none（二期自动移动时改为"继续滑向 targetX"） */
  endDrag(): void {
    if (this.state.mode !== "none") {
      this.state = { mode: "none", targetX: null, startedAt: 0 };
    }
  }

  /** 取消移动（业务状态转 working/waiting 时调用，方案 6.2） */
  cancel(): void {
    if (this.state.mode !== "none") {
      this.state = { mode: "none", targetX: null, startedAt: 0 };
    }
  }
}
