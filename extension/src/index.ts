/**
 * ompet 扩展入口：/ompet 命令（宠物列表预览 + 设置面板；/onmypet 为兼容别名）。
 *
 * 部署：extension/ 目录整体复制到 ~/.omp/agent/extensions/ompet/，
 * omp 自动发现加载（扩展工厂签名与 @oh-my-pi/* import 由 host 重写支持）。
 */
import * as os from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { PetPickerPanel, PET_PANEL_SETTINGS_ENTRY } from "./panel.ts";
import { SettingsPanel } from "./settings.ts";
import { SnapshotWriter } from "./snapshot-writer.ts";
import { createFacts, deriveActivity, deriveDetail, updateFacts, type FactsEvent } from "./facts.ts";
import { ConfigStore } from "./config-store.ts";
import {
  discoverPets,
  resolveActivePet,
  type DiscoveredPet,
} from "./pet-discovery.ts";
import { DesktopLauncher } from "./desktop-launcher.ts";
import { migrateLegacyPets } from "./migration.ts";
import {
  parsePanelCommandArgs,
  PET_PANEL_COMMAND_NAMES,
} from "./panel-command.ts";
import { PET_CONFIG, type Activity } from "../../packages/shared/src/index.ts";

export default function ompetExtension(pi: ExtensionAPI): void {
  pi.setLabel("ompet 宠物");

  // 事件不一定在扩展加载后触发（session_start 可能已错过），多事件幂等处理；
  // 定时器来自事件 ctx（pi 上没有 setInterval，ExtensionContext 上才有）
  let currentCwd = "";
  const applyCtx = (ctx: { cwd?: string; hasUI?: boolean }): void => {
    if (ctx.cwd) currentCwd = ctx.cwd;
    // 子代理/headless 会话 hasUI 恒为 false；交互式 TUI 会话 hasUI 为 true，首次见到即置位
    if (ctx.hasUI) interactive = true;
  };
  // 宠物信息只取一次（改配置后重启扩展生效）；cwd/sessionId 动态更新
  const configStore = new ConfigStore();
  const config0 = configStore.get();
  let sessionId = "default"; // 首事件 ctx.sessionManager.getSessionId() 后更新
  /** 插件总开关（settings 面板运行期可切换）；false 时暂停快照发布与心跳 */
  let pluginEnabled = config0.enabled;
  /** 仅交互式（TUI）会话驱动宠物快照；子代理/headless 会话 hasUI=false 不发布 */
  let interactive = false;
  /** 桌面端生命周期：启用时拉起（幂等，单实例锁保护），禁用时暂停发布让桌面自动退出 */
  const launcher = new DesktopLauncher({
    getConfig: () => ({ enabled: configStore.get().enabled }),
  });

  // ---- 业务状态推导（方案 §34 执行顺序）----
  // RuntimeFacts 由事件更新；deriveActivity 纯函数推导 idle/working/waiting；
  // 快照由 SnapshotWriter 原子写（revision/heartbeat 协议，V2 不含 petId）。
  const facts = createFacts();
  const writer = new SnapshotWriter(() => ({
    sessionId,
    cwd: currentCwd,
    pid: process.pid,
  }));
  const apply = (activity: Activity): void => {
    writer.publish(activity, deriveDetail(facts));
  };
  // 任何事件后统一刷新：idle 走 750ms grace 防抖（消除连续工具间闪烁），
  // working/waiting 立即发布。30 秒无事件回 idle 的猜测逻辑已删除（方案 7.1）。
  // 插件关闭（pluginEnabled=false）时暂停发布：桌面端靠 15s stale 剔除、60s 无有效后退出。
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    if (!pluginEnabled || !interactive) return;
    const activity = deriveActivity(facts);
    if (activity === "idle") {
      clearTimeout(idleTimer ?? undefined);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        apply("idle");
      }, PET_CONFIG.idleGraceMs);
    } else {
      clearTimeout(idleTimer ?? undefined);
      idleTimer = null;
      apply(activity);
    }
  };
  const onEvent = (event: FactsEvent): void => {
    updateFacts(facts, event);
    flush();
  };

  // heartbeat：每 5s 证明 extension 存活（不影响动画，不增加 revision）
  let heartbeatStarted = false;
  const ensureHeartbeat = (ctx: {
    setInterval?: (fn: () => void, ms: number) => unknown;
    sessionManager?: { getSessionId?: () => string };
  }): void => {
    const sid = ctx.sessionManager?.getSessionId?.();
    if (sid) sessionId = sid;
    if (heartbeatStarted || !ctx.setInterval) return;
    heartbeatStarted = true;
    ctx.setInterval(() => {
      if (pluginEnabled && interactive) writer.heartbeat();
    }, PET_CONFIG.heartbeatIntervalMs);
  };

  pi.on("session_start", (_event, ctx) => {
    applyCtx(ctx);
    ensureHeartbeat(ctx);
    // 跟随 omp：插件启用时每个会话开始都幂等拉起桌面端（单实例锁 + 节流）
    launcher.launch();
    // 初始快照：让桌面端立即可见本 session（facts 为空 → idle）
    flush();
  });
  pi.on("input", (_event, ctx) => {
    applyCtx(ctx);
    ensureHeartbeat(ctx);
    // 用户提交消息：清除 waiting，不强制覆盖仍活跃的 working（方案 §23）
    onEvent({ type: "user_input" });
  });
  pi.on("tool_call", (_event, ctx) => {
    applyCtx(ctx);
    ensureHeartbeat(ctx);
  });
  // ---- 生命周期事实（方案 4.2 事件映射表）----
  pi.on("agent_start", () => {
    onEvent({ type: "agent_start" });
  });
  pi.on("agent_end", (event) => {
    // willContinue=true（auto-retry/自动续跑）时不是真正收尾，跳过清理
    onEvent({ type: "agent_end", willContinue: event?.willContinue });
  });
  pi.on("turn_start", () => {
    onEvent({ type: "turn_start" });
  });
  pi.on("turn_end", () => {
    onEvent({ type: "turn_end" });
  });
  pi.on("tool_execution_start", (event) => {
    onEvent({ type: "tool_start", id: event.toolCallId, name: event.toolName });
  });
  pi.on("tool_execution_end", (event) => {
    onEvent({ type: "tool_end", id: event.toolCallId });
  });
  pi.on("tool_approval_requested", (event) => {
    onEvent({ type: "approval_requested", label: event.toolName ?? "工具审批" });
  });
  pi.on("tool_approval_resolved", () => {
    onEvent({ type: "approval_resolved" });
  });
  // OMP 内部忙碌（auto-retry / auto-compaction）：可用时监听（方案 §35），
  // 这些期间保持 RUNNING，不得出现瞬时 IDLE。
  pi.on("auto_retry_start", () => {
    onEvent({ type: "internal_busy_start" });
  });
  pi.on("auto_retry_end", () => {
    onEvent({ type: "internal_busy_end" });
  });
  pi.on("auto_compaction_start", () => {
    onEvent({ type: "internal_busy_start" });
  });
  pi.on("auto_compaction_end", () => {
    onEvent({ type: "internal_busy_end" });
  });
  pi.on("session_shutdown", () => {
    clearTimeout(idleTimer ?? undefined);
    // 方案 §31：正常 shutdown 删除自身快照文件（不写 closed）
    writer.close();
  });

  // 跟随 omp：扩展加载时（插件启用）即拉起桌面端；session_start 会再次幂等拉起
  if (pluginEnabled) launcher.launch();

  // 旧数据迁移（方案 §20）：migrationVersion<1 时读取旧 ~/.omp/agent/pets 的
  // pet.json lines → Global Config；只读旧目录，幂等，失败不影响会话。
  void migrateLegacyPets(configStore).catch((err) => {
    console.warn("[ompet] 旧配置迁移失败（不影响会话）：", err);
  });

  // 宠物面板命令：主命令 /ompet（唤醒宠物），/onmypet 为 V1 兼容别名（共享 handler）。
  // 面板已合并：主列表 = 宠物 + "设置"入口（/ompet settings 子命令已移除）；
  // 日常说话衔接：命令后的内容在面板关闭后放回输入框，回车即可发送——唤醒与对话互不打断。
  const petPanelHandler = async (
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> => {
    // 参数语义见 ./panel-command.ts：所有内容均为输入框衔接文本
    const { pendingText } = parsePanelCommandArgs(args);
    // 宠物发现：Codex ~/.codex/pets + OMPet ~/.omp/ompet/pets（损坏宠物跳过）
    const { pets, warnings } = discoverPets();
    if (pets.length === 0) {
      ctx.ui.notify(
        "未找到宠物包：请将宠物放入 ~/.codex/pets/ 或 ~/.omp/ompet/pets/（含 pet.json + spritesheet.webp）",
        "error",
      );
      return;
    }
    if (!ctx.hasUI) {
      const bundle = resolveActivePet(configStore.get().activePet, pets);
      ctx.ui.notify(
        bundle
          ? `宠物：${bundle.displayName}（${bundle.key}）`
          : "未找到可用宠物",
        "info",
      );
      return;
    }

    /** 打开主面板：宠物列表 + 设置入口（selectedKey 每次取最新 config） */
    const openPetPanel = (): Promise<string | undefined> =>
      ctx.ui.custom<string | undefined>((tui, _theme, _keybindings, done) => {
        return new PetPickerPanel({
          pets,
          selectedKey: configStore.get().activePet,
          done: (petKey) => done(petKey),
        });
      });

    /** 打开设置面板；关闭后同步插件开关（开 → 恢复发布并拉起桌面；关 → 暂停发布与心跳） */
    const openSettingsPanel = async (): Promise<void> => {
      await ctx.ui.custom<boolean | undefined>((tui, _theme, _keybindings, done) => {
        return new SettingsPanel({
          configStore,
          pets,
          activeKey: configStore.get().activePet,
          done: (changed) => done(changed),
        });
      });
      const nowEnabled = configStore.get().enabled;
      if (nowEnabled !== pluginEnabled) {
        pluginEnabled = nowEnabled;
        if (nowEnabled) {
          launcher.launch();
          writer.heartbeat();
          flush();
        } else {
          clearTimeout(idleTimer ?? undefined);
          idleTimer = null;
        }
      }
    };

    // 两级面板循环：主列表 → 选"设置" → 设置面板 → 返回主列表（ESC 才完全退出）
    let selection = await openPetPanel();
    while (selection === PET_PANEL_SETTINGS_ENTRY) {
      await openSettingsPanel();
      selection = await openPetPanel();
    }

    if (selection) {
      await configStore.setActivePet(selection as DiscoveredPet["key"]);
      const bundle = pets.find((p) => p.key === selection);
      ctx.ui.notify(`已选择宠物：${bundle?.displayName ?? selection}`, "info");
      // 选择变更 → config revision++ → 桌面端下一轮 poll 自动热更新（方案 §40）
    }

    // 发现过程中被跳过的损坏宠物（提示但不阻断）
    if (warnings.length > 0) {
      ctx.ui.notify(
        `已跳过 ${warnings.length} 个损坏宠物包：${warnings[0]!.key}（${warnings[0]!.reason}）`,
        "warning",
      );
    }

    // 日常说话衔接：面板关闭后，把命令参数放回输入框（可修改，回车即发送）
    if (pendingText.length > 0) {
      ctx.ui.setEditorText(pendingText);
    }
  };
  for (const commandName of PET_PANEL_COMMAND_NAMES) {
    pi.registerCommand(commandName, {
      description: "宠物列表与设置（列表内置设置入口）",
      handler: petPanelHandler,
    });
  }
}
