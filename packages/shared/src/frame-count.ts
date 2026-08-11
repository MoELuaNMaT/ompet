/**
 * 每行有效帧数判定（跳过空白帧优化）。
 *
 * Codex 图集每行实际帧数不一：非空帧连续在行首，空白帧集中在行尾
 * （remilia/elaina 实测：行 0/6/7 为 6 帧、行 3 为 4 帧、行 4 为 5 帧）。
 * pet.json 的 rowFrames 声明与实际布局不可靠（remilia 实测 6 个互不相同的帧，
 * 声明却是 3；row4 是 5 帧 A-B-C-B-A 回环，声明 3），因此播放周期以
 * 像素检测的非空帧为准，不识别 Codex 声明（V2 原则：Codex 文件完全只读）。
 */

/** 单像素 alpha 超过该值视为不透明像素 */
export const FRAME_ALPHA_OPAQUE_THRESHOLD = 8;

/** 帧内不透明像素占比超过该值视为非空帧（实测空白 0.0% vs 非空 38%+，余量大） */
export const FRAME_NONEMPTY_RATIO_THRESHOLD = 0.005;

/**
 * 每行有效帧数 = 最后一个非空帧索引 + 1（假定空白帧位于行尾，Codex 布局约定）。
 * 全空行回退 1（防除零：播放器停在第 0 帧，等价现状画空白）。
 */
export function resolveFrameCounts(nonEmptyFlags: boolean[][]): number[] {
  return nonEmptyFlags.map((row) => {
    let lastNonEmpty = -1;
    for (let i = 0; i < row.length; i++) {
      if (row[i]) lastNonEmpty = i;
    }
    return lastNonEmpty === -1 ? 1 : lastNonEmpty + 1;
  });
}
