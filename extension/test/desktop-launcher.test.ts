/**
 * 桌面启动器单测：enabled 门控、exe 缺失告警、幂等节流、注入 spawn。
 * 覆盖项目设计：插件开启 → 跟随 omp 拉起桌面；插件关闭 → 不拉起。
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DesktopLauncher } from "../src/desktop-launcher.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ompet-launch-"));
const fakeExe = path.join(TMP, "ompet-desktop.exe");
fs.writeFileSync(fakeExe, "");

function makeLauncher(enabled = true, exePath = fakeExe) {
  const calls: string[] = [];
  const launcher = new DesktopLauncher({
    getConfig: () => ({ enabled }),
    exePath,
    spawnFn: ((exe: string) => {
      calls.push(exe);
      // 最小假 child：unref 存在即可
      return { unref: () => {} } as ReturnType<typeof import("node:child_process").spawn>;
    }) as never,
  });
  return { launcher, calls };
}

describe("DesktopLauncher", () => {
  test("插件启用 + exe 存在 → 拉起桌面", () => {
    const { launcher, calls } = makeLauncher();
    launcher.launch();
    expect(calls).toEqual([fakeExe]);
  });

  test("插件关闭（enabled=false）→ 不拉起", () => {
    const { launcher, calls } = makeLauncher(false);
    launcher.launch();
    expect(calls).toEqual([]);
  });

  test("exe 不存在 → 不拉起（不报错）", () => {
    const { launcher, calls } = makeLauncher(true, path.join(TMP, "missing.exe"));
    launcher.launch();
    expect(calls).toEqual([]);
  });

  test("节流：10s 内重复 launch 只拉起一次（多 session_start 幂等）", () => {
    const { launcher, calls } = makeLauncher();
    launcher.launch();
    launcher.launch();
    launcher.launch();
    expect(calls).toHaveLength(1);
  });

  test("超过节流窗口后可再次拉起（重启桌面兜底）", () => {
    const { launcher, calls } = makeLauncher();
    launcher.launch();
    // 模拟时间流逝：直接改 lastLaunchAt 为 11s 前
    (launcher as unknown as { lastLaunchAt: number }).lastLaunchAt = Date.now() - 11_000;
    launcher.launch();
    expect(calls).toHaveLength(2);
  });
});
