/**
 * @ompet/shared —— OMPet 纯 TypeScript 契约包（Architecture V2，方案 §6）。
 *
 * browser-safe / host-safe：严禁依赖 node:fs / node:path / sharp /
 * Tauri API / OMP API / DOM / Canvas。只保存类型、常量、纯函数、协议定义。
 */
export * from "./activity.ts";
export * from "./visible-state.ts";
export * from "./pet-types.ts";
export * from "./codex-contract.ts";
export * from "./config-types.ts";
export * from "./frame-count.ts";
export * from "./snapshot-types.ts";
