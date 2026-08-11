/**
 * 宠物面板命令参数语义测试（纯函数，无 mock）：
 * - 命令名契约：主命令 /ompet 存在，/onmypet 为兼容别名；
 * - 参数解析：/ompet settings 子命令已并入主面板（列表内置设置条目），
 *   命令后的所有内容保留为 pendingText，供面板关闭后输入框衔接。
 */
import { describe, expect, test } from "bun:test";
import {
  parsePanelCommandArgs,
  PET_PANEL_COMMAND_NAMES,
} from "../src/panel-command.ts";

describe("命令名契约", () => {
  test("主命令 ompet 与兼容别名 onmypet 都在注册集合中", () => {
    expect(PET_PANEL_COMMAND_NAMES).toContain("ompet");
    expect(PET_PANEL_COMMAND_NAMES).toContain("onmypet");
  });
});

describe("parsePanelCommandArgs 参数语义", () => {
  test("空参数：无衔接文本", () => {
    expect(parsePanelCommandArgs("")).toEqual({ pendingText: "" });
    expect(parsePanelCommandArgs(undefined)).toEqual({ pendingText: "" });
    expect(parsePanelCommandArgs(null)).toEqual({ pendingText: "" });
  });

  test("settings 不再是子命令：作为日常内容保留衔接（已并入主面板）", () => {
    expect(parsePanelCommandArgs("settings")).toEqual({ pendingText: "settings" });
    expect(parsePanelCommandArgs("  Settings  ")).toEqual({
      pendingText: "Settings",
    });
  });

  test("日常内容保留用于输入框衔接", () => {
    expect(parsePanelCommandArgs("早上好")).toEqual({ pendingText: "早上好" });
    expect(parsePanelCommandArgs("  帮我看看代码  ")).toEqual({
      pendingText: "帮我看看代码",
    });
    expect(parsePanelCommandArgs("settings 早上好")).toEqual({
      pendingText: "settings 早上好",
    });
  });
});
