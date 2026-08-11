/**
 * 旧数据迁移（Architecture V2，方案 §20）。
 *
 * 只运行 migrationVersion < 1：读取旧目录 ~/.omp/agent/pets/ 下各宠物的
 * pet.json `lines`（旧 row→enum 模型），转换为 Global Config 的
 * petOverrides[petKey].stateRows（state→row）。
 *
 * 规则：
 * - 只迁移五个正式状态（IDLE/RUNNING/WAITING/MOVE_LEFT/MOVE_RIGHT），
 *   其余（REVIEW/FAILED/WAVING/JUMPING/REVEAL）忽略；
 * - 旧宠物归属 ompet 来源（旧目录是 ompet 部署目录），key = ompet:<目录名>；
 * - 不删除旧文件、不修改旧 pet.json（方案 §20）；
 * - 幂等：migrationVersion=1 后不再运行（重复启动不重复迁移）。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  STATE_ROW_KEYS,
  type StateRowMap,
  type VisiblePetState,
} from "../../packages/shared/src/index.ts";
import type { ConfigStore } from "./config-store.ts";

/** 旧目录：~/.omp/agent/pets（方案 §8：仅 Migration 阶段读取） */
export function legacyPetsDir(): string {
  return path.join(os.homedir(), ".omp", "agent", "pets");
}

/** 旧枚举 → 五态映射（其余枚举忽略） */
const LEGACY_ENUM_TO_STATE: Record<string, VisiblePetState> = {
  IDLE: "IDLE",
  RUNNING: "RUNNING",
  WAITING: "WAITING",
  MOVE_LEFT: "MOVE_LEFT",
  MOVE_RIGHT: "MOVE_RIGHT",
};

/**
 * 转换旧 lines（row→enum）为 state→row 部分映射（纯函数）。
 * 非法行号/未知枚举忽略。
 */
export function convertLegacyLines(
  lines: Record<string, unknown>,
): Partial<StateRowMap> {
  const out: Partial<StateRowMap> = {};
  for (const [rowKey, enumName] of Object.entries(lines)) {
    const row = Number(rowKey);
    if (!Number.isInteger(row) || row < 0) continue;
    const state = typeof enumName === "string" ? LEGACY_ENUM_TO_STATE[enumName] : undefined;
    if (!state) continue;
    out[state] = row;
  }
  return out;
}

/**
 * 执行一次旧配置迁移（幂等；方案 §20）。
 * 只写 Global Config（ConfigStore），绝不触碰旧目录文件。
 * @param legacyRoot 旧宠物目录（测试注入；缺省 ~/.omp/agent/pets）
 */
export async function migrateLegacyPets(
  configStore: ConfigStore,
  legacyRoot: string = legacyPetsDir(),
): Promise<void> {
  if (configStore.get().migrationVersion >= 1) return;

  if (fs.existsSync(legacyRoot)) {
    for (const entry of fs.readdirSync(legacyRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(legacyRoot, entry.name, "pet.json");
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
          lines?: Record<string, unknown>;
        };
        if (typeof raw.lines !== "object" || raw.lines === null) continue;
        const stateRows = convertLegacyLines(raw.lines);
        if (Object.keys(stateRows).length === 0) continue;
        // 只迁移五个正式状态；其余忽略
        const key = `ompet:${entry.name}`;
        for (const state of STATE_ROW_KEYS) {
          const row = stateRows[state];
          if (typeof row === "number") {
            await configStore.setStateRow(key, state, row);
          }
        }
      } catch {
        // 单个损坏宠物包跳过（不阻断迁移，不阻断会话）
      }
    }
  }

  await configStore.markMigrated(1);
}
