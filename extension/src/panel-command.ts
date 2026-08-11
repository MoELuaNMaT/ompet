/**
 * 宠物面板命令参数语义（可独立测试的纯逻辑）：
 * - 命令名集合：主命令 /ompet（唤醒宠物），/onmypet 为 V1 兼容别名；
 * - 参数解析：/ompet settings 子命令已并入主面板（列表内置"设置"条目，
 *   选择后进入 SettingsPanel）；命令后的所有内容作为 pendingText 在
 *   面板关闭后放回输入框衔接（日常说话不丢失）。
 */

/** 宠物面板命令名：主命令 + V1 兼容别名（共享同一 handler） */
export const PET_PANEL_COMMAND_NAMES: readonly string[] = ["ompet", "onmypet"];

export interface PanelCommandArgs {
  /** 衔接文本：面板关闭后放回输入框的内容 */
  pendingText: string;
}

/** 解析 /ompet 命令参数：trim + 衔接文本保留 */
export function parsePanelCommandArgs(
  args: string | null | undefined,
): PanelCommandArgs {
  return { pendingText: (args ?? "").trim() };
}
