import { describe, expect, test } from "bun:test";
import { syncBubbleAppearance } from "../src/lib/bubble-visual.ts";

class FakeClassList {
  private readonly values = new Set<string>();
  addCount = 0;

  add(...names: string[]): void {
    for (const name of names) {
      if (!this.values.has(name)) this.addCount++;
      this.values.add(name);
    }
  }

  remove(...names: string[]): void {
    for (const name of names) this.values.delete(name);
  }

  toggle(name: string, force?: boolean): boolean {
    const next = force ?? !this.values.has(name);
    if (next) this.add(name);
    else this.remove(name);
    return next;
  }

  contains(name: string): boolean {
    return this.values.has(name);
  }
}

describe("气泡首帧状态同步", () => {
  test("展开进入胶囊时立即切换到当前状态类", () => {
    const classList = new FakeClassList();
    classList.add("bubble", "orb", "s-working");

    syncBubbleAppearance(classList, "capsule", "waiting");

    expect(classList.contains("capsule")).toBe(true);
    expect(classList.contains("orb")).toBe(false);
    expect(classList.contains("s-waiting")).toBe(true);
    expect(classList.contains("s-working")).toBe(false);
  });

  test("同状态轮询不重复写状态类，避免重置左侧 CSS 动画", () => {
    const classList = new FakeClassList();

    syncBubbleAppearance(classList, "orb", "working");
    const addCount = classList.addCount;
    syncBubbleAppearance(classList, "capsule", "working");

    expect(classList.addCount).toBe(addCount + 1); // 仅新增 capsule，不重加 s-working
    expect(classList.contains("capsule")).toBe(true);
    expect(classList.contains("s-working")).toBe(true);
  });
});
