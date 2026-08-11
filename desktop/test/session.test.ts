/**
 * session 快照解析与选择单测：损坏跳过、stale 剔除、updatedAt 选择、粘性。
 * 覆盖方案验收：扩展异常退出 15s 内剔除；快照损坏不崩溃不清空。
 */
import { describe, expect, test } from "bun:test";
import {
  decodeSnapshotId,
  isInvalid,
  parseSnapshot,
  selectSession,
  shouldExitDesktop,
  type Snapshot,
} from "../src/lib/session.ts";
import { PET_CONFIG } from "../../packages/shared/src/index.ts";

function snap(over: Partial<Snapshot> = {}): Snapshot {
  const now = 1_000_000;
  return {
    schemaVersion: 2,
    sessionId: "s1",
    cwd: "C:/projects/ompet",
    activity: "idle",
    detail: null,
    revision: 1,
    updatedAt: now,
    heartbeatAt: now,
    producerPid: 4242,
    ...over,
  };
}

/** V1 快照（迁移期兼容；含 petId/stateSince/closed） */
function snapV1(over: Partial<Snapshot> = {}): Snapshot {
  return {
    ...snap({ schemaVersion: 1 as const, petId: "remilia", closed: false }),
    ...over,
  };
}

describe("parseSnapshot", () => {
  test("V2 合法快照解析", () => {
    const s = parseSnapshot(JSON.stringify(snap()));
    expect(s?.sessionId).toBe("s1");
    expect(s?.activity).toBe("idle");
    expect(s?.schemaVersion).toBe(2);
    expect(s?.petId).toBeUndefined();
  });

  test("V2 快照保留 terminalTitle，旧快照缺失时保持兼容", () => {
    const title = "ompet [ompet:sess-1]";
    expect(parseSnapshot(JSON.stringify(snap({ terminalTitle: title })))?.terminalTitle).toBe(title);
    expect(parseSnapshot(JSON.stringify(snap()))?.terminalTitle).toBeUndefined();
    expect(parseSnapshot(JSON.stringify(snap({ terminalTitle: "ompet" })))?.terminalTitle).toBeUndefined();
  });

  test("V1 快照兼容解析（迁移期）：保留 petId/closed", () => {
    const s = parseSnapshot(JSON.stringify(snapV1()));
    expect(s?.schemaVersion).toBe(1);
    expect(s?.petId).toBe("remilia");
    expect(s?.closed).toBe(false);
    expect(s?.activity).toBe("idle");
  });

  test("V1 快照缺失 petId 字段 → 解析为 undefined（V2 由 config 提供宠物）", () => {
    const raw = JSON.stringify(snap({ schemaVersion: 1 as const, petId: undefined, closed: false }));
    const s = parseSnapshot(raw);
    expect(s?.petId).toBeUndefined();
  });

  test("detail null 与缺省 detail 都解析为 null", () => {
    const withNull = parseSnapshot(JSON.stringify(snap({ detail: null })));
    expect(withNull?.detail).toBeNull();
    const missing = parseSnapshot(JSON.stringify(snap({ detail: undefined })));
    expect(missing?.detail).toBeNull();
  });

  test("损坏 JSON → null（跳过本轮不崩溃）", () => {
    expect(parseSnapshot("{broken json!!")).toBeNull();
  });

  test("缺关键字段/未知 schemaVersion → null", () => {
    expect(parseSnapshot(JSON.stringify({ hello: "world" }))).toBeNull();
    expect(parseSnapshot(JSON.stringify(snap({ schemaVersion: 3 as never })))).toBeNull();
  });

  test("空内容 → null", () => {
    expect(parseSnapshot("")).toBeNull();
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot(undefined)).toBeNull();
  });
});

describe("isInvalid", () => {
  const now = 2_000_000;

  test("V1 closed 立即失效（生命周期标记，非第六种动画）", () => {
    expect(isInvalid(snapV1({ closed: true }), now)).toBe(true);
  });

  test("V2 无 closed 字段 → 仅按 heartbeat 判定", () => {
    expect(isInvalid(snap({ heartbeatAt: now }), now)).toBe(false);
  });

  test("heartbeat 在 staleAfterMs 内 → 有效", () => {
    expect(isInvalid(snap({ heartbeatAt: now - PET_CONFIG.staleAfterMs + 1 }), now)).toBe(false);
  });

  test("heartbeat 超过 staleAfterMs → 失效（扩展崩溃/退出）", () => {
    expect(isInvalid(snap({ heartbeatAt: now - PET_CONFIG.staleAfterMs - 1 }), now)).toBe(true);
  });
});

describe("selectSession", () => {
  const now = 3_000_000;
  const fresh = (id: string, updatedAt: number, over: Partial<Snapshot> = {}) =>
    snap({ sessionId: id, updatedAt, heartbeatAt: now, ...over });

  test("无有效快照 → null（回本地 idle）", () => {
    expect(selectSession([], null, now)).toBeNull();
    // 全部 stale/closed → null
    const stale = [fresh("a", 1, { heartbeatAt: now - PET_CONFIG.staleAfterMs - 1 })];
    expect(selectSession(stale, null, now)).toBeNull();
  });

  test("多 session 选 updatedAt 最新（不按状态优先级）", () => {
    const s = [
      fresh("old", 100),
      fresh("new", 500),
      fresh("mid", 300),
    ];
    expect(selectSession(s, null, now)?.sessionId).toBe("new");
  });

  test("粘性：当前 session 仍有效时保持，不跨 session 抢占", () => {
    const current = fresh("cur", 100);
    const newer = fresh("other", 999);
    const s = [current, newer];
    // 别的 session updatedAt 更新，但当前仍有效 → 保持粘性
    expect(selectSession(s, current, now)?.sessionId).toBe("cur");
  });

  test("粘性 session 失效（stale）后切换为最新活动 session", () => {
    const current = fresh("cur", 100, { heartbeatAt: now - PET_CONFIG.staleAfterMs - 1 });
    const other = fresh("other", 999);
    const selected = selectSession([current, other], current, now);
    expect(selected?.sessionId).toBe("other");
  });

  test("粘性返回同 session 的新对象（revision 变化可被检测）", () => {
    const current = fresh("cur", 100, { revision: 1 });
    const updated = fresh("cur", 200, { revision: 2 });
    const selected = selectSession([updated], current, now);
    expect(selected?.sessionId).toBe("cur");
    expect(selected?.revision).toBe(2);
  });
});

describe("shouldExitDesktop", () => {
  test("无有效 session 起始时刻为 null → 不退出", () => {
    expect(shouldExitDesktop(null, 1_000)).toBe(false);
  });

  test("未超过阈值 → 不退出", () => {
    const start = 1_000;
    expect(shouldExitDesktop(start, start + PET_CONFIG.desktopNoSessionExitMs - 1)).toBe(false);
  });

  test("超过阈值 → 退出（跟随 omp：所有 session 关闭后桌面自动关闭）", () => {
    const start = 1_000;
    expect(shouldExitDesktop(start, start + PET_CONFIG.desktopNoSessionExitMs)).toBe(true);
  });
});

describe("decodeSnapshotId", () => {
  test("文件名反解 sessionId", () => {
    expect(decodeSnapshotId("sess-1.json")).toBe("sess-1");
    expect(decodeSnapshotId(`${encodeURIComponent("my/session:1")}.json`)).toBe("my/session:1");
  });

  test("非法编码不崩溃（原样返回）", () => {
    expect(decodeSnapshotId("%zz.json")).toBe("%zz.json");
  });
});
