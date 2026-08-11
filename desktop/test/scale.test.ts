import { describe, expect, test } from "bun:test";
import {
  clampScaleWidth,
  FRAME_ASPECT_RATIO,
  MIN_WINDOW_WIDTH,
  scaleHeight,
} from "../src/lib/scale.ts";

describe("clampScaleWidth", () => {
  test("正常宽度原样返回（取整）", () => {
    expect(clampScaleWidth(300, 600)).toBe(300);
    expect(clampScaleWidth(300.6, 600)).toBe(301);
  });

  test("小于最小宽度时 clamp 到 120", () => {
    expect(clampScaleWidth(50, 600)).toBe(MIN_WINDOW_WIDTH);
    expect(clampScaleWidth(MIN_WINDOW_WIDTH - 1, 600)).toBe(MIN_WINDOW_WIDTH);
  });

  test("超过最大宽度时 clamp", () => {
    expect(clampScaleWidth(5000, 600)).toBe(600);
  });

  test("maxWidth 小于最小值时最小宽度优先", () => {
    expect(clampScaleWidth(100, 80)).toBe(MIN_WINDOW_WIDTH);
  });

  test("负值（鼠标越过锚点）clamp 到最小", () => {
    expect(clampScaleWidth(-30, 600)).toBe(MIN_WINDOW_WIDTH);
  });
});

describe("scaleHeight", () => {
  test("保持 192:208 比例", () => {
    expect(scaleHeight(300)).toBe(Math.round(300 * FRAME_ASPECT_RATIO)); // 325
    expect(scaleHeight(120)).toBe(130);
    expect(scaleHeight(600)).toBe(650);
  });

  test("结果取整", () => {
    expect(Number.isInteger(scaleHeight(250))).toBe(true);
  });
});
