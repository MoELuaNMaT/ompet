/**
 * 业务状态（OMPet Architecture V2，方案 §3.1）。
 *
 * 唯一权威来源：extension（deriveActivity 推导）。
 * 表达 OMP 终端当前是否空闲、工作或明确等待用户交互。
 */
export type Activity = "idle" | "working" | "waiting";

/** 全部业务状态（顺序固定，用于遍历/校验） */
export const ACTIVITIES: readonly Activity[] = [
  "idle",
  "working",
  "waiting",
] as const;

/**
 * 需要用户回复/选择才算 waiting 的工具名单（方案 §23 扩展）：
 * OMP 的 ask 工具（Ask the user a clarifying question）不触发审批事件，
 * 只产生 tool_execution_start/end；extension 据此把"等待用户选择"识别为
 * waiting（kind=input）。OMP 框架自身也以 toolName==="ask" 判定 question_asked。
 * 扩展端唯一消费；集中在此便于测试与增删。
 */
export const USER_INPUT_TOOLS: readonly string[] = ["ask"] as const;
