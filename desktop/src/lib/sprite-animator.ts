/**
 * SpriteAnimator（Architecture V2，方案 §45–§49）：Canvas 直绘 spritesheet 的动画播放器。
 *
 * - 不处理业务状态：只接收 VisiblePetState（resolveVisibleState 的输出）；
 * - 帧选择：fps=8（125ms/帧）、每行按有效帧数纯循环（validFrames 跳过行尾空白帧）；
 * - setState 同状态不重置 animationStartedAt（方案 §46）；
 * - 纯循环：无三遍回落、无 fallback、无超时（方案 §49）；
 * - 每帧只 drawImage 裁切，不生成中间 PNG（方案 §48 / §67）。
 */
import type { LoadedPet } from "./pet-loader.ts";
import type { VisiblePetState } from "../../../packages/shared/src/index.ts";
import { PET_CONFIG } from "../../../packages/shared/src/index.ts";

export class SpriteAnimator {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly clock: () => number;
  private pet: LoadedPet | null = null;
  private currentState: VisiblePetState | null = null;
  private animationStartedAt = 0;
  private frameIndex = 0;

  constructor(canvas: HTMLCanvasElement, clock: () => number = () => performance.now()) {
    this.canvas = canvas;
    this.clock = clock;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法获取 canvas 2d 上下文");
    this.ctx = ctx;
  }

  /** 更换宠物（或 null 清空画面）；重置帧计时 */
  setPet(pet: LoadedPet | null): void {
    this.pet = pet;
    this.currentState = null;
    this.frameIndex = 0;
    this.animationStartedAt = 0;
    this.render();
  }

  /** 切换可见状态（方案 §46：同状态直接返回，不重置计时） */
  setState(state: VisiblePetState): void {
    if (state === this.currentState) return;
    this.currentState = state;
    this.animationStartedAt = this.clock();
    this.frameIndex = 0;
    this.render();
  }

  /** 帧 tick（由 125ms 定时器驱动；帧序号变化才重绘）。
   *  每行有效帧数不同（validFrames，像素检测跳过行尾空白帧），
   *  播放周期 = validFrames[行号]；缺省回退 8（全行 8 帧） */
  tick(nowMs: number): void {
    if (!this.pet || this.currentState === null) return;
    const row = this.pet.stateRows[this.currentState];
    const frames = this.pet.validFrames[row] ?? 8;
    const frame = Math.floor((nowMs - this.animationStartedAt) / PET_CONFIG.animationTickMs) % frames;
    if (frame !== this.frameIndex) {
      this.frameIndex = frame;
      this.render();
    }
  }

  /** 渲染当前帧（drawImage 裁切，方案 §48） */
  render(): void {
    const { canvas, ctx } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!this.pet || this.currentState === null) return;
    const { layout, image, stateRows } = this.pet;
    const row = stateRows[this.currentState];
    const sx = this.frameIndex * layout.frameWidth;
    const sy = row * layout.frameHeight;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      image,
      sx,
      sy,
      layout.frameWidth,
      layout.frameHeight,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  }
}
