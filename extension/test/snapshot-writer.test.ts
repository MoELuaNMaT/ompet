/**
 * 快照写入器 V2 单元测试（方案 §29–§33）：
 * 原子写、revision 去重、heartbeat 不动 revision、close 删除文件、
 * session 切换归零、进程重启恢复。全部走注入路径，不触碰真实 ~/.omp/ompet/run。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SnapshotWriter,
  snapshotPath,
  terminalTitleFor,
  type SnapshotContext,
} from "../src/snapshot-writer.ts";
import type { SessionSnapshot } from "../../packages/shared/src/index.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ompet-snap-"));
let file = "";

function makeCtx(sessionId = "sess-1", cwd = "C:/projects/ompet"): SnapshotContext {
  return { sessionId, cwd, pid: 4242 };
}

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  file = path.join(TMP, `${Math.random().toString(36).slice(2)}.json`);
});
afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function makeWriter(ctx: SnapshotContext = makeCtx()) {
  return new SnapshotWriter(() => ctx, file);
}

function readSnapshot(file: string): SessionSnapshot {
  return JSON.parse(fs.readFileSync(file, "utf8")) as SessionSnapshot;
}

describe("SnapshotWriter V2", () => {
  test("publish 原子写：schemaVersion=2、无 petId/stateSince/closed、无 .tmp 残留", () => {
    const w = makeWriter();
    w.publish("working", { kind: "tool", label: "bash" });
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    const s = readSnapshot(file);
    expect(s.schemaVersion).toBe(2);
    expect(s.activity).toBe("working");
    expect(s.detail).toEqual({ kind: "tool", label: "bash" });
    expect(s.sessionId).toBe("sess-1");
    expect(s.producerPid).toBe(4242);
    expect(s.revision).toBe(1);
    // V2 删除的字段不得出现（方案 §27）
    expect(s).not.toHaveProperty("petId");
    expect(s).not.toHaveProperty("stateSince");
    expect(s).not.toHaveProperty("closed");
    expect(s.updatedAt).toBeGreaterThan(0);
    expect(s.heartbeatAt).toBeGreaterThanOrEqual(s.updatedAt);
  });

  test("publish 写入包含 sessionId 的唯一终端标题", () => {
    const alphaFile = path.join(TMP, "alpha.json");
    const betaFile = path.join(TMP, "beta.json");
    const alpha = new SnapshotWriter(
      () => makeCtx("sess-alpha", "C:/projects/shared"),
      alphaFile,
    );
    const beta = new SnapshotWriter(
      () => makeCtx("sess-beta", "C:/projects/shared"),
      betaFile,
    );

    alpha.publish("working");
    beta.publish("working");

    const alphaSnapshot = readSnapshot(alphaFile);
    const betaSnapshot = readSnapshot(betaFile);
    expect(alphaSnapshot.terminalTitle).toBe(terminalTitleFor("C:/projects/shared", "sess-alpha"));
    expect(betaSnapshot.terminalTitle).toBe(terminalTitleFor("C:/projects/shared", "sess-beta"));
    expect(alphaSnapshot.terminalTitle).not.toBe(betaSnapshot.terminalTitle);
  });

  test("syncTerminalTitle 返回并设置会话级标题", () => {
    const previousTitle = process.title;
    try {
      const title = SnapshotWriter.syncTerminalTitle("C:/projects/shared", "sess-alpha");
      expect(title).toBe("shared [ompet:sess-alpha]");
      expect(process.title).toBe(title);
    } finally {
      process.title = previousTitle;
    }
  });

  test("session 切换后 heartbeat 不继承旧 session 的节流状态", () => {
    let ctx = makeCtx("sess-alpha", "C:/projects/shared");
    const w = new SnapshotWriter(() => ctx, file);
    w.heartbeat();

    ctx = makeCtx("sess-beta", "C:/projects/shared");
    w.heartbeat();

    const snapshot = readSnapshot(file);
    expect(snapshot.sessionId).toBe("sess-beta");
    expect(snapshot.terminalTitle).toBe(terminalTitleFor("C:/projects/shared", "sess-beta"));
  });

  test("activity+detail 相同去重：不写盘不增加 revision", () => {
    const w = makeWriter();
    w.publish("working", { kind: "tool", label: "bash" });
    w.publish("working", { kind: "tool", label: "bash" });
    expect(readSnapshot(file).revision).toBe(1);
  });

  test("detail 变化：revision+1（V2 无 stateSince）", () => {
    const w = makeWriter();
    w.publish("working", { kind: "tool", label: "bash" });
    const first = readSnapshot(file);
    w.publish("working", { kind: "tool", label: "read" });
    const second = readSnapshot(file);
    expect(second.revision).toBe(first.revision + 1);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });

  test("activity 变化：revision+1", () => {
    const w = makeWriter();
    w.publish("working", { kind: "tool", label: "bash" });
    const first = readSnapshot(file);
    w.publish("waiting", { kind: "approval", label: "bash" });
    const second = readSnapshot(file);
    expect(second.revision).toBe(first.revision + 1);
    expect(second.activity).toBe("waiting");
  });

  test("detail null 与有 detail 去重独立", () => {
    const w = makeWriter();
    w.publish("idle");
    w.publish("idle");
    expect(readSnapshot(file).revision).toBe(1);
    w.publish("working", null);
    expect(readSnapshot(file).revision).toBe(2);
  });

  test("heartbeat 只刷 heartbeatAt，不增加 revision、不动 updatedAt", () => {
    const w = makeWriter();
    w.publish("working");
    const before = readSnapshot(file);
    w.heartbeat();
    w.heartbeat(); // 节流后第二次被忽略
    const after = readSnapshot(file);
    expect(after.revision).toBe(before.revision);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.heartbeatAt).toBeGreaterThanOrEqual(before.heartbeatAt);
    expect(after.activity).toBe("working");
  });

  test("close 删除自身快照文件（不写 closed 标记）", () => {
    const w = makeWriter();
    w.publish("working");
    expect(fs.existsSync(file)).toBe(true);
    w.close();
    expect(fs.existsSync(file)).toBe(false);
  });

  test("close 后 publish 重新创建文件", () => {
    const w = makeWriter();
    w.publish("working");
    w.close();
    w.publish("idle");
    expect(fs.existsSync(file)).toBe(true);
    expect(readSnapshot(file).activity).toBe("idle");
  });

  test("session 切换：内容重建到新 session，revision 归零", () => {
    let ctx = makeCtx("sess-1");
    const w = new SnapshotWriter(() => ctx, file);
    w.publish("working");
    const first = readSnapshot(file);
    expect(first.sessionId).toBe("sess-1");
    expect(first.revision).toBe(1);
    ctx = makeCtx("sess-2");
    w.publish("waiting", { kind: "approval", label: "bash" });
    const second = readSnapshot(file);
    expect(second.sessionId).toBe("sess-2");
    expect(second.revision).toBe(1); // 新 session 从 0 起
    expect(second.activity).toBe("waiting");
  });

  test("snapshotPath 指向新目录 ~/.omp/ompet/run 并按 sessionId 编码", () => {
    const p = snapshotPath("my/session:1");
    expect(path.basename(p)).toBe(`${encodeURIComponent("my/session:1")}.json`);
    expect(p).toContain(path.join(".omp", "ompet", "run"));
    expect(p).not.toContain(path.join(".omp", "run", "pets"));
    expect(snapshotPath("a")).not.toBe(snapshotPath("b"));
  });

  test("进程重启恢复：同 sessionId 续用 revision", () => {
    const ctx = makeCtx();
    const w1 = new SnapshotWriter(() => ctx, file);
    w1.publish("working");
    w1.publish("waiting", { kind: "approval", label: "bash" });
    // 模拟 extension 重启：新 writer 读既有文件
    const w2 = new SnapshotWriter(() => ctx, file);
    expect(w2.current.revision).toBe(2);
    expect(w2.current.activity).toBe("waiting");
    w2.publish("idle");
    expect(readSnapshot(file).revision).toBe(3);
  });

  test("损坏快照 → 从零开始不崩溃", () => {
    fs.writeFileSync(file, "{broken json!!", "utf8");
    const ctx = makeCtx();
    const w = new SnapshotWriter(() => ctx, file);
    expect(w.current.revision).toBe(0);
    w.publish("working");
    const s = readSnapshot(file);
    expect(s.revision).toBe(1);
    expect(s.activity).toBe("working");
  });

  test("异 sessionId 的既有文件不续用（重建）", () => {
    const w1 = new SnapshotWriter(() => makeCtx("sess-a"), file);
    w1.publish("working");
    const w2 = new SnapshotWriter(() => makeCtx("sess-b"), file);
    expect(w2.current.revision).toBe(0);
  });
});
