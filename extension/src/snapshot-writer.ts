/**
 * Session Snapshot V2 写入器（Architecture V2，方案 §27–§33）。
 *
 * 路径：~/.omp/ompet/run/<encodedSessionId>.json（不再写 ~/.omp/run/pets/）
 * 只同步"当前 OMP session 在做什么"；petId 属于 global config，
 * stateSince 不消费，closed 用删除快照文件表达（方案 §27 / §31）。
 *
 * - 语义变化（activity/detail）→ revision++、updatedAt=now、heartbeatAt=now、写盘；
 *   完全相同 → 不得写（方案 §29）；
 * - heartbeat 只更新 heartbeatAt，不 revision++、不动 updatedAt（方案 §30）；
 * - 原子写：tmp + rename（方案 §32）；
 * - 写失败：记录 warning，不得 throw 到 OMP 主会话（方案 §68）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  isSessionTerminalTitle,
  TERMINAL_TITLE_MARKER,
  type Activity,
  type ActivityDetail,
  type SessionSnapshot,
} from "../../packages/shared/src/index.ts";

/** 写入上下文（sessionId 动态派生；session 切换自动落到新文件） */
export interface SnapshotContext {
  sessionId: string;
  cwd: string;
  pid: number;
}

/**
 * 生成会话级唯一终端标题。
 * 项目名负责可读性，sessionId 负责区分同项目的多个 omp 会话。
 */
export function terminalTitleFor(cwd: string, sessionId: string): string {
  const project = (cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd) || cwd;
  const id = sessionId.trim();
  return id ? `${project}${TERMINAL_TITLE_MARKER}${id}]` : project;
}

/** 默认快照目录：~/.omp/ompet/run/<encodedSessionId>.json */
export function snapshotPath(sessionId: string): string {
  return path.join(
    process.env.USERPROFILE ?? process.env.HOME ?? ".",
    ".omp",
    "ompet",
    "run",
    // sessionId 可能含路径分隔符等字符，文件名安全编码（desktop 以内容 sessionId 为准）
    `${encodeURIComponent(sessionId)}.json`,
  );
}

function emptySnapshot(ctx: SnapshotContext): SessionSnapshot {
  const now = Date.now();
  return {
    schemaVersion: 2,
    sessionId: ctx.sessionId,
    cwd: ctx.cwd,
    activity: "idle",
    detail: null,
    revision: 0,
    updatedAt: now,
    heartbeatAt: now,
    producerPid: ctx.pid,
    terminalTitle: terminalTitleFor(ctx.cwd, ctx.sessionId),
  };
}

/**
 * 每 session 一份快照的写入器。进程内只维护"最新快照"，不追加历史。
 * 同步写 + 原子 rename；写盘失败不阻断会话（只影响桌面端显示）。
 */
export class SnapshotWriter {
  private ctx: () => SnapshotContext;
  /** 测试/定制路径覆盖；缺省用 snapshotPath(sessionId) */
  private fileOverride: string | null;
  /** 内存中的最新快照（重建 revision 用） */
  private cur: SessionSnapshot;
  /** 去重 key：activity|detailJSON */
  private curKey = "";
  /** 上次心跳时刻（节流：heartbeat 间隔由调用方控制，这里防重复写） */
  private lastHeartbeatAt = 0;

  constructor(ctx: () => SnapshotContext, fileOverride?: string) {
    this.ctx = ctx;
    this.fileOverride = fileOverride ?? null;
    this.cur = this.readExisting(ctx()) ?? emptySnapshot(ctx());
  }

  /** 当前快照（测试/调试用） */
  get current(): SessionSnapshot {
    return this.cur;
  }

  /**
   * 开始/恢复 session（方案 §28）：初始化快照。
   * 幂等：同 session 进程重启时续用 revision（desktop 去重不跳变）；
   * sessionId 变化时从零开始。
   */
  startSession(input: { sessionId: string; cwd: string; producerPid: number }): void {
    const ctx: SnapshotContext = {
      sessionId: input.sessionId,
      cwd: input.cwd,
      pid: input.producerPid,
    };
    if (this.cur.sessionId !== input.sessionId) {
      this.cur = this.readExisting(ctx) ?? emptySnapshot(ctx);
      this.curKey = "";
      // 新 session 不应继承上一个 session 的 heartbeat 节流时间。
      this.lastHeartbeatAt = 0;
    }
  }

  /** 发布语义状态（方案 §29 去重）；无变化不写 */
  publish(activity: Activity, detail: ActivityDetail | null = null): void {
    const ctx = this.ctx();
    this.startSession({ sessionId: ctx.sessionId, cwd: ctx.cwd, producerPid: ctx.pid });
    // 终端标题跟随会话唯一标识，desktop 依此精确切换 Windows Terminal 标签。
    const terminalTitle = SnapshotWriter.syncTerminalTitle(ctx.cwd, ctx.sessionId);
    const detailKey = detail ? JSON.stringify(detail) : "";
    const key = `${activity}|${detailKey}`;
    if (key === this.curKey) return;
    this.curKey = key;
    const now = Date.now();
    const next: SessionSnapshot = {
      ...this.cur,
      sessionId: this.ctx().sessionId,
      cwd: this.ctx().cwd,
      producerPid: this.ctx().pid,
      activity,
      detail: detail ? { ...detail } : null,
      revision: this.cur.revision + 1,
      updatedAt: now,
      heartbeatAt: now,
      terminalTitle,
    };
    this.writeAtomic(next);
    this.cur = next;
  }

  /** 心跳（方案 §30）：只刷 heartbeatAt，不增加 revision、不动 updatedAt */
  heartbeat(): void {
    const ctx = this.ctx();
    this.startSession({ sessionId: ctx.sessionId, cwd: ctx.cwd, producerPid: ctx.pid });
    const now = Date.now();
    if (now - this.lastHeartbeatAt < 500) return; // 节流（调用方每 5s 调一次，双保险）
    this.lastHeartbeatAt = now;
    // 每 5s 刷新标题：防 omp/TUI 覆盖标题后 desktop 匹配失效。
    const terminalTitle = SnapshotWriter.syncTerminalTitle(ctx.cwd, ctx.sessionId);
    const next = { ...this.cur, terminalTitle, heartbeatAt: now };
    this.writeAtomic(next);
    this.cur = next;
  }

  /**
   * 会话结束（方案 §31）：删除自身快照文件（不写 closed）。
   * 删除失败仅 warning，不得影响 OMP shutdown。
   */
  close(): void {
    this.curKey = "";
    try {
      fs.rmSync(this.file(), { force: true });
    } catch (err) {
      console.warn("[ompet] 删除快照失败（不影响会话）：", err);
    }
  }

  /** 快照文件路径（默认随 ctx 的 sessionId 派生；构造时可注入覆盖） */
  private file(): string {
    return this.fileOverride ?? snapshotPath(this.ctx().sessionId);
  }

  /**
   * 终端标题同步（解决多终端窗口聚焦错位，方案见 decisions V2-26）：
   * Windows Terminal 标签标题默认不含可区分会话的信息，desktop 只按项目名匹配时，
   * 同项目会话无法区分，匹配失败还可能误开最后一个终端。
   * 这里把 omp 所在控制台的标题设为会话唯一标题（process.title → SetConsoleTitleW），
   * WT 标签标题跟随 → desktop 能精确匹配目标窗口+标签。
   * 不写 stdout（不污染 TUI 渲染）；失败静默（标题只是辅助，不影响快照）。
   */
  static syncTerminalTitle(cwd: string, sessionId: string): string {
    const title = terminalTitleFor(cwd, sessionId);
    try {
      process.title = title;
    } catch {
      // 无控制台/不支持的环境静默跳过
    }
    return title;
  }

  /** 原子写：tmp + flush + rename 覆盖（方案 §32） */
  private writeAtomic(next: SessionSnapshot): void {
    try {
      const file = this.file();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
      fs.renameSync(tmp, file);
    } catch (err) {
      // 快照写盘失败不阻断会话（只影响桌面端显示）
      console.warn("[ompet] 快照写盘失败（不影响会话）：", err);
    }
  }

  /** 恢复既有快照（同 session 进程重启时续用 revision，desktop 去重不跳变） */
  private readExisting(ctx: SnapshotContext): SessionSnapshot | null {
    try {
      const raw = fs.readFileSync(this.file(), "utf8");
      const parsed = JSON.parse(raw) as Partial<SessionSnapshot>;
      if (
        parsed.schemaVersion === 2 &&
        parsed.sessionId === ctx.sessionId &&
        typeof parsed.revision === "number"
      ) {
        const defaults = emptySnapshot(ctx);
        return {
          ...defaults,
          ...parsed,
          activity: parsed.activity ?? "idle",
          detail: parsed.detail ?? null,
          revision: parsed.revision,
          updatedAt: parsed.updatedAt ?? Date.now(),
          heartbeatAt: parsed.heartbeatAt ?? Date.now(),
          terminalTitle:
            typeof parsed.terminalTitle === "string" && isSessionTerminalTitle(parsed.terminalTitle)
              ? parsed.terminalTitle
              : defaults.terminalTitle,
        };
      }
    } catch {
      // 损坏/不存在 → 从零开始
    }
    return null;
  }
}
