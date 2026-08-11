/**
 * 运行时事实模型（Architecture V2，方案 §21–§25）：extension 只维护少量运行事实，
 * 业务状态统一由 deriveActivity() 纯函数推导，不做完整状态图。
 *
 * 保留 agent、turn、tool 三个活跃来源，是为了容忍事件顺序不完全一致：
 * 成本只是两个布尔值 + 一个小 Map，但能避免长工具或并行工具被误判为空闲。
 * internalBusyCount 覆盖 auto-retry / auto-compaction 等内部忙碌期（方案 §35）。
 * waiting 由两类事件产生：approval（工具审批）与 input（等待用户回复/选择，
 * 见 USER_INPUT_TOOLS）；deriveActivity 中 waiting 恒优先于 working。
 */
import { USER_INPUT_TOOLS } from "../../packages/shared/src/index.ts";
import type { Activity } from "../../packages/shared/src/index.ts";
import type { ActivityDetail } from "../../packages/shared/src/index.ts";

/**
 * 等待回复的原因（方案 §21/§23）：
 * - approval：工具审批（tool_approval_requested）；
 * - input：等待用户回复/选择（USER_INPUT_TOOLS 名单内的工具，如 ask）。
 * user_input / 对应结束事件清除。
 */
export interface Waiting {
  kind: "approval" | "input";
  label: string;
}

/** 运行事实（extension 内部唯一状态，方案 §21） */
export interface RuntimeFacts {
  agentActive: boolean;
  turnActive: boolean;
  /** toolCallId → toolName；支持长工具与并行工具 */
  activeTools: Map<string, string>;
  waiting: Waiting | null;
  /** OMP 内部忙碌（auto-retry/auto-compaction）计数：>0 即 working */
  internalBusyCount: number;
  /** 最近一次任何事件的时间（备用信息，不用于猜测回 idle） */
  lastActivityAt: number;
}

export function createFacts(): RuntimeFacts {
  return {
    agentActive: false,
    turnActive: false,
    activeTools: new Map(),
    waiting: null,
    internalBusyCount: 0,
    lastActivityAt: 0,
  };
}

/**
 * 由运行事实推导业务状态（方案 §24 唯一实现）：
 * waiting（审批/等待回复）优先于 working；agent/turn/tool/internal 任一活跃即 working；否则 idle。
 */
export function deriveActivity(facts: RuntimeFacts): Activity {
  if (facts.waiting !== null) return "waiting";
  if (
    facts.agentActive ||
    facts.turnActive ||
    facts.activeTools.size > 0 ||
    facts.internalBusyCount > 0
  ) {
    return "working";
  }
  return "idle";
}

/** 由运行事实推导展示明细（方案 §25 优先级）：等待原因 > 最新工具 > internal > agent/turn > null */
export function deriveDetail(facts: RuntimeFacts): ActivityDetail | null {
  if (facts.waiting !== null) {
    // input（等待用户回复/选择）与 approval 都是 waiting，明细区分来源
    return {
      kind: facts.waiting.kind === "input" ? "input" : "approval",
      label: facts.waiting.label,
    };
  }
  if (facts.activeTools.size > 0) {
    // 取最后开始的工具（Map 插入序）；并行工具展示最近一个
    const last = [...facts.activeTools.values()].at(-1);
    return { kind: "tool", label: last ?? "tool" };
  }
  if (facts.internalBusyCount > 0) {
    return { kind: "internal", label: "内部处理中" };
  }
  if (facts.agentActive) {
    return { kind: "agent", label: "运行中" };
  }
  return null;
}

/**
 * 归一化后的扩展事件（方案 §22；index.ts 适配 omp 事件后喂给本函数，便于纯函数单测）。
 * 业务逻辑不得直接散落在 OMP Event Listener 中。
 */
export type FactsEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; willContinue?: boolean }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_end"; id: string }
  | { type: "approval_requested"; label?: string }
  | { type: "approval_resolved" }
  | { type: "user_input" }
  | { type: "internal_busy_start" }
  | { type: "internal_busy_end" };

/**
 * 事件 → 更新运行事实（方案 §23 严格规则）。
 * 纯函数：只改 facts，不写盘、不驱动 UI（副作用由调用方统一走 flush）。
 */
export function updateFacts(facts: RuntimeFacts, event: FactsEvent): void {
  switch (event.type) {
    case "agent_start":
      facts.agentActive = true;
      facts.lastActivityAt = Date.now();
      break;
    case "agent_end":
      // willContinue=true 表示 session 已调度自动续跑（auto-retry 等），不是真正收尾
      if (event.willContinue) break;
      // 生命周期收尾：清空所有活跃事实，避免遗留工具永久卡住（方案 §23）
      facts.agentActive = false;
      facts.turnActive = false;
      facts.activeTools.clear();
      facts.waiting = null;
      facts.lastActivityAt = Date.now();
      break;
    case "turn_start":
      facts.turnActive = true;
      facts.lastActivityAt = Date.now();
      break;
    case "turn_end":
      // 不再启动 30 秒猜测计时器；是否回 idle 由其他事实 + idleGrace 决定
      facts.turnActive = false;
      facts.lastActivityAt = Date.now();
      break;
    case "tool_start":
      facts.activeTools.set(event.id, event.name);
      // 等待用户回复/选择类工具（ask）：立即进入 waiting，优先于 working（方案 §23 扩展）
      if (USER_INPUT_TOOLS.includes(event.name)) {
        facts.waiting = { kind: "input", label: "等待回复" };
      }
      facts.lastActivityAt = Date.now();
      break;
    case "tool_end": {
      // 未知 id：忽略，不得 throw（方案 §23）
      const name = facts.activeTools.get(event.id);
      facts.activeTools.delete(event.id);
      // 等待输入工具结束（用户已回复/取消）→ 清除 input 等待；仍活跃的其他事实照常生效
      if (
        name !== undefined &&
        USER_INPUT_TOOLS.includes(name) &&
        facts.waiting?.kind === "input"
      ) {
        facts.waiting = null;
      }
      facts.lastActivityAt = Date.now();
      break;
    }
    case "approval_requested":
      // waiting 优先于 working（deriveActivity 中等待判断在最前）
      facts.waiting = { kind: "approval", label: event.label ?? "工具审批" };
      facts.lastActivityAt = Date.now();
      break;
    case "approval_resolved":
      // 仅当 waiting 为 approval 时清除（方案 §23）
      if (facts.waiting?.kind === "approval") facts.waiting = null;
      facts.lastActivityAt = Date.now();
      break;
    case "user_input":
      // 用户回复到达：清除 waiting，不得强制 activity = idle（方案 §23）
      facts.waiting = null;
      facts.lastActivityAt = Date.now();
      break;
    case "internal_busy_start":
      facts.internalBusyCount += 1;
      facts.lastActivityAt = Date.now();
      break;
    case "internal_busy_end":
      // 计数不允许低于 0（方案 §23）
      facts.internalBusyCount = Math.max(0, facts.internalBusyCount - 1);
      facts.lastActivityAt = Date.now();
      break;
  }
}
