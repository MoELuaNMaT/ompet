/**
 * 每行有效帧数判定测试（跳过空白帧优化）。
 * 覆盖：非空连续在行首 → 有效帧数 = 最后一个非空帧索引 + 1；
 * 全空行回退 1；混合行矩阵逐行独立。
 */
import { describe, expect, test } from "bun:test";
import { resolveFrameCounts } from "../src/frame-count.ts";

describe("resolveFrameCounts", () => {
  test("非空帧连续在行首：有效帧数 = 最后一个非空帧索引 + 1", () => {
    // remilia row0 实测形态：6 帧非空 + 2 帧空白
    expect(resolveFrameCounts([[true, true, true, true, true, true, false, false]])).toEqual([6]);
    expect(resolveFrameCounts([[true, true, true, true, false, false, false, false]])).toEqual([4]);
    expect(resolveFrameCounts([[true, false, false, false, false, false, false, false]])).toEqual([1]);
  });

  test("全行 8 帧非空 → 8", () => {
    expect(
      resolveFrameCounts([[true, true, true, true, true, true, true, true]]),
    ).toEqual([8]);
  });

  test("全空行 → 回退 1（防除零）", () => {
    expect(
      resolveFrameCounts([[false, false, false, false, false, false, false, false]]),
    ).toEqual([1]);
  });

  test("多行矩阵逐行独立（remilia 实测形态）", () => {
    const flags = [
      [true, true, true, true, true, true, false, false], // 6
      [true, true, true, true, true, true, true, true], // 8
      [true, true, true, true, false, false, false, false], // 4
      [true, true, true, true, true, false, false, false], // 5
    ];
    expect(resolveFrameCounts(flags)).toEqual([6, 8, 4, 5]);
  });

  test("空行数组 → 空结果", () => {
    expect(resolveFrameCounts([])).toEqual([]);
  });
});
