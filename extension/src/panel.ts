/**
 * /ompet 主面板组件（Architecture V2，方案 §52）：宠物列表（SelectList）+ 设置入口。
 * 列表 = 全部宠物 + 末尾"设置"条目（选择后进入 SettingsPanel）。
 * TUI 第一版不要求复杂图片预览（sharp 已从运行链删除），仅列表选择。
 */
import { SelectList, replaceTabs, truncateToWidth, type Component } from "@oh-my-pi/pi-tui";
import { getSelectListTheme } from "@oh-my-pi/pi-coding-agent";
import type { DiscoveredPet } from "./pet-discovery.ts";

/** 主面板内"设置"条目的哨兵值（PetKey 格式为 `source:name`，不会冲突） */
export const PET_PANEL_SETTINGS_ENTRY = "settings";

export interface PanelOptions {
  /** 宠物列表（已发现，含损坏跳过信息） */
  pets: DiscoveredPet[];
  /** 当前选中的宠物 key */
  selectedKey: string | null;
  /** 完成回调（参数为选中宠物 key 或 "settings" 哨兵；undefined = 取消） */
  done: (petKey?: string) => void;
}

/** /ompet 主面板：宠物列表 + 设置入口（选择即回调） */
export class PetPickerPanel implements Component {
  private list: SelectList;
  private done: (petKey?: string) => void;

  constructor(options: PanelOptions) {
    this.done = options.done;
    const items = options.pets.map((pet) => ({
      value: pet.key,
      label: pet.displayName,
      description: `${pet.source === "codex" ? "Codex" : "OMPet"} · ${pet.key}`,
      hint: pet.key === options.selectedKey ? "当前" : undefined,
    }));
    items.push({
      value: PET_PANEL_SETTINGS_ENTRY,
      label: "设置",
      description: "插件开关 / 默认宠物 / 动画行映射 / 重置",
    });
    this.list = new SelectList(items, 8, getSelectListTheme());
    this.list.onSelect = (item) => this.done(item.value);
    this.list.onCancel = () => this.done(undefined);
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
