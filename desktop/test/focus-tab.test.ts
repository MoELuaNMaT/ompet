import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const scriptPath = path.resolve(import.meta.dir, "../src-tauri/src/focus_tab.ps1");
const script = fs.readFileSync(scriptPath, "utf8");

describe("Windows Terminal 标签匹配脚本", () => {
  test("使用完整标题精确匹配，不使用项目名正则子串匹配", () => {
    expect(script).toContain("$t.Current.Name -eq $Title");
    expect(script).not.toContain("-match [regex]::Escape($Project)");
    expect(script).toContain('Write-Output "notabs"');
    expect(script).toContain('Write-Output "nomatch"');
  });
});
