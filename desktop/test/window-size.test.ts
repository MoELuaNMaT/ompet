import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WINDOW_WIDTH,
  isCurrentWindowBoundsRequest,
  resolveInitialWindowWidth,
} from "../src/lib/window-size.ts";

describe("窗口初始尺寸", () => {
  test("优先使用 Tauri 恢复后的外部宽度，而不是覆盖为默认宽度", () => {
    expect(resolveInitialWindowWidth(360)).toBe(360);
  });

  test("外部宽度无效时回退到默认宽度", () => {
    expect(resolveInitialWindowWidth(0)).toBe(DEFAULT_WINDOW_WIDTH);
    expect(resolveInitialWindowWidth(-1)).toBe(DEFAULT_WINDOW_WIDTH);
    expect(resolveInitialWindowWidth(Number.NaN)).toBe(DEFAULT_WINDOW_WIDTH);
  });

  test("过期的布局请求不能覆盖后续缩放", () => {
    expect(isCurrentWindowBoundsRequest(1, 2, 240, 360)).toBe(false);
  });

  test("最新请求且宽度未变化时允许更新气泡布局高度", () => {
    expect(isCurrentWindowBoundsRequest(2, 2, 360, 360)).toBe(true);
  });

  test("宽度已被后续操作改变时拒绝旧布局请求", () => {
    expect(isCurrentWindowBoundsRequest(2, 2, 360, 400)).toBe(false);
  });
});
