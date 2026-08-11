/**
 * 宠物引用（OMPet Architecture V2，方案 §7）。
 *
 * 禁止通过裸 petId 唯一标识宠物——两个来源目录可能存在同名宠物。
 * 序列化键格式：`<source>:<id>`，如 `codex:remilia`、`ompet:elaina`。
 */
export type PetSource = "codex" | "ompet";

export interface PetRef {
  source: PetSource;
  id: string;
}

/** 序列化键：`codex:remilia` / `ompet:elaina` */
export type PetKey = `${PetSource}:${string}`;

/** 拼接 PetKey（id 内允许含冒号） */
export function formatPetKey(source: PetSource, id: string): PetKey {
  return `${source}:${id}`;
}

/**
 * 解析 PetKey。
 * 返回 null 表示非法（来源未知或格式错误）。
 */
export function parsePetKey(key: string): PetRef | null {
  const match = /^(codex|ompet):(.+)$/.exec(key);
  if (!match) return null;
  return { source: match[1] as PetSource, id: match[2] ?? "" };
}
