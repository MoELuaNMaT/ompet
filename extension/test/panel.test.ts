/**
 * 面板组件测试（Architecture V2）：宠物列表渲染、选择回调（mock @oh-my-pi 模块）。
 * TUI 第一版无图片预览（sharp 已从运行链删除），仅列表选择。
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { DiscoveredPet } from "../src/pet-discovery.ts";

type FakeItem = { value: string; label: string; description?: string; hint?: string };

class FakeSelectList {
  items: FakeItem[];
  onSelect?: (item: FakeItem) => void;
  onCancel?: () => void;
  onSelectionChange?: (item: FakeItem) => void;
  selected = 0;
  constructor(items: FakeItem[], public maxVisible: number, public theme: unknown) {
    this.items = items;
  }
  handleInput(data: string): void {
    if (data === "DOWN") {
      this.selected = Math.min(this.selected + 1, this.items.length - 1);
      this.onSelectionChange?.(this.items[this.selected]!);
    } else if (data === "UP") {
      this.selected = Math.max(this.selected - 1, 0);
      this.onSelectionChange?.(this.items[this.selected]!);
    } else if (data === "ENTER") {
      this.onSelect?.(this.items[this.selected]!);
    } else if (data === "ESC") {
      this.onCancel?.();
    }
  }
  render(width: number): readonly string[] {
    return this.items.map(
      (it, i) =>
        `${i === this.selected ? ">" : " "} ${it.label}  ${it.description ?? ""}${it.hint ? ` [${it.hint}]` : ""}`.trimEnd(),
    );
  }
  invalidate(): void {}
}

const piTuiMock = {
  Image: class {},
  SelectList: FakeSelectList,
  replaceTabs: (s: string) => s,
  truncateToWidth: (s: string) => s,
  visibleWidth: (s: string) => s.length,
};

// ---- 被测模块（mock 之后动态 import；mock 必须先于 import 注册）----
let PetPickerPanel: typeof import("../src/panel.ts").PetPickerPanel;
beforeAll(async () => {
  mock.module("@oh-my-pi/pi-tui", () => piTuiMock, { perFile: true });
  mock.module("@oh-my-pi/pi-coding-agent", () => ({
    getSelectListTheme: () => ({ symbols: {} }),
  }));
  PetPickerPanel = (await import("../src/panel.ts")).PetPickerPanel;
});

/** 测试宠物（纯对象：面板不访问磁盘） */
const PETS: DiscoveredPet[] = [
  {
    key: "codex:remilia",
    source: "codex",
    id: "remilia",
    displayName: "蕾米",
    petDirectory: "/unused",
    manifestPath: "/unused/pet.json",
    spritePath: "/unused/spritesheet.webp",
    spriteVersion: 1,
    rowCount: 9,
  },
  {
    key: "ompet:elaina",
    source: "ompet",
    id: "elaina",
    displayName: "Elaina",
    petDirectory: "/unused",
    manifestPath: "/unused/pet.json",
    spritePath: "/unused/spritesheet.webp",
    spriteVersion: 1,
    rowCount: 9,
  },
];

function makePanel(selectedKey: string | null = "codex:remilia") {
  let doneValue: string | undefined;
  const done = (v?: string) => {
    doneValue = v;
  };
  const panel = new PetPickerPanel({
    pets: PETS,
    selectedKey,
    done,
  });
  return { panel, getDone: () => doneValue };
}

describe("PetPickerPanel", () => {
  test("渲染列表项与来源描述（PetKey）", () => {
    const { panel } = makePanel();
    const rows = panel.render(120);
    expect(rows.some((r) => r.includes("蕾米"))).toBe(true);
    expect(rows.some((r) => r.includes("Elaina"))).toBe(true);
    expect(rows.some((r) => r.includes("codex:remilia"))).toBe(true);
    expect(rows.some((r) => r.includes("ompet:elaina"))).toBe(true);
  });

  test("当前选中宠物标记 hint", () => {
    const { panel } = makePanel("ompet:elaina");
    const rows = panel.render(120);
    expect(rows.find((r) => r.includes("Elaina"))).toContain("当前");
  });

  test("回车选择触发 done(petKey)", () => {
    const { panel, getDone } = makePanel();
    panel.handleInput("ENTER");
    expect(getDone()).toBe("codex:remilia");
  });

  test("DOWN 后回车选择第二只", () => {
    const { panel, getDone } = makePanel();
    panel.handleInput("DOWN");
    panel.handleInput("ENTER");
    expect(getDone()).toBe("ompet:elaina");
  });

  test("列表末尾含设置条目（进入设置面板的入口）", () => {
    const { panel } = makePanel();
    const rows = panel.render(120);
    const settingsRow = rows.find((r) => r.includes("设置"));
    expect(settingsRow).toBeDefined();
    expect(settingsRow).toContain("动画行映射");
  });

  test("选择设置条目 → done 收到 settings 哨兵值", () => {
    const { panel, getDone } = makePanel();
    // 两只宠物 → 设置条目在索引 2
    panel.handleInput("DOWN");
    panel.handleInput("DOWN");
    panel.handleInput("ENTER");
    expect(getDone()).toBe("settings");
  });

  test("ESC 取消触发 done(undefined)", () => {
    const { panel, getDone } = makePanel();
    panel.handleInput("ESC");
    expect(getDone()).toBeUndefined();
  });
});
