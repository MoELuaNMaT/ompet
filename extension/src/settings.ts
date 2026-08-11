/**
 * /ompet 设置面板（Architecture V2，方案 §52–§55）。
 *
 * 第一版只负责：插件开关、宠物选择、五状态行映射、重置默认映射。
 * 持久化到 ~/.omp/ompet/config.json（Global Config，ConfigStore 原子写）；
 * 绝不写 pet.json（Codex 宠物文件完全只读）。
 *
 * 行映射为 state → row：UI 固定五个正式状态，每状态选一个行号；
 * 多个状态允许选择同一行（不互斥、不抢占，方案 §12 / §54）。
 */
import { SelectList, replaceTabs, truncateToWidth, type Component } from "@oh-my-pi/pi-tui";
import { getSelectListTheme } from "@oh-my-pi/pi-coding-agent";
import {
  DEFAULT_STATE_ROWS,
  resolveStateRows,
  STATE_ROW_KEYS,
  type PetKey,
  type StateRowMap,
  type VisiblePetState,
} from "../../packages/shared/src/index.ts";
import type { ConfigStore } from "./config-store.ts";
import type { DiscoveredPet } from "./pet-discovery.ts";

/** 五个正式状态的中文说明 */
const STATE_LABELS: Record<VisiblePetState, string> = {
  IDLE: "待机",
  RUNNING: "运行中",
  WAITING: "等待回复",
  MOVE_LEFT: "向左移动",
  MOVE_RIGHT: "向右移动",
};

export interface SettingsPanelOptions {
  configStore: ConfigStore;
  /** 发现到的全部宠物（key 唯一） */
  pets: DiscoveredPet[];
  /** 当前选中的宠物 key（无 → null） */
  activeKey: PetKey | null;
  done: (changed: boolean) => void;
}

/** 层级导航：主列表 / 状态行列表 / 行号选择 */
type Mode = "main" | "rows" | "rowselect";

export class SettingsPanel implements Component {
  private list: SelectList;
  private configStore: ConfigStore;
  private pets: DiscoveredPet[];
  private activeKey: PetKey | null;
  private done: (changed: boolean) => void;
  private changed = false;
  private mode: Mode = "main";
  /** 正在编辑行映射的宠物（activeKey 对应或第一只） */
  private editingPet: DiscoveredPet | null;
  /** 当前正在选择行号的状态 */
  private editingState: VisiblePetState | null = null;

  constructor(options: SettingsPanelOptions) {
    this.configStore = options.configStore;
    this.pets = options.pets;
    this.activeKey = options.activeKey;
    this.done = options.done;
    this.editingPet =
      this.pets.find((pet) => pet.key === options.activeKey) ?? this.pets[0] ?? null;
    this.list = new SelectList(this.buildMainItems(), 10, getSelectListTheme());
    this.list.onSelect = (item) => this.onSelect(item.value);
    this.list.onCancel = () => this.onCancel();
  }

  /** 编辑目标宠物的行号上限（V1=8，V2=10；方案 §54） */
  private maxRow(): number {
    return (this.editingPet?.rowCount ?? 9) - 1;
  }

  /** 当前宠物的生效行映射（default + override） */
  private effectiveRows(): StateRowMap {
    const key = this.editingPet?.key;
    if (!key) return { ...DEFAULT_STATE_ROWS };
    return resolveStateRows(this.configStore.get().petOverrides[key]);
  }

  /** 主列表：插件开关 + 宠物选择 + 行映射 + 重置 */
  private buildMainItems() {
    const config = this.configStore.get();
    const items = [
      {
        value: "enabled",
        label: "启用宠物",
        description: config.enabled ? "已开启" : "已关闭",
        hint: "回车切换",
      },
      {
        value: "petsDir",
        label: "宠物目录",
        description: "~/.codex/pets 与 ~/.omp/ompet/pets",
      },
    ];
    for (const pet of this.pets) {
      items.push({
        value: `pet:${pet.key}`,
        label: `默认宠物：${pet.displayName}`,
        description: `${pet.source === "codex" ? "Codex" : "OMPet"} · ${pet.key}`,
        hint: pet.key === this.activeKey ? "当前" : undefined,
      });
    }
    items.push({
      value: "rows",
      label: "动画行映射",
      description: this.describeRows(),
      hint: "回车配置",
    });
    if (this.editingPet) {
      items.push({
        value: "reset",
        label: "重置默认映射",
        description: "恢复 Codex 默认行",
        hint: "回车重置",
      });
    }
    return items;
  }

  /** 行映射入口描述：当前生效行配置摘要 */
  private describeRows(): string {
    const rows = this.effectiveRows();
    return STATE_ROW_KEYS.map((state) => `${state} ${rows[state]}`).join("  ");
  }

  /** 状态行列表：五个正式状态各一行 */
  private buildRowItems() {
    const rows = this.effectiveRows();
    const maxRow = this.maxRow();
    return STATE_ROW_KEYS.map((state) => {
      const row = rows[state];
      const outOfRange = row > maxRow;
      return {
        value: `state:${state}`,
        label: state,
        description: `${STATE_LABELS[state]} · 行 ${row}${outOfRange ? "（越界，回退默认）" : ""}`,
        hint: "回车修改",
      };
    });
  }

  /** 行号选择列表：0..rowCount-1，允许重复选择同一行（无抢占） */
  private buildRowSelectItems() {
    const state = this.editingState!;
    const rows = this.effectiveRows();
    const maxRow = this.maxRow();
    const items = [];
    for (let row = 0; row <= maxRow; row++) {
      items.push({
        value: `row:${row}`,
        label: `行 ${row}`,
        description: row === rows[state] ? "当前" : undefined,
        hint: row === rows[state] ? "当前" : undefined,
      });
    }
    return items;
  }

  private rebuild(): void {
    this.list = new SelectList(
      this.mode === "main"
        ? this.buildMainItems()
        : this.mode === "rows"
          ? this.buildRowItems()
          : this.buildRowSelectItems(),
      10,
      getSelectListTheme(),
    );
    this.list.onSelect = (item) => this.onSelect(item.value);
    this.list.onCancel = () => this.onCancel();
    this.invalidate();
  }

  private onSelect(value: string): void {
    if (this.mode === "main") {
      this.onMainSelect(value);
      return;
    }
    if (this.mode === "rows") {
      const state = value.slice(6) as VisiblePetState;
      if ((STATE_ROW_KEYS as readonly string[]).includes(state)) {
        this.editingState = state;
        this.mode = "rowselect";
        this.rebuild();
      }
      return;
    }
    // rowselect：应用行号（立即写入 Global Config）
    const row = Number(value.slice(4));
    if (this.editingPet && this.editingState && Number.isInteger(row)) {
      void this.configStore
        .setStateRow(this.editingPet.key, this.editingState, row)
        .then(() => {
          this.changed = true;
        });
    }
    this.mode = "rows";
    this.rebuild();
  }

  private onMainSelect(value: string): void {
    if (value === "enabled") {
      const enabled = !this.configStore.get().enabled;
      void this.configStore.setEnabled(enabled).then(() => {
        this.changed = true;
        this.rebuild();
      });
      return;
    }
    if (value.startsWith("pet:")) {
      const key = value.slice(4) as PetKey;
      void this.configStore.setActivePet(key).then(() => {
        this.changed = true;
        this.done(true);
      });
      return;
    }
    if (value === "rows") {
      if (!this.editingPet) return;
      this.mode = "rows";
      this.rebuild();
      return;
    }
    if (value === "reset") {
      if (!this.editingPet) return;
      void this.configStore.resetStateRows(this.editingPet.key).then(() => {
        this.changed = true;
        this.rebuild();
      });
      return;
    }
    // petsDir 仅展示
    this.done(this.changed);
  }

  private onCancel(): void {
    if (this.mode === "rowselect") {
      this.mode = "rows";
      this.rebuild();
      return;
    }
    if (this.mode === "rows") {
      this.mode = "main";
      this.rebuild();
      return;
    }
    this.done(this.changed);
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): readonly string[] {
    return this.list.render(width).map((l) => truncateToWidth(replaceTabs(l), width));
  }
}
