/**
 * OMPet Global Config Store（Architecture V2，方案 §14–§17）。
 *
 * 路径：~/.omp/ompet/config.json（旧 ~/.omp/agent/pets/config.json 仅在 Migration 读取）。
 * Global Config 是宠物选择与状态行映射的唯一权威（方案 §36）：
 * 绝不允许把 activePet / state mapping / fps 写入 session snapshot。
 *
 * - revision：enabled / activePet / petOverrides 任一用户配置变化时 +1；
 *   新值与旧值完全相同 → 不得写盘、不得 revision++（方案 §17）；
 * - 原子写：tmp + rename（方案 §32 思想）；
 * - 写失败：记录 warning，不得 throw 到 OMP 主会话（方案 §68）。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createDefaultConfig,
  parsePetKey,
  STATE_ROW_KEYS,
  type OMPetConfig,
  type PetKey,
  type PetOverride,
  type VisiblePetState,
} from "../../packages/shared/src/index.ts";

/** 全局配置默认路径：~/.omp/ompet/config.json */
export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".omp", "ompet", "config.json");
}

/** 字段级校验并规范化原始 config（方案 §69：损坏/非法 → 默认或逐字段回退） */
export function sanitizeConfig(raw: unknown): OMPetConfig {
  if (typeof raw !== "object" || raw === null) return createDefaultConfig();
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== 1) return createDefaultConfig();

  const revision =
    typeof record.revision === "number" &&
    Number.isInteger(record.revision) &&
    record.revision >= 0
      ? record.revision
      : 0;
  const enabled = typeof record.enabled === "boolean" ? record.enabled : true;
  const activePet =
    typeof record.activePet === "string" && parsePetKey(record.activePet)
      ? (record.activePet as PetKey)
      : null;

  const petOverrides: Record<string, PetOverride> = {};
  if (typeof record.petOverrides === "object" && record.petOverrides !== null) {
    for (const [key, value] of Object.entries(record.petOverrides)) {
      if (!parsePetKey(key)) continue;
      petOverrides[key] = sanitizePetOverride(value);
    }
  }

  const migrationVersion =
    typeof record.migrationVersion === "number" &&
    Number.isInteger(record.migrationVersion) &&
    record.migrationVersion >= 0
      ? record.migrationVersion
      : 0;

  return {
    schemaVersion: 1,
    revision,
    enabled,
    activePet,
    petOverrides,
    migrationVersion,
  };
}

/** 校验单只宠物的 override（只保留合法字段；stateRows 只认五个正式状态） */
function sanitizePetOverride(raw: unknown): PetOverride {
  const override: PetOverride = {};
  if (typeof raw !== "object" || raw === null) return override;
  const record = raw as Record<string, unknown>;

  if (
    typeof record.fps === "number" &&
    record.fps > 0 &&
    record.fps <= 60 &&
    Number.isFinite(record.fps)
  ) {
    override.fps = record.fps;
  }

  if (typeof record.stateRows === "object" && record.stateRows !== null) {
    const rows = record.stateRows as Record<string, unknown>;
    const stateRows: Partial<OMPetConfig> & Record<string, number> = {};
    const valid: Partial<Record<VisiblePetState, number>> = {};
    for (const key of STATE_ROW_KEYS) {
      const value = rows[key];
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
        valid[key] = value;
      }
    }
    if (Object.keys(valid).length > 0) override.stateRows = valid;
  }
  return override;
}

export interface ConfigStoreOptions {
  /** 测试注入的配置文件路径（默认 ~/.omp/ompet/config.json） */
  configPath?: string;
}

/**
 * 全局配置读写器。构造时同步读盘缓存（与扩展同步初始化风格一致），
 * 对外接口保持方案 §16 的 Promise 契约。
 */
export class ConfigStore {
  private readonly configPath: string;
  private config: OMPetConfig;

  constructor(options?: ConfigStoreOptions) {
    this.configPath = options?.configPath ?? defaultConfigPath();
    this.config = this.readFromDisk();
  }

  /** 从磁盘读取并校验（失败 → 默认配置） */
  private readFromDisk(): OMPetConfig {
    try {
      const raw = JSON.parse(fs.readFileSync(this.configPath, "utf8")) as unknown;
      return sanitizeConfig(raw);
    } catch {
      return createDefaultConfig();
    }
  }

  /** 重新加载磁盘内容（外部修改后刷新；损坏 → 默认） */
  async load(): Promise<OMPetConfig> {
    this.config = this.readFromDisk();
    return this.config;
  }

  /** 当前内存配置 */
  get(): OMPetConfig {
    return this.config;
  }

  /** 启用/禁用插件（值相同 → 不写不 ++revision） */
  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.config.enabled) return;
    await this.commit({ ...this.config, enabled });
  }

  /** 设置当前宠物（PetKey，如 codex:remilia；值相同 → 不写不 ++revision） */
  async setActivePet(pet: PetKey): Promise<void> {
    if (pet === this.config.activePet) return;
    await this.commit({ ...this.config, activePet: pet });
  }

  /**
   * 设置某宠物的状态 → 行 映射（方案 §16）。
   * 仅接受五个正式状态；多个状态允许同一行（不互斥不抢占）。
   * 行号必须为非负整数（越界行由消费方按 layout 回退）。
   * 同值 → 不写不 ++revision。
   */
  async setStateRow(
    pet: PetKey,
    state: VisiblePetState,
    row: number,
  ): Promise<void> {
    if (!(STATE_ROW_KEYS as readonly string[]).includes(state)) {
      throw new Error(`setStateRow 仅接受五个正式状态：${String(state)}`);
    }
    if (!Number.isInteger(row) || row < 0) {
      throw new Error(`setStateRow 行号必须为非负整数：${String(row)}`);
    }
    const existing = this.config.petOverrides[pet];
    if (existing?.stateRows?.[state] === row) return;

    const stateRows: Partial<Record<VisiblePetState, number>> = {
      ...(existing?.stateRows ?? {}),
    };
    stateRows[state] = row;
    const override: PetOverride = { ...(existing ?? {}), stateRows };
    await this.commit({
      ...this.config,
      petOverrides: { ...this.config.petOverrides, [pet]: override },
    });
  }

  /** 重置某宠物的行映射 override（删除 override，不写默认值；默认由 resolveStateRows 提供） */
  async resetStateRows(pet: PetKey): Promise<void> {
    const existing = this.config.petOverrides[pet];
    if (!existing?.stateRows) return;

    const override: PetOverride = { ...existing };
    delete override.stateRows;
    const petOverrides = { ...this.config.petOverrides };
    if (Object.keys(override).length === 0) {
      delete petOverrides[pet];
    } else {
      petOverrides[pet] = override;
    }
    await this.commit({ ...this.config, petOverrides });
  }

  /**
   * 标记迁移版本（内部行为，不增加 revision——revision 只反映用户配置变化，
   * 方案 §17；迁移本身不触发 desktop reload）。
   */
  async markMigrated(version: number): Promise<void> {
    if (this.config.migrationVersion === version) return;
    await this.commit(
      { ...this.config, migrationVersion: version },
      { bumpRevision: false },
    );
  }

  /** revision++ 并原子写盘；写失败仅 warning，不 throw（方案 §68） */
  private async commit(
    next: OMPetConfig,
    options?: { bumpRevision?: boolean },
  ): Promise<void> {
    const bump = options?.bumpRevision ?? true;
    const config: OMPetConfig = bump
      ? { ...next, revision: next.revision + 1 }
      : next;
    this.config = config;
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      const tmpPath = `${this.configPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
      fs.renameSync(tmpPath, this.configPath);
    } catch (err) {
      console.warn("[ompet] 写全局配置失败（不影响会话）：", err);
    }
  }
}
