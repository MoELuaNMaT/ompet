/**
 * Session Snapshot V2 协议（OMPet Architecture V2，方案 §27）。
 *
 * 路径：~/.omp/ompet/run/<encodedSessionId>.json
 * 只负责同步"当前 OMP session 在做什么"；petId 属于 global config，
 * stateSince 当前产品不消费，closed 用删除快照文件表达。
 */
import type { Activity } from "./activity.ts";

/** 会话级终端标题中用于区分 OMP session 的固定标记。 */
export const TERMINAL_TITLE_MARKER = " [ompet:";

/** 判断标题是否符合 OMPet 当前的会话级标题格式。 */
export function isSessionTerminalTitle(title: string): boolean {
  const markerAt = title.indexOf(TERMINAL_TITLE_MARKER);
  const sessionId = title.slice(markerAt + TERMINAL_TITLE_MARKER.length, -1);
  return markerAt >= 0 && title.endsWith("]") && sessionId.length > 0;
}

/** 展示明细（方案 §25；不是业务状态，变化允许 revision++ 但不得重启动画） */
export interface ActivityDetail {
  kind: "tool" | "approval" | "input" | "agent" | "internal";
  label?: string;
}

/** Session 快照 V2（方案 §27） */
export interface SessionSnapshot {
  schemaVersion: 2;
  sessionId: string;
  cwd: string;
  activity: Activity;
  detail: ActivityDetail | null;
  revision: number;
  updatedAt: number;
  heartbeatAt: number;
  producerPid: number;
  /** 可选的会话级终端标题；旧快照缺失该字段时由 desktop 回退到项目名。 */
  terminalTitle?: string;
}
