/**
 * OMPet Global Config 契约（OMPet Architecture V2，方案 §12–§17）。
 *
 * 路径：~/.omp/ompet/config.json
 * Global Config 是宠物选择与状态行映射的唯一权威；绝不允许把
 * activePet / state mapping / fps 写入 session snapshot（方案 §36）。
 */
import { VISIBLE_PET_STATES, type VisiblePetState } from "./visible-state.ts";

/** 状态 → 行 映射（方案 §12；state → row，允许多个状态共享同一行） */
export interface StateRowMap {
  IDLE: number;
  RUNNING: number;
  WAITING: number;
  MOVE_LEFT: number;
  MOVE_RIGHT: number;
}

/** 五个映射键（顺序固定；复用唯一的状态枚举定义） */
export const STATE_ROW_KEYS: readonly VisiblePetState[] = VISIBLE_PET_STATES;

/** 默认状态行映射（方案 §11 固定契约，不存在"待人工确认"状态） */
export const DEFAULT_STATE_ROWS: Readonly<StateRowMap> = {
  IDLE: 0,
  MOVE_RIGHT: 1,
  MOVE_LEFT: 2,
  WAITING: 6,
  RUNNING: 7,
};

/** 单只宠物的映射覆盖（方案 §14.1；本轮禁止 rowFrames / 复杂 AnimationSpec） */
export interface PetOverride {
  stateRows?: Partial<StateRowMap>;
  /** 整只宠物统一 FPS（可选；默认 8） */
  fps?: number;
}

/** 全局配置（方案 §14） */
export interface OMPetConfig {
  schemaVersion: 1;
  revision: number;
  enabled: boolean;
  activePet: `${string}:${string}` | null;
  petOverrides: Record<string, PetOverride>;
  migrationVersion: number;
}

/** 默认统一 FPS（方案 §14.1） */
export const DEFAULT_FPS = 8;

/** 创建内存默认配置（方案 §69：config 不存在时的 fallback） */
export function createDefaultConfig(): OMPetConfig {
  return {
    schemaVersion: 1,
    revision: 0,
    enabled: true,
    activePet: null,
    petOverrides: {},
    migrationVersion: 0,
  };
}

/**
 * 计算生效的状态行映射（方案 §15）：
 * DEFAULT_STATE_ROWS + override.stateRows = effective。
 * 禁止修改 default object（内部复制）。
 * 非法值（非数字）忽略；行是否越界由调用方按 layout 校验/回退。
 */
export function resolveStateRows(override?: PetOverride): StateRowMap {
  const rows: StateRowMap = { ...DEFAULT_STATE_ROWS };
  const partial = override?.stateRows;
  if (partial) {
    for (const key of STATE_ROW_KEYS) {
      const value = partial[key];
      if (typeof value === "number") rows[key] = value;
    }
  }
  return rows;
}

/**
 * 全局运行参数（OMPet Architecture V2 方案 §30 / §67 等）。
 * extension 与 desktop 共用，不散落写死。
 */
export const PET_CONFIG = {
  /** desktop 轮询 read_runtime_state 间隔（ms） */
  desktopPollIntervalMs: 500,
  /** 动画帧 tick（ms）= 8fps */
  animationTickMs: 125,
  /** 业务状态转 idle 的防抖窗口（ms） */
  idleGraceMs: 750,
  /** extension heartbeat 间隔（ms）：存活证明，不影响动画 */
  heartbeatIntervalMs: 5_000,
  /** heartbeat 超过此时长视为 stale（ms），不参与 session selection */
  staleAfterMs: 15_000,
  /** stale 快照真正删除的时长（ms）：仅 desktop 启动清理时使用 */
  staleCleanupAfterMs: 24 * 60 * 60 * 1000,
  /** 移动到达判定阈值（px） */
  movementStopThresholdPx: 4,
  /** 移动方向切换滞回（px） */
  movementDirectionHysteresisPx: 8,
  /** 桌面端在所有 session 均无效后自动退出的等待时长（ms） */
  desktopNoSessionExitMs: 60_000,
} as const;
