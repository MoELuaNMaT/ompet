/**
 * 桌面端生命周期启动器：让宠物跟随 omp 自动启停（项目设计）。
 *
 * 规则：
 * - 插件启用时，扩展在加载/session_start/插件切换开启时幂等拉起桌面端
 *   （桌面端有单实例锁：重复 spawn 的新进程自动退出并聚焦已有窗口）；
 * - 插件未启用（config.enabled=false）时不启动；
 * - 桌面端退出不由扩展直接杀进程，而是由桌面端自身在"所有 session 均无效
 *   持续 60s"后自动退出（多 omp 实例天然协调，无需跨进程通信）。
 *
 * Architecture V2：enabled 来自 Global Config（ConfigStore）；
 * exe 默认部署在扩展目录根（二进制与用户数据分离，方案 §12）——
 * bundle 后 import.meta.dir 指向 dist/，上层即扩展目录根。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

/** 桌面端可执行文件默认位置：扩展目录根（build-extension.ts 部署） */
export function defaultDesktopExePath(): string {
  return path.join(import.meta.dir, "..", "ompet-desktop.exe");
}

export interface DesktopLauncherOptions {
  /** 读取最新启用状态（settings 面板可能运行期修改 enabled） */
  getConfig: () => { enabled: boolean };
  /** exe 路径注入（测试用；缺省固定部署位置） */
  exePath?: string;
  /** spawn 注入（测试用；缺省 node:child_process spawn） */
  spawnFn?: typeof spawn;
}

/** spawn 节流：同一事件风暴（多 session_start）内不重复拉起 */
const LAUNCH_THROTTLE_MS = 10_000;

export class DesktopLauncher {
  private getConfig: () => { enabled: boolean };
  private exePath: string;
  private spawnFn: typeof spawn;
  private lastLaunchAt = 0;

  constructor(options: DesktopLauncherOptions) {
    this.getConfig = options.getConfig;
    this.exePath = options.exePath ?? defaultDesktopExePath();
    this.spawnFn = options.spawnFn ?? spawn;
  }

  /** 是否应启动桌面（插件启用 + exe 存在） */
  private shouldLaunch(): boolean {
    if (!this.getConfig().enabled) return false;
    return fs.existsSync(this.exePath);
  }

  /**
   * 幂等拉起桌面端（可重复调用：单实例锁 + 节流双重保护）。
   * exe 缺失（未构建/未部署）时仅告警，不阻断会话。
   */
  launch(): void {
    if (!this.shouldLaunch()) return;
    const now = Date.now();
    if (now - this.lastLaunchAt < LAUNCH_THROTTLE_MS) return;
    this.lastLaunchAt = now;
    try {
      // detached：桌面端独立于 omp 进程存活（omp 退出后由桌面端自身超时退出）
      const child = this.spawnFn(this.exePath, [], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    } catch (err) {
      console.warn("[ompet] 桌面端启动失败：", err);
    }
  }
}
