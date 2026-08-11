/**
 * 运行事实单元测试：deriveActivity 真值表、事件映射、detail 推导。
 * 覆盖方案验收：长工具保持 working、并行工具任一结束不回 idle、审批保持 waiting。
 */
import { describe, expect, test } from "bun:test";
import {
  createFacts,
  deriveActivity,
  deriveDetail,
  updateFacts,
  type RuntimeFacts,
} from "../src/facts.ts";

function factsWith(...events: Parameters<typeof updateFacts>[1][]): RuntimeFacts {
  const facts = createFacts();
  for (const e of events) updateFacts(facts, e);
  return facts;
}

describe("deriveActivity", () => {
  test("空事实 → idle", () => {
    expect(deriveActivity(createFacts())).toBe("idle");
  });

  test("waiting 优先于 working（审批中即使 agent 活跃也 waiting）", () => {
    const f = factsWith(
      { type: "agent_start" },
      { type: "tool_start", id: "t1", name: "bash" },
      { type: "approval_requested", label: "bash" },
    );
    expect(deriveActivity(f)).toBe("waiting");
  });

  test("agent/turn/tool 任一活跃 → working", () => {
    expect(deriveActivity(factsWith({ type: "agent_start" }))).toBe("working");
    expect(deriveActivity(factsWith({ type: "turn_start" }))).toBe("working");
    expect(
      deriveActivity(factsWith({ type: "tool_start", id: "t1", name: "read" })),
    ).toBe("working");
  });

  test("长工具无新事件仍 working（heartbeat 保活，不靠 30s 猜测）", () => {
    // 模拟 10 分钟前开始的长工具：事实未清空，状态恒 working
    const f = factsWith({ type: "tool_start", id: "t1", name: "bash" });
    expect(deriveActivity(f)).toBe("working");
  });

  test("并行工具中任一结束，另一个仍在 → working", () => {
    const f = factsWith(
      { type: "tool_start", id: "a", name: "bash" },
      { type: "tool_start", id: "b", name: "edit" },
    );
    updateFacts(f, { type: "tool_end", id: "a" });
    expect(deriveActivity(f)).toBe("working");
  });

  test("最后一个工具结束 → 回到 idle（等待调用方 grace 防抖发布）", () => {
    const f = factsWith({ type: "tool_start", id: "a", name: "bash" });
    updateFacts(f, { type: "tool_end", id: "a" });
    expect(deriveActivity(f)).toBe("idle");
  });

  test("审批解决后按剩余事实回 working 或 idle", () => {
    const f = factsWith(
      { type: "agent_start" },
      { type: "approval_requested", label: "bash" },
    );
    expect(deriveActivity(f)).toBe("waiting");
    updateFacts(f, { type: "approval_resolved" });
    expect(deriveActivity(f)).toBe("working"); // agent 仍活跃
    updateFacts(f, { type: "agent_end" });
    expect(deriveActivity(f)).toBe("idle");
  });

  test("ask 工具开始 → waiting（等待用户回复/选择，优先于 working）", () => {
    const f = factsWith(
      { type: "agent_start" },
      { type: "tool_start", id: "t1", name: "ask" },
    );
    expect(deriveActivity(f)).toBe("waiting");
    expect(f.waiting).toEqual({ kind: "input", label: "等待回复" });
  });

  test("ask 结束（用户已回复）→ 按剩余事实回 working 或 idle", () => {
    const f = factsWith(
      { type: "tool_start", id: "a", name: "bash" },
      { type: "tool_start", id: "q", name: "ask" },
    );
    expect(deriveActivity(f)).toBe("waiting");
    updateFacts(f, { type: "tool_end", id: "q" });
    expect(f.waiting).toBeNull();
    expect(deriveActivity(f)).toBe("working"); // bash 仍活跃
    updateFacts(f, { type: "tool_end", id: "a" });
    expect(deriveActivity(f)).toBe("idle");
  });

  test("普通工具结束不清除 ask 的 waiting（只清同 id 的 input）", () => {
    const f = factsWith(
      { type: "tool_start", id: "q", name: "ask" },
      { type: "tool_start", id: "t", name: "read" },
    );
    updateFacts(f, { type: "tool_end", id: "t" });
    expect(deriveActivity(f)).toBe("waiting");
  });

  test("user_input 清除 ask 的 waiting 但不强制 idle（ask 工具仍活跃）", () => {
    const f = factsWith({ type: "tool_start", id: "q", name: "ask" });
    expect(deriveActivity(f)).toBe("waiting");
    updateFacts(f, { type: "user_input" });
    expect(f.waiting).toBeNull();
    expect(deriveActivity(f)).toBe("working"); // ask 工具尚未 tool_end（方案 §23）
    updateFacts(f, { type: "tool_end", id: "q" });
    expect(deriveActivity(f)).toBe("idle");
  });

  test("approval 与 ask 并存时各自结束只清自己（后到者覆盖）", () => {
    const f = factsWith(
      { type: "approval_requested", label: "bash" },
      { type: "tool_start", id: "q", name: "ask" },
    );
    expect(f.waiting).toEqual({ kind: "input", label: "等待回复" });
    // 审批解决不清 ask 的 input waiting
    updateFacts(f, { type: "approval_resolved" });
    expect(deriveActivity(f)).toBe("waiting");
    // ask 结束才清
    updateFacts(f, { type: "tool_end", id: "q" });
    expect(f.waiting).toBeNull();
  });

  test("input 清除 waiting 但不强制 idle（活跃事实保持 working）", () => {
    const f = factsWith(
      { type: "agent_start" },
      { type: "approval_requested", label: "bash" },
    );
    expect(deriveActivity(f)).toBe("waiting");
    updateFacts(f, { type: "user_input" });
    expect(deriveActivity(f)).toBe("working");
  });

  test("agent_end willContinue=true 不清理（自动续跑不是真收尾）", () => {
    const f = factsWith(
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "tool_start", id: "t1", name: "bash" },
    );
    updateFacts(f, { type: "agent_end", willContinue: true });
    expect(deriveActivity(f)).toBe("working");
    // 真正结束（无 willContinue）才清空
    updateFacts(f, { type: "agent_end" });
    expect(deriveActivity(f)).toBe("idle");
  });

  test("agent_end 生命周期收尾清空所有活跃事实", () => {
    const f = factsWith(
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "tool_start", id: "t1", name: "bash" },
    );
    updateFacts(f, { type: "agent_end" });
    expect(f.agentActive).toBe(false);
    expect(f.turnActive).toBe(false);
    expect(f.activeTools.size).toBe(0);
    expect(deriveActivity(f)).toBe("idle");
  });

  test("agent_end 收尾同时清除 waiting（方案 §23）", () => {
    const f = factsWith(
      { type: "agent_start" },
      { type: "approval_requested", label: "bash" },
    );
    expect(deriveActivity(f)).toBe("waiting");
    updateFacts(f, { type: "agent_end" });
    expect(f.waiting).toBeNull();
    expect(deriveActivity(f)).toBe("idle");
  });

  test("internal_busy_start → working；结束后回 idle", () => {
    const f = factsWith({ type: "internal_busy_start" });
    expect(f.internalBusyCount).toBe(1);
    expect(deriveActivity(f)).toBe("working");
    updateFacts(f, { type: "internal_busy_end" });
    expect(deriveActivity(f)).toBe("idle");
  });

  test("internal busy 与工具并存：任一活跃保持 working", () => {
    const f = factsWith(
      { type: "internal_busy_start" },
      { type: "tool_start", id: "t1", name: "bash" },
    );
    updateFacts(f, { type: "tool_end", id: "t1" });
    expect(deriveActivity(f)).toBe("working"); // internal 仍活跃
    updateFacts(f, { type: "internal_busy_end" });
    expect(deriveActivity(f)).toBe("idle");
  });

  test("internal_busy 计数嵌套：start×2 需 end×2 才回 idle", () => {
    const f = factsWith(
      { type: "internal_busy_start" },
      { type: "internal_busy_start" },
    );
    expect(f.internalBusyCount).toBe(2);
    updateFacts(f, { type: "internal_busy_end" });
    expect(deriveActivity(f)).toBe("working");
    updateFacts(f, { type: "internal_busy_end" });
    expect(deriveActivity(f)).toBe("idle");
  });

  test("internal_busy counter 永不 < 0（多余 end 忽略）", () => {
    const f = factsWith(
      { type: "internal_busy_start" },
      { type: "internal_busy_end" },
      { type: "internal_busy_end" },
      { type: "internal_busy_end" },
    );
    expect(f.internalBusyCount).toBe(0);
    expect(deriveActivity(f)).toBe("idle");
  });
});

describe("deriveDetail", () => {
  test("waiting → kind=approval，label=工具名", () => {
    const f = factsWith({ type: "approval_requested", label: "bash" });
    expect(deriveDetail(f)).toEqual({ kind: "approval", label: "bash" });
  });

  test("ask 等待回复 → kind=input，label=等待回复", () => {
    const f = factsWith({ type: "tool_start", id: "q", name: "ask" });
    expect(deriveDetail(f)).toEqual({ kind: "input", label: "等待回复" });
  });

  test("并行工具 → 展示最后开始的工具", () => {
    const f = factsWith(
      { type: "tool_start", id: "a", name: "read" },
      { type: "tool_start", id: "b", name: "edit" },
    );
    expect(deriveDetail(f)).toEqual({ kind: "tool", label: "edit" });
  });

  test("仅 agent 活跃 → kind=agent", () => {
    const f = factsWith({ type: "agent_start" });
    expect(deriveDetail(f)).toEqual({ kind: "agent", label: "运行中" });
  });

  test("internal busy → kind=internal（优先级高于 agent）", () => {
    const f = factsWith(
      { type: "agent_start" },
      { type: "internal_busy_start" },
    );
    expect(deriveDetail(f)).toEqual({ kind: "internal", label: "内部处理中" });
  });

  test("工具 > internal > agent 的 detail 优先级", () => {
    const f = factsWith(
      { type: "internal_busy_start" },
      { type: "tool_start", id: "t1", name: "bash" },
    );
    expect(deriveDetail(f)).toEqual({ kind: "tool", label: "bash" });
  });

  test("idle → 无 detail（null）", () => {
    expect(deriveDetail(createFacts())).toBeNull();
  });
});
