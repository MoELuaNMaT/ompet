/**
 * PetKey 解析测试（方案 §65 Shared）。
 */
import { describe, expect, test } from "bun:test";
import {
  formatPetKey,
  parsePetKey,
  type PetKey,
} from "../src/pet-types.ts";

describe("PetKey parsing", () => {
  test("codex 来源", () => {
    expect(parsePetKey("codex:remilia")).toEqual({
      source: "codex",
      id: "remilia",
    });
  });

  test("ompet 来源", () => {
    expect(parsePetKey("ompet:elaina")).toEqual({
      source: "ompet",
      id: "elaina",
    });
  });

  test("id 内含冒号仍完整解析（贪婪取剩余）", () => {
    expect(parsePetKey("codex:my:pet")).toEqual({
      source: "codex",
      id: "my:pet",
    });
  });

  test("未知来源 → null", () => {
    expect(parsePetKey("other:remilia")).toBeNull();
  });

  test("缺少分隔符 → null", () => {
    expect(parsePetKey("remilia")).toBeNull();
  });

  test("空 id → null", () => {
    expect(parsePetKey("codex:")).toBeNull();
  });

  test("formatPetKey 与 parsePetKey 互逆", () => {
    const key = formatPetKey("codex", "remilia");
    expect(key).toBe("codex:remilia" satisfies PetKey);
    expect(parsePetKey(key)).toEqual({ source: "codex", id: "remilia" });
  });
});
