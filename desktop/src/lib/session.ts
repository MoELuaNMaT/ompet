/**
 * session 快照解析与选择（Architecture V2，方案 §27 / §38）：纯函数，可单测。
 *
 * - 损坏/格式不符的快照返回 null（跳过本轮，不崩溃不清动画）；
 * - 兼容读取 V1（schemaVersion=1，含 petId/stateSince/closed）与 V2
 *   （schemaVersion=2，petId 移入 global config；closed 用删除文件表达）；
 * - stale 判定：closed（仅 V1）或 heartbeat 超过 staleAfterMs；
 * - 多 session 选择：heartbeat 有效、updatedAt 最新的 session；
 *   当前 session 仍有效时保持粘性，不按状态优先级跨 session 抢占。
 */
import { isSessionTerminalTitle, PET_CONFIG } from "../../../packages/shared/src/index.ts";
import type { Activity } from "../../../packages/shared/src/index.ts";

/** 快照（V1/V2 统一视图；V2 无 petId/stateSince/closed） */
export interface Snapshot {
  schemaVersion: 1 | 2;
  sessionId: string;
  cwd: string;
  activity: Activity;
  detail: { kind: string; label?: string } | null;
  revision: number;
  updatedAt: number;
  heartbeatAt: number;
  producerPid: number;
  /** V2 可选字段；旧快照缺失时由聚焦链路回退到项目名。 */
  terminalTitle?: string;
  /** 仅 V1 快照存在（迁移期）；V2 的宠物来自 global config */
  petId?: string;
  /** 仅 V1 快照存在（迁移期）；V2 用删除文件表达关闭 */
  closed?: boolean;
}

/** 解析快照内容（V1/V2）；损坏/缺字段返回 null（跳过本轮保留当前画面） */
export function parseSnapshot(content: string | null | undefined): Snapshot | null {
  if (!content) return null;
  try {
    const s = JSON.parse(content) as Partial<Snapshot>;
    if (
      (s.schemaVersion !== 1 && s.schemaVersion !== 2) ||
      typeof s.sessionId !== "string" ||
      typeof s.activity !== "string" ||
      typeof s.revision !== "number"
    ) {
      return null;
    }
    const snapshot: Snapshot = {
      schemaVersion: s.schemaVersion,
      sessionId: s.sessionId,
      cwd: typeof s.cwd === "string" ? s.cwd : "",
      activity: s.activity as Activity,
      detail: s.detail ?? null,
      revision: s.revision,
      updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : 0,
      heartbeatAt: typeof s.heartbeatAt === "number" ? s.heartbeatAt : 0,
      producerPid: typeof s.producerPid === "number" ? s.producerPid : 0,
    };
    if (typeof s.terminalTitle === "string" && isSessionTerminalTitle(s.terminalTitle)) {
      snapshot.terminalTitle = s.terminalTitle;
    }
    if (typeof s.petId === "string") snapshot.petId = s.petId;
    if (typeof s.closed === "boolean") snapshot.closed = s.closed;
    return snapshot;
  } catch {
    return null;
  }
}

/** 无效快照：closed（仅 V1 生命周期标记）或 heartbeat 超时（生产者崩溃/退出） */
export function isInvalid(snapshot: Snapshot, nowMs: number): boolean {
  return snapshot.closed === true || nowMs - snapshot.heartbeatAt > PET_CONFIG.staleAfterMs;
}

/**
 * 选择当前展示的 session（方案第 9 节单一规则）。
 * @param snapshots 已解析的有效快照（不含损坏项）
 * @param current 当前展示的快照（粘性锚点）
 * @returns 选中的快照；无有效快照返回 null（desktop 回本地 idle）
 */
export function selectSession(
  snapshots: Snapshot[],
  current: Snapshot | null,
  nowMs: number,
): Snapshot | null {
  const valid = snapshots.filter((s) => !isInvalid(s, nowMs));
  if (valid.length === 0) return null;
  // 粘性：当前 session 仍有效则保持（哪怕别的 session updatedAt 更新）
  if (current) {
    const same = valid.find((s) => s.sessionId === current.sessionId);
    if (same) return same;
  }
  // 否则选最近活动（updatedAt 最新）
  return valid.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b));
}

/** 从快照文件名反解 sessionId（writer 用 encodeURIComponent(sessionId).json 命名） */
export function decodeSnapshotId(file: string): string {
  try {
    return decodeURIComponent(file.replace(/\.json$/, ""));
  } catch {
    return file;
  }
}

/**
 * 桌面端跟随 omp 生命周期的自动退出判定（项目设计）：
 * 所有 session 均无效（closed/stale/不存在）持续超过 desktopNoSessionExitMs 后返回 true。
 * 由轮询层记录"无有效 session 起始时刻"并调用本函数；恢复有效 session 时重置计时。
 */
export function shouldExitDesktop(
  noValidSinceMs: number | null,
  nowMs: number,
): boolean {
  return noValidSinceMs !== null && nowMs - noValidSinceMs >= PET_CONFIG.desktopNoSessionExitMs;
}
