/**
 * 设置面板测试（Architecture V2）：五态 state→row 行映射 UI 全流程。
 * 用 FakeSelectList（DOWN/UP/ENTER/ESC 协议）mock @oh-my-pi，驱动真实 SettingsPanel：
 * 插件开关、宠物选择、五状态行映射（允许重复行、无抢占）、重置默认映射；
 * 全部写入 Global Config（ConfigStore，注入临时路径），pet.json 绝不修改。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ompet-settings-"));
const CONFIG_PATH = path.join(TMP, "config.json");

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
      (it, i) => `${i === this.selected ? ">" : " "} ${it.label}  ${it.description ?? ""}`.trimEnd(),
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

let mods: {
  SettingsPanel: typeof import("../src/settings.ts").SettingsPanel;
  ConfigStore: typeof import("../src/config-store.ts").ConfigStore;
  DiscoveredPet: unknown;
};

beforeAll(async () => {
  mock.module("@oh-my-pi/pi-tui", () => piTuiMock, { perFile: true });
  mock.module("@oh-my-pi/pi-coding-agent", () => ({
    getSelectListTheme: () => ({ symbols: {} }),
  }));
  mods = {
    SettingsPanel: (await import("../src/settings.ts")).SettingsPanel,
    ConfigStore: (await import("../src/config-store.ts")).ConfigStore,
    DiscoveredPet: null,
  };
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** 每个测试从干净配置开始（避免 revision 从磁盘延续） */
beforeEach(() => {
  fs.rmSync(CONFIG_PATH, { force: true });
});

/** 测试宠物（纯对象：SettingsPanel 不访问磁盘） */
const PETS = [
  {
    key: "codex:test-pet",
    source: "codex",
    id: "test-pet",
    displayName: "测试宠物",
    petDirectory: "/unused",
    manifestPath: "/unused/pet.json",
    spritePath: "/unused/spritesheet.webp",
    spriteVersion: 1,
    rowCount: 9,
  },
] as Array<import("../src/pet-discovery.ts").DiscoveredPet>;

/** 每次构造全新 ConfigStore（临时路径）与面板 */
function makePanel() {
  const configStore = new mods.ConfigStore({ configPath: CONFIG_PATH });
  let doneChanged: boolean | null = null;
  const panel = new mods.SettingsPanel({
    configStore,
    pets: PETS,
    activeKey: null,
    done: (changed) => {
      doneChanged = changed;
    },
  });
  return { panel, configStore, get done() { return doneChanged; } };
}

/** 按键流：DOWN n 次 + ENTER/ESC */
function press(panel: { handleInput(d: string): void }, keys: string[]): void {
  for (const k of keys) panel.handleInput(k);
}

/** 当前列表渲染文本（label 列表） */
function renderLabels(panel: { render(w: number): readonly string[] }): string[] {
  return [...panel.render(80)].map((l) => l.trim());
}

/** 等待 fire-and-forget 的 ConfigStore promise 落定 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("设置面板主列表", () => {
  test("包含开关/宠物目录/宠物选择/行映射/重置五项", () => {
    const { panel } = makePanel();
    const lines = renderLabels(panel);
    expect(lines.some((l) => l.includes("启用宠物"))).toBe(true);
    expect(lines.some((l) => l.includes("宠物目录"))).toBe(true);
    expect(lines.some((l) => l.includes("默认宠物：测试宠物"))).toBe(true);
    expect(lines.some((l) => l.includes("Codex · codex:test-pet"))).toBe(true);
    expect(lines.some((l) => l.includes("动画行映射"))).toBe(true);
    expect(lines.some((l) => l.includes("重置默认映射"))).toBe(true);
  });

  test("插件开关切换 → config revision++ 且 enabled 落盘", async () => {
    const { panel, configStore } = makePanel();
    press(panel, ["ENTER"]); // 启用宠物
    await settle();
    expect(configStore.get().enabled).toBe(false);
    expect(configStore.get().revision).toBe(1);
    const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    expect(onDisk.enabled).toBe(false);
    expect(onDisk.revision).toBe(1);
  });

  test("选择默认宠物 → activePet 写入 config（PetKey）", async () => {
    const { panel, configStore } = makePanel();
    press(panel, ["DOWN", "DOWN", "ENTER"]); // 默认宠物（第 3 项）
    await settle();
    expect(configStore.get().activePet).toBe("codex:test-pet");
  });
});

describe("五态行映射 UI（方案 §54）", () => {
  test("行映射列表固定五个状态，RUNNING 默认行 7", () => {
    const { panel } = makePanel();
    press(panel, ["DOWN", "DOWN", "DOWN", "ENTER"]); // 动画行映射（第 4 项）
    const lines = renderLabels(panel);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("IDLE");
    expect(lines[1]).toContain("RUNNING");
    expect(lines[1]).toContain("行 7");
    expect(lines[2]).toContain("WAITING");
    expect(lines[2]).toContain("行 6");
    expect(lines[3]).toContain("MOVE_LEFT");
    expect(lines[3]).toContain("行 2");
    expect(lines[4]).toContain("MOVE_RIGHT");
    expect(lines[4]).toContain("行 1");
  });

  test("修改 RUNNING → 行 3：config revision++，pet.json 不存在（不写宠物文件）", async () => {
    const ctx = makePanel();
    const { panel } = ctx;
    press(panel, ["DOWN", "DOWN", "DOWN", "ENTER"]); // 行映射
    press(panel, ["DOWN", "ENTER"]); // RUNNING → 行号选择
    const rows = renderLabels(panel);
    expect(rows).toHaveLength(9); // V1 行 0-8
    expect(rows[7]).toContain("当前"); // 行 7 当前
    press(panel, ["DOWN", "DOWN", "DOWN", "ENTER"]); // 行 3
    await settle();
    expect(ctx.configStore.get().revision).toBe(1);
    expect(ctx.configStore.get().petOverrides["codex:test-pet"]?.stateRows?.RUNNING).toBe(3);
    // 回到行映射列表：RUNNING 显示行 3
    const back = renderLabels(panel);
    expect(back[1]).toContain("行 3");
    // 设置面板全程未创建任何宠物文件（只写 config.json）
    expect(fs.readdirSync(TMP)).toEqual(["config.json"]);
  });

  test("多个状态允许选择同一行（不互斥不抢占）", async () => {
    const ctx = makePanel();
    const { panel } = ctx;
    press(panel, ["DOWN", "DOWN", "DOWN", "ENTER"]); // 行映射
    // RUNNING → 行 7（与默认相同但显式写入 override）
    press(panel, ["DOWN", "ENTER"]);
    press(panel, ["DOWN", "DOWN", "DOWN", "DOWN", "DOWN", "DOWN", "DOWN", "ENTER"]);
    await settle();
    // WAITING → 行 7（列表重建后光标回 IDLE）
    press(panel, ["DOWN", "DOWN", "ENTER"]);
    press(panel, ["DOWN", "DOWN", "DOWN", "DOWN", "DOWN", "DOWN", "DOWN", "ENTER"]);
    await settle();
    const overrides = ctx.configStore.get().petOverrides["codex:test-pet"]?.stateRows;
    expect(overrides?.RUNNING).toBe(7);
    expect(overrides?.WAITING).toBe(7);
  });

  test("重复选择同值 → revision 不变", async () => {
    const ctx = makePanel();
    const { panel } = ctx;
    press(panel, ["DOWN", "DOWN", "DOWN", "ENTER"]); // 行映射
    press(panel, ["DOWN", "ENTER"]);
    press(panel, ["DOWN", "DOWN", "DOWN", "DOWN", "DOWN", "DOWN", "DOWN", "ENTER"]); // RUNNING → 行 7
    await settle();
    const rev = ctx.configStore.get().revision;
    // 再次 RUNNING → 行 7（同值）
    press(panel, ["DOWN", "ENTER"]);
    press(panel, ["DOWN", "DOWN", "DOWN", "DOWN", "DOWN", "DOWN", "DOWN", "ENTER"]);
    await settle();
    expect(ctx.configStore.get().revision).toBe(rev);
  });

  test("重置默认映射 → 删除 override，回默认行", async () => {
    const ctx = makePanel();
    const { panel } = ctx;
    press(panel, ["DOWN", "DOWN", "DOWN", "ENTER"]); // 行映射
    press(panel, ["DOWN", "ENTER", "DOWN", "DOWN", "DOWN", "ENTER"]); // RUNNING → 行 3
    await settle();
    expect(ctx.configStore.get().petOverrides["codex:test-pet"]?.stateRows?.RUNNING).toBe(3);
    press(panel, ["ESC"]); // 回主列表
    // 主列表：0 启用 / 1 目录 / 2 宠物 / 3 行映射 / 4 重置 → DOWN×4 + ENTER
    press(panel, ["DOWN", "DOWN", "DOWN", "DOWN", "ENTER"]);
    await settle();
    expect(ctx.configStore.get().petOverrides["codex:test-pet"]?.stateRows).toBeUndefined();
  });

  test("V2 宠物（rowCount=11）行号可选 0-10", () => {
    const configStore = new mods.ConfigStore({ configPath: CONFIG_PATH });
    const v2Pets = [
      {
        key: "codex:v2-pet",
        source: "codex",
        id: "v2-pet",
        displayName: "V2宠物",
        petDirectory: "/unused",
        manifestPath: "/unused/pet.json",
        spritePath: "/unused/spritesheet.webp",
        spriteVersion: 2,
        rowCount: 11,
      },
    ] as Array<import("../src/pet-discovery.ts").DiscoveredPet>;
    let doneChanged: boolean | null = null;
    const panel = new mods.SettingsPanel({
      configStore,
      pets: v2Pets,
      activeKey: "codex:v2-pet",
      done: (changed) => {
        doneChanged = changed;
      },
    });
    press(panel, ["DOWN", "DOWN", "DOWN", "ENTER"]); // 行映射
    const rows = renderLabels(panel);
    expect(rows).toHaveLength(5);
    // IDLE → 行号列表应有 11 项（0-10）
    press(panel, ["ENTER"]);
    const rowItems = renderLabels(panel);
    expect(rowItems).toHaveLength(11);
    expect(rowItems[10]).toContain("行 10");
  });
});
