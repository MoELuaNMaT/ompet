/**
 * 桌面悬浮宠物（Architecture V2）：每 500ms 读取 read_runtime_state
 * （Global Config + session 快照），业务状态（idle/working/waiting）+
 * 本地移动状态（none/left/right）→ resolveVisibleState 合成五种可见动画，
 * SpriteAnimator 用 Canvas 直绘 spritesheet 纯循环播放（无 sharp、无帧缓存）。
 *
 * 分层职责：
 * - session 选择：heartbeat 有效 + updatedAt 最新 + 粘性（lib/session.ts）；
 * - 移动状态：拖拽驱动（lib/movement.ts），仅 idle 时显示 move 动画；
 * - 宠物：PetLoader 按 PetKey 加载（read_pet_bundle + 尺寸校验 + stateRows）；
 * - config 热更新：revision 变化 → activePet 变才重新加载，仅行映射变只更新映射。
 */
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import {
  PET_CONFIG,
  resolveStateRows,
  resolveVisibleState,
  type Activity,
  type PetOverride,
} from "../../packages/shared/src/index.ts";
import { decodeSnapshotId, isInvalid, parseSnapshot, selectSession, shouldExitDesktop, type Snapshot } from "./lib/session.ts";
import { MovementController } from "./lib/movement.ts";
import { PetLoader, type LoadedPet } from "./lib/pet-loader.ts";
import { SpriteAnimator } from "./lib/sprite-animator.ts";
import { clampScaleWidth, DEFAULT_MAX_WINDOW_WIDTH, MIN_WINDOW_WIDTH, scaleHeight } from "./lib/scale.ts";
import {
  DEFAULT_WINDOW_WIDTH,
  isCurrentWindowBoundsRequest,
  resolveInitialWindowWidth,
} from "./lib/window-size.ts";
import {
  aggregateActivity,
  bubbleStatus,
  DONE_DURATION_MS,
  pointInExpandZone,
  pointInRect,
  STATUS_LABEL,
  type BubbleStatus,
} from "./lib/bubbles.ts";
import { syncBubbleAppearance } from "./lib/bubble-visual.ts";

const canvas = document.getElementById("pet") as HTMLCanvasElement;
const bubblesEl = document.getElementById("bubbles") as HTMLDivElement;
const shelfEl = document.getElementById("bubble-shelf") as HTMLDivElement;
const expandedEl = document.getElementById("bubble-expanded") as HTMLDivElement;

/** 宠物加载与播放（新渲染器：Canvas 直绘 spritesheet） */
const loader = new PetLoader();
const animator = new SpriteAnimator(canvas);

// canvas 无 width/height 属性时后备缓冲区为 HTML 默认 300×150，与 192:208 显示盒比例不符，
// drawImage 会被非等比拉伸（变形）且超出窗口被裁切；此处按 CSS 显示盒尺寸（×devicePixelRatio，
// 保证高分屏整数倍像素放大）同步缓冲区，且随窗口/缩放变化更新。
// 注意：给 canvas.width/height 赋值会清空画布（即使值相同）——尺寸未变化时跳过，
// 变化时重置后立即重绘当前帧，避免 resize 到下一次 125ms tick 之间的空白闪烁。
// animator 必须先于 syncCanvasBuffer() 初始化（render 依赖它）。
function syncCanvasBuffer(): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width === w && canvas.height === h) return;
  canvas.width = w;
  canvas.height = h;
  animator.render();
}
syncCanvasBuffer();
window.addEventListener("resize", syncCanvasBuffer);

let loadedPet: LoadedPet | null = null;
let lastPetKey = "";
/** 气泡元素：sessionId → 元素（renderBubbles diff 维护） */
const bubbleEls = new Map<string, HTMLDivElement>();
/** 缩略占位 slot：sessionId → 固定触发区（hover 检测挂在这里，不随气泡移动） */
const slotEls = new Map<string, HTMLDivElement>();
/** 当前展开到预留行的会话（排他：同一时刻最多一个） */
let expandedSessionId: string | null = null;
/** 收回防抖 timer（reevaluateExpanded 下降沿设置一次；鼠标回热区立即清除） */
let collapseTimer: number | null = null;
/**
 * 正在 morph 的会话 → 代次 token（renderBubbles 据此跳过形态类/归属重设，由 morph 全权控制）。
 * 覆盖展开全程——阶段 1 下移期保持 orb，阶段 2 morphExpand 起接管，收尾清除。
 * token 保证：排他切换时 A/B 并发 morph 互不干扰（Map 按会话隔离），
 * 且被后续 morph 接管的收尾定时器不会误清新 morph 的样式（代次校验）。
 */
const morphLocks = new Map<string, number>();
/** 展开触发宽限复查 timer（tryExpand 设置；带外 mouseleave 取消） */
const graceTimers = new Map<string, number>();
/** mousemove 驱动的 enter 候选 slot（去抖期内最近 slot；reparent 不影响——只跟鼠标位置） */
let pendingEnterId: string | null = null;
/** pendingEnterId 的去抖 timer（ENTER_DEBOUNCE_MS 后调 tryExpand；最近 slot 变化时重置） */
let pendingEnterTimer: number | null = null;
let morphSeq = 0;

/** 窗口级指针操作（拖拽/缩放）进行中 → 冻结气泡 hover。
 *  拖拽/缩放移动窗口时热区 bbox 随窗口屏幕位置漂移（getBoundingClientRect 为 viewport 坐标，
 *  窗口移动不改 DOM 布局故 slot bbox 不变，但鼠标 client 坐标随手位移变化），会误判进出热区。
 *  进行中冻结所有 hover 触发/评估，杜绝漂移误触发。 */
function isPointerBusy(): boolean {
  return dragging || scaling;
}

/** 拖拽/缩放开始时立即收回展开气泡 + 清空全部 hover timer（冻结入态清理）。 */
function freezeHover(): void {
  if (expandedSessionId) collapseBubble(expandedSessionId);
  if (collapseTimer !== null) { clearTimeout(collapseTimer); collapseTimer = null; }
  pendingEnterId = null;
  if (pendingEnterTimer !== null) { clearTimeout(pendingEnterTimer); pendingEnterTimer = null; }
  for (const [id, t] of graceTimers) { clearTimeout(t); graceTimers.delete(id); }
}
/** 最近一次鼠标位置（client 坐标；window mousemove 跟踪，供热区判定复查） */
let lastMouse: { x: number; y: number } = { x: 0, y: 0 };

// ---- 气泡展开/收回动画与判定常量（统一调手感只改这里）----
const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";   // ease-out-quint，展开用
const EASE_IN = "cubic-bezier(0.4, 0, 1, 1)";        // ease-in，收回用
const EXPAND_MOVE_MS = 220;          // 圆球下移时长
const MORPH_EXPAND_MS = 220;         // 圆→胶囊宽度展开
const TEXT_FADE_IN_MS = 160;         // 文字淡入
const TEXT_FADE_DELAY_MS = 100;      // 文字淡入延迟（宽度展开近半）
const MORPH_COLLAPSE_MS = 130;       // 胶囊→圆宽度收缩
const TEXT_FADE_OUT_MS = 100;        // 文字淡出
const COLLAPSE_MOVE_MS = 100;        // 圆球上移时长
const COLLAPSE_DEBOUNCE_MS = 150;    // 收回防抖（下移动画 220ms 的复查余量）
const ENTER_DEBOUNCE_MS = 150;       // 展开触发去抖（鼠标在 slot 元素内停留时长）
const TRIGGER_GRACE_MS = 100;        // 去抖到期复查：鼠标在带内元素外（手抖跨出）时的宽限窗口
/** slot 热区容差：覆盖相邻 slot 间距（34px）与「缓慢移动+手抖」的自然活动范围，
 *  避免鼠标在 slot 边缘反复跨越热区边界造成 展开-收回 往返抖动 */
const SLOT_PAD_PX = 24;

/**
 * 鼠标是否在展开热区内（三者并集）：
 * ① slot 矩形（含 10px 容差）——下移早期鼠标仍在触发点，稳定保持；
 * ② 热区矩形（含 10px 容差）——**动画进行中（morph 锁未清）放宽为整行容器**，
 *    展开动画（下移 220ms + morph 220ms）期间移动中的鼠标/提前下移到位不会被
 *    中途收窄的实时 bbox 误判移出而收回（容器覆盖整行，原版行为）；
 *    **动画完成（锁清除）后收窄为气泡实时视觉矩形**——消除「行内空白误保持」
 *    （容器远大于气泡视觉范围），同时覆盖 morph 宽度过渡与胶囊溢出部分
 *    （消除悬停自缩）；
 * ③ slot 中心 → 预留行底边的三角形——覆盖 slot 与预留行之间的过渡带/间隙，
 *    底边保留整行，保证「鼠标提前下移到展开位置等待」时稳定命中。
 * 展开中的气泡在预留行（parentElement 校验）时才有判定区；否则 false（应收回）。
 */
function mouseInExpandZone(sessionId: string): boolean {
  const bubble = bubbleEls.get(sessionId);
  const slot = slotEls.get(sessionId);
  if (!bubble || !slot || bubble.parentElement !== expandedEl) return false;
  const e = expandedEl.getBoundingClientRect();
  // 动画中（含阶段 1 下移 + morphExpand 全程 + 收尾清理期）用整行容器做热区②：
  // 移动中的鼠标/提前到位等待在动画期间稳定命中；动画完成（morph 锁清除）后
  // 用气泡实时 bbox（含 morph 宽度过渡与胶囊溢出部分），热区跟随视觉范围
  const zoneBubble = morphLocks.has(sessionId) ? e : bubble.getBoundingClientRect();
  // slotPad 独立放大：slot 行上的缓慢移动/手抖不脱离热区（展开后鼠标从 slot 向旁
  // 侧移动仍保持，直至真正离开交互带）；②③ 仍用 10px 容差避免「该收不收」回潮
  return pointInExpandZone(lastMouse, slot.getBoundingClientRect(), zoneBubble, e, 10, SLOT_PAD_PX);
}

/** 鼠标是否在 slot 元素矩形内（含 pad 容差带） */
function mouseInSlotPad(sessionId: string, p: { x: number; y: number } = lastMouse): boolean {
  const slot = slotEls.get(sessionId);
  return !!slot && pointInRect(p, slot.getBoundingClientRect(), SLOT_PAD_PX);
}

/** 鼠标是否在 slot 元素矩形内（不含容差） */
function mouseInSlot(sessionId: string, p: { x: number; y: number } = lastMouse): boolean {
  const slot = slotEls.get(sessionId);
  return !!slot && pointInRect(p, slot.getBoundingClientRect());
}

/**
 * 该 slot 是否为鼠标所在的所有 slot（含扩展带）中中心最近的。
 * 相邻 slot 扩展带重叠（间距 34 < SLOT_PAD_PX×2），鼠标在重叠区时只对最近的
 * slot 触发——避免「划过 A 停在 B」时 A 的残留去抖抢先展开造成闪烁。
 */
function isNearestSlot(sessionId: string, p: { x: number; y: number }): boolean {
  let best: string | null = null;
  let bestD = Infinity;
  for (const [id, el] of slotEls) {
    if (el.style.display === "none") continue;
    const r = el.getBoundingClientRect();
    const d = (p.x - (r.x + r.width / 2)) ** 2 + (p.y - (r.y + r.height / 2)) ** 2;
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best === sessionId;
}

/** 鼠标在 SLOT_PAD_PX 容差带内时，返回距鼠标中心最近的 slot 的 sessionId（无则 null）。
 *  取代 slot.mouseenter 触发：mousemove 驱动，不受 reparent 合成事件干扰。 */
function nearestSlotInPad(p: { x: number; y: number } = lastMouse): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const [id, el] of slotEls) {
    if (el.style.display === "none") continue;
    const r = el.getBoundingClientRect();
    if (pointInRect(p, r, SLOT_PAD_PX)) {
      const d = (p.x - (r.x + r.width / 2)) ** 2 + (p.y - (r.y + r.height / 2)) ** 2;
      if (d < bestD) { bestD = d; best = id; }
    }
  }
  return best;
}

/**
 * 展开触发复查（enter 去抖到期后调用）：按鼠标实时位置决定是否展开。
 * - 鼠标在 slot 元素内 → 展开（正常 hover）；
 * - 在扩展带内但元素外（手抖跨出边界瞬间）→ 短宽限等鼠标回来，宽限到期仍在带内
 *   且该 slot 最近 → 展开（否则放弃）；
 * - 已完全离开带 / 非最近 slot → 放弃（划过、快速划过、相邻气泡停留）。
 * 展开后（expandedSessionId 已设置）幂等 return。
 */
function tryExpand(sessionId: string): void {
  if (expandedSessionId === sessionId) return;
  if (isPointerBusy()) return; // 拖拽/缩放进行中：冻结 hover，等鼠标真实 hover 驱动
  const p = lastMouse;
  if (!mouseInSlotPad(sessionId, p)) return; // 已完全离开带 → 放弃
  if (mouseInSlot(sessionId, p)) {
    expandBubble(sessionId);
    return;
  }
  if (!isNearestSlot(sessionId, p)) return; // 相邻气泡上停留 → 放弃（防抢先展开闪烁）
  if (!slotEls.has(sessionId)) return;
  // 带内元素外：手抖中，给短宽限等鼠标回元素
  const t = window.setTimeout(() => {
    graceTimers.delete(sessionId);
    if (expandedSessionId === sessionId) return;
    if (mouseInSlotPad(sessionId, lastMouse) && isNearestSlot(sessionId, lastMouse)) {
      expandBubble(sessionId);
    }
  }, TRIGGER_GRACE_MS);
  graceTimers.set(sessionId, t);
}

/**
 * 外部工具抢走焦点、页面被隐藏或鼠标离开窗口时，统一清理悬浮状态。
 * 这些场景可能中断 mousemove/mouseleave 事件流，必须丢弃失焦前残留的鼠标位置和 hover timer，
 * 否则展开胶囊会一直等待一个永远不会到来的下一次鼠标移动。
 */
function resetHoverOnInputInterruption(): void {
  cancelPointerInteraction();
  freezeHover();
}

window.addEventListener("mousemove", (e) => {
  lastMouse = { x: e.clientX, y: e.clientY };
  // hover 统一评估（触发 + 保持）：纯 mousemove 驱动，不依赖 DOM enter/leave。
  // 已展开 → reevaluateExpanded（热区保持/下降沿防抖收回）；未展开 → 最近 slot 去抖触发。
  // reparent 产生的合成事件无监听器，无法 corrupt 状态。
  evaluateHover();
});
// 鼠标离开窗口（移到桌面/其他窗口）→ 收回并清理悬浮 timer。
window.addEventListener("mouseleave", resetHoverOnInputInterruption);
// 截图工具等外部窗口抢走焦点时，DOM 可能收不到后续 mouseleave → 主动收回。
window.addEventListener("blur", resetHoverOnInputInterruption);
// 某些窗口切换只触发页面隐藏，不一定触发 blur → 用 visibilitychange 再兜底。
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") resetHoverOnInputInterruption();
});

/**
 * 统一收回评估：在热区内 → 取消收回；移出热区 → 下降沿设一次防抖 timer。
 * collapseTimer === null 守卫保证下降沿只设一次 timer（避免 mousemove 高频重置
 * 导致永不收回）；鼠标移回热区立即清 timer。
 */
function reevaluateExpanded(): void {
  if (isPointerBusy()) return; // 拖拽/缩放进行中：冻结评估（热区随窗口漂移，不复查）
  if (!expandedSessionId) return;
  if (mouseInExpandZone(expandedSessionId)) {
    if (collapseTimer !== null) {
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }
  } else if (collapseTimer === null) {
    collapseTimer = window.setTimeout(() => {
      collapseTimer = null;
      if (expandedSessionId && !mouseInExpandZone(expandedSessionId)) {
        collapseBubble(expandedSessionId);
      }
    }, COLLAPSE_DEBOUNCE_MS);
  }
}

/** mousemove 驱动的 hover 统一评估（取代 slot/bubble 的 DOM enter/leave 触发）。
 *  - 每次先按鼠标位置同步「最近 slot」候选（reparent 不影响——只跟鼠标位置），
 *    候选变化时重置去抖（含置 null：离开所有带即取消）；
 *  - 已展开 → 复用 reevaluateExpanded（热区保持/下降沿防抖收回）；鼠标移到其他 slot
 *    带内时去抖照常进行，到期走 tryExpand 排他切换（与旧 mouseenter 触发语义一致）；
 *  - 未展开 → 候选存在且无去抖计时中 → 起去抖，到期调 tryExpand（已展开幂等）。
 *  reparent 产生的合成事件无监听器，无法 corrupt 状态。 */
function evaluateHover(): void {
  if (isPointerBusy()) return;
  const target = nearestSlotInPad();
  if (target !== pendingEnterId) {
    pendingEnterId = target;
    if (pendingEnterTimer !== null) { clearTimeout(pendingEnterTimer); pendingEnterTimer = null; }
  }
  if (expandedSessionId) {
    reevaluateExpanded(); // 展开保持/下降沿防抖收回
    if (pendingEnterId === expandedSessionId) return; // 保持自身时不重复 arm（tryExpand 幂等，避免无谓 timer）
  }
  if (pendingEnterTimer === null && pendingEnterId !== null) {
    const t = pendingEnterId;
    pendingEnterTimer = window.setTimeout(() => {
      pendingEnterTimer = null;
      if (pendingEnterId === t) tryExpand(t);
    }, ENTER_DEBOUNCE_MS);
  }
}
/** 会话跟踪：前次 activity（done 转换检测）+ doneAt + pid/project */
const sessionState = new Map<
  string,
  {
    prevActivity: Activity | undefined;
    doneAt: number | null;
    pid: number;
    project: string;
    terminalTitle: string;
  }
>();
/** 会话最后有效时刻（invalid 迟滞保留用：文件仍在但 heartbeat 停摆时不清除气泡） */
const lastSeenAt = new Map<string, number>();
/** stale 会话气泡保留时长：吸收 heartbeat 停摆/恢复抖动（进程退出=文件消失，立即移除不走此迟滞） */
const INVALID_GRACE_MS = 30_000;
/** 宠物本体点击聚焦目标（粘性：沿用 selectSession） */
let primarySnapshot: Snapshot | null = null;
/** 宠物本体动画来源（聚合：waiting > working > idle） */
let aggregateAct: Activity = "idle";
/** 上次实测的气泡区高度（窗口高度 = 宠物高 + 气泡高 + gap） */
let cachedBubblesHeight = 0;
/** 本地跟踪的窗口宽度；首次轮询前从 Tauri 读取启动时恢复后的真实宽度。 */
let lastWindowWidth = DEFAULT_WINDOW_WIDTH;
/** 用户已经在本次运行中主动缩放过，启动读取结果不能覆盖这次操作。 */
let windowWidthUserAdjusted = false;
/** 窗口布局异步读取的代次；新缩放/布局请求会使旧结果失效。 */
let windowBoundsRequestId = 0;
/** 等待 Tauri setup 恢复窗口尺寸后再进行首轮布局重算。 */
const initialWindowWidthReady = (async () => {
  try {
    const size = await getCurrentWindow().outerSize();
    if (!windowWidthUserAdjusted) {
      lastWindowWidth = resolveInitialWindowWidth(size.width);
    }
  } catch {
    // 读取失败时保留与 tauri.conf 一致的默认宽度，不阻断桌面轮询。
  }
})();
/**
 * 窗口顶部余量：窗口高度 = 宠物高 + 气泡区高（含发光 padding）+ 该值。
 * 注意它不是气泡与宠物的间距——bubbles 以 bottom:100% 锚定宠物顶部，
 * 气泡与宠物的真实间距由 styles.css #bubbles 的 padding-bottom 提供。
 */
const BUBBLE_GAP_PX = 6;
/** 当前显示记录的 omp 进程 pid（宠物本体单击聚焦终端用） */
let currentPid = 0;
/** 当前显示记录的项目名（标签切换匹配用） */
let currentProject = "";
/** 当前显示记录的会话级终端标题（旧快照为空时 Rust 回退项目名） */
let currentTerminalTitle = "";
/** 本地移动控制器（拖拽驱动；业务状态转 working/waiting 时取消） */
const movement = new MovementController();

// ---- 拖拽（手动实现，不用系统 data-tauri-drag-region）----
// 系统拖拽在 mousedown 立即开始并吞掉 click 事件（整窗都是拖拽区时点击永远失效），
// 改为 pointer 事件手动移动窗口：按下记录起点，移动时 setPosition 跟随。
// 拖拽方向（相对上一帧增量，8px 滞回）驱动 MovementController → resolveVisibleState；
// 位移超过阈值视为拖拽，抬起时抑制随后的 click（单击才聚焦终端，拖拽松手不触发）。
//
// 注意：outerPosition() 是异步 IPC，按下后到返回之间有窗口期；期间移动若被丢弃
// 会导致"拖拽无反应"，且 dragged 不置位 → 松手误触发 click（聚焦终端/弹窗）。
// 因此位移判定独立于 dragWinPos：移动先缓存，位置就绪后补算；超阈值即算拖拽。
const DRAG_THRESHOLD_PX = 4;
let dragging = false;
let dragStart: { x: number; y: number } | null = null;
let dragWinPos: { x: number; y: number } | null = null;
/** 上一次 pointermove 位置（方向判定基准 = 相对上一帧，非拖拽起点） */
let lastDragPos: { x: number; y: number } | null = null;
/** outerPosition 未返回期间缓存的最近一次移动（就绪后补算，避免丢帧） */
let pendingDragPos: { x: number; y: number } | null = null;
let dragged = false;
let suppressClick = false;

document.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  dragging = true;
  // 拖拽开始：立即收回展开气泡并冻结 hover（热区随窗口移动漂移，进行中禁止误触发）
  freezeHover();
  dragged = false;
  dragStart = { x: e.screenX, y: e.screenY };
  lastDragPos = null;
  pendingDragPos = null;
  // 捕获指针：快速拖拽移出窗口后仍持续收到 move
  document.body.setPointerCapture?.(e.pointerId);
  void getCurrentWindow()
    .outerPosition()
    .then((p) => {
      dragWinPos = { x: p.x, y: p.y };
      // 竞态窗口期内的移动已缓存：位置就绪后按按下起点补算一次
      if (dragStart && pendingDragPos) {
        applyDragMove(pendingDragPos);
        pendingDragPos = null;
      }
    })
    .catch(() => {
      // outerPosition 失败（IPC 异常）：放弃本次拖拽（后续 move 因 dragStart 置空直接返回）
      dragStart = null;
      pendingDragPos = null;
    });
});

/** 应用一次拖拽移动（相对按下起点的累计位移） */
function applyDragMove(pos: { screenX: number; screenY: number }): void {
  if (!dragStart) return;
  // 位移判定独立于窗口是否已实际移动：outerPosition 未返回时超阈值同样算拖拽，
  // 保证松手时抑制 click（否则拖拽会误触发聚焦终端）
  const dx = pos.screenX - dragStart.x;
  const dy = pos.screenY - dragStart.y;
  if (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX) {
    dragged = true;
  }
  if (!dragWinPos) {
    // 窗口位置尚未就绪：缓存本次移动，等 outerPosition 返回后补算
    pendingDragPos = { x: pos.screenX, y: pos.screenY };
    return;
  }
  // 方向判定：相对上一帧位置的增量（跨过滞回阈值才切换，避免左右抖动）
  const prevX = lastDragPos?.x ?? dragStart.x;
  const deltaX = pos.screenX - prevX;
  movement.updateDrag(deltaX, Date.now());
  lastDragPos = { x: pos.screenX, y: pos.screenY };
  void getCurrentWindow().setPosition(new PhysicalPosition(dragWinPos.x + dx, dragWinPos.y + dy));
  refreshVisibleAnimation();
}

document.addEventListener("pointermove", (e) => {
  if (!dragStart) return;
  applyDragMove(e);
});
window.addEventListener("pointerup", () => {
  dragging = false;
  dragStart = null;
  dragWinPos = null;
  lastDragPos = null;
  pendingDragPos = null;
  movement.endDrag();
  refreshVisibleAnimation();
  // 拖拽结束：强制保存最终窗口状态（Rust 侧 Moved 事件为节流写，此处兜底精确值）
  void invoke("save_window_state");
  // 拖拽后的抬起：抑制紧随的 click（单击才聚焦终端）
  if (dragged) {
    suppressClick = true;
    setTimeout(() => {
      suppressClick = false;
    }, 600);
  }
  // 拖拽/缩放期间窗口布局可能已变（尺寸联动/热区漂移），且无 mousemove 复查 →
  // 主动复查一次：鼠标在热区保持，不在则按防抖收回（防悬挂/误保持）
  reevaluateExpanded();
});

// ---- 缩放拖拽（左上角手柄，锁定 192:208 帧比例）----
// 按住手柄拖拽改变宠物视窗尺寸；锚点 = 窗口右下角。缩放方向以锚点为基准的距离语义：
// 宽度 = 锚点x − 鼠标x（鼠标远离锚点 → 放大，靠近锚点 → 缩小），随后
// setPosition(锚点 − 新尺寸) 保持右下角固定。outerSize/outerPosition 是异步 IPC，
// 与窗口拖拽同样处理：未返回期间缓存移动，就绪后补算。
const scaleHandle = document.getElementById("scale-handle") as HTMLDivElement;
let scaling = false;
/** 缩放会话标记（非 null 表示进行中；锚点就绪前也用于判活） */
let scaleStart: { x: number } | null = null;
/** 右下角锚点（屏幕坐标，pointerdown 时由 outerPosition + outerSize 确定） */
let scaleAnchorRight = 0;
let scaleAnchorBottom = 0;
let scaleMaxWidth = DEFAULT_MAX_WINDOW_WIDTH;
/** 锚点未确定期间缓存的最近一次拖拽位置（就绪后补算） */
let pendingScaleMove: { x: number } | null = null;

/**
 * 终止失去焦点或指针捕获的拖拽/缩放会话，避免收不到 pointerup 后永久卡在 busy 状态。
 * 已完成的窗口移动/缩放仍保留最后一次系统状态，并抑制可能迟到的 click。
 */
function cancelPointerInteraction(): void {
  const wasDragging = dragging;
  const wasScaling = scaling;
  if (!wasDragging && !wasScaling) return;

  dragging = false;
  scaling = false;
  dragStart = null;
  dragWinPos = null;
  lastDragPos = null;
  pendingDragPos = null;
  scaleStart = null;
  pendingScaleMove = null;
  dragged = false;
  if (wasDragging) movement.endDrag();
  refreshVisibleAnimation();
  void invoke("save_window_state");
  suppressClick = true;
  setTimeout(() => {
    suppressClick = false;
  }, 600);
}

// 指针捕获被系统取消时同样收口，覆盖窗口切换、截图工具和系统手势打断。
window.addEventListener("pointercancel", resetHoverOnInputInterruption);
window.addEventListener("lostpointercapture", resetHoverOnInputInterruption);

/** 应用一次缩放移动：宽度 = 锚点x − 鼠标x（远离锚点放大、靠近缩小），右下角固定；
 *  高度由 applyWindowSize 按宠物比例 + 气泡区自动计算 */
function applyScaleMove(screenX: number): void {
  if (!scaleStart || scaleAnchorRight <= 0) return;
  const width = clampScaleWidth(scaleAnchorRight - screenX, scaleMaxWidth);
  windowWidthUserAdjusted = true;
  applyWindowSize(width, scaleAnchorBottom);
}

/**
 * 窗口尺寸联动：宽度驱动宠物高（192:208），窗口高度 = 宠物高 + 气泡区高 + gap；
 * 经 Rust set_window_bounds 原子设置位置+尺寸（单次 SetWindowPos）——分步 setSize/setPosition
 * 会先让底边随高度变化移动（宠物/气泡被压），原子调用保持底边固定、宠物位置不变。
 * anchorBottom 缺省时异步读取当前底边；目标值与当前值完全一致时跳过（每轮 poll 都会调用，
 * 相同值的 SetWindowPos 在 Windows 上仍触发 WM_WINDOWPOSCHANGED → WebView 重布局抖动）。
 */
function applyWindowSize(width: number, anchorBottom?: number): void {
  lastWindowWidth = width;
  const requestId = ++windowBoundsRequestId;
  const petH = scaleHeight(width);
  const height = petH + cachedBubblesHeight + BUBBLE_GAP_PX;
  if (anchorBottom !== undefined) {
    void invoke("set_window_bounds", {
      x: scaleAnchorRight - width,
      y: anchorBottom - height,
      width,
      height,
    });
  } else {
    void Promise.all([getCurrentWindow().outerPosition(), getCurrentWindow().outerSize()])
      .then(([p, s]) => {
        if (!isCurrentWindowBoundsRequest(requestId, windowBoundsRequestId, width, lastWindowWidth)) {
          return;
        }
        const x = p.x;
        const y = p.y + s.height - height;
        if (x === p.x && y === p.y && s.width === width && s.height === height) return; // 幂等：无变化不 set
        invoke("set_window_bounds", { x, y, width, height });
      })
      .catch(() => {});
  }
}

/** 最大宽度 = 当前显示器可用宽度（screen 反映窗口所在显示器；窗口尺寸为物理 px，
 *  screen.availWidth 为 CSS px，需 × devicePixelRatio 换算；留 40px 边距） */
function refreshScaleMaxWidth(): void {
  const availPx = Math.round(screen.availWidth * (window.devicePixelRatio || 1));
  scaleMaxWidth = Math.max(MIN_WINDOW_WIDTH, availPx - 40);
}

scaleHandle.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  // 隔离窗口拖拽：手柄是窗口左上角的独立交互区
  e.stopPropagation();
  scaling = true;
  // 缩放开始：立即收回展开气泡并冻结 hover（窗口尺寸变化 → 热区布局重排漂移，进行中禁止误触发）
  freezeHover();
  scaleStart = { x: e.screenX };
  pendingScaleMove = null;
  refreshScaleMaxWidth();
  scaleHandle.setPointerCapture?.(e.pointerId);
  // 右下角锚点需要窗口位置 + 尺寸：并行获取，就绪后补算缓存的移动
  void Promise.all([getCurrentWindow().outerSize(), getCurrentWindow().outerPosition()])
    .then(([size, pos]) => {
      scaleAnchorRight = pos.x + size.width;
      scaleAnchorBottom = pos.y + size.height;
      // 竞态窗口期内的移动已缓存：锚点就绪后补算
      if (pendingScaleMove) {
        applyScaleMove(pendingScaleMove.x);
        pendingScaleMove = null;
      }
    })
    .catch(() => {
      // outerSize/outerPosition 失败（IPC 异常）：放弃本次缩放
      scaling = false;
      scaleStart = null;
    });
});

scaleHandle.addEventListener("pointermove", (e) => {
  if (!scaling || !scaleStart) return;
  if (scaleAnchorRight <= 0) {
    pendingScaleMove = { x: e.screenX };
    return;
  }
  applyScaleMove(e.screenX);
});

scaleHandle.addEventListener("pointerup", () => {
  if (!scaling) return;
  scaling = false;
  scaleStart = null;
  pendingScaleMove = null;
  // 缩放结束：强制保存最终窗口状态（Rust 侧 Resized 事件为节流写，此处兜底精确值）
  void invoke("save_window_state");
  // 缩放后的抬起：抑制紧随的 click（单击才聚焦终端）
  suppressClick = true;
  setTimeout(() => {
    suppressClick = false;
  }, 600);
  // 缩放改变窗口尺寸 → 气泡区布局重排 → 热区相对鼠标漂移：主动复查一次
  reevaluateExpanded();
});

function play(): void {
  animator.tick(Date.now());
}

/** 业务状态（聚合）+ 移动状态 → 可见动画（方案 §3.3）；animator 同状态不重置 */
function refreshVisibleAnimation(): void {
  const visible = resolveVisibleState(aggregateAct, movement.motion);
  animator.setState(visible);
}

/** 装载宠物：read_pet_bundle → 尺寸校验 → stateRows（方案 §41）；失败不阻断轮询 */
async function loadPet(petKey: string, override?: PetOverride): Promise<void> {
  try {
    loadedPet = await loader.load(petKey as never, override);
    animator.setPet(loadedPet);
    refreshVisibleAnimation();
  } catch (err) {
    console.warn("[ompet] 宠物加载失败（不影响轮询与窗口）：", err instanceof Error ? err.message : err);
    loadedPet = null;
    animator.setPet(null);
  }
}

/** 仅行映射变化：不重读图集，更新 stateRows 并重设当前可见状态（方案 §40） */
function applyStateRows(key: string, override: PetOverride | undefined): void {
  if (!loadedPet || loadedPet.key !== key) return;
  loadedPet.stateRows = resolveStateRows(override);
  refreshVisibleAnimation();
}

/** 会话 cwd → 项目名（展示与标签切换匹配用） */
const projectName = (cwd: string): string =>
  (cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd) || cwd;

/**
 * 渲染气泡（每轮 poll 调用，diff 更新）——预留式触发：
 * - 每个会话一个固定 28×28 的 slot（hover 检测区，不随气泡移动），位于缩略区；
 * - 单会话：气泡为胶囊固定显示在预留行（无 hover 交互），slot 隐藏；
 * - 多会话：气泡为圆球渲染在各自 slot 内；hover slot → expandBubble 把气泡下移到
 *   预留行展开（其他气泡不动）；移开 → collapseBubble 缩回。排他：同时只展开一个。
 * - 状态含 done 瞬时高亮（working/waiting→idle 切换后 DONE_DURATION_MS 内显示"任务完成"）。
 */
function renderBubbles(valid: Snapshot[], now: number, presentIds: Set<string>): void {
  // 迟滞保留的会话：文件仍在但 stale（heartbeat 停摆）→ 气泡保留显示最后状态，
  // 避免「停摆→销毁→恢复→重建」的抖动；有迟滞会话时不进入 single 模式
  // （否则 1 有效+1 迟滞 会被算成单会话 → slot 隐藏/显示切换 → hover 反复触发往返）
  const graceIds = new Set<string>();
  const validIds = new Set(valid.map((s) => s.sessionId));
  for (const [id, last] of lastSeenAt) {
    if (validIds.has(id) || !presentIds.has(id)) continue; // 有效会话不计；文件消失不算迟滞
    if (now - last < INVALID_GRACE_MS) graceIds.add(id);
  }
  const single = valid.length === 1 && graceIds.size === 0;
  const sorted = [...valid].sort((a, b) => b.updatedAt - a.updatedAt);
  const seen = new Set<string>();
  for (const snap of sorted) {
    seen.add(snap.sessionId);
    lastSeenAt.set(snap.sessionId, now);
    const st = sessionState.get(snap.sessionId) ?? {
      prevActivity: undefined,
      doneAt: null,
      pid: 0,
      project: "",
      terminalTitle: "",
    };
    // done 转换检测：非 idle → idle 切换瞬间记录 doneAt
    if (snap.activity === "idle" && st.prevActivity && st.prevActivity !== "idle" && st.doneAt === null) {
      st.doneAt = now;
    }
    // done 过期回落 idle
    if (st.doneAt !== null && now - st.doneAt >= DONE_DURATION_MS) st.doneAt = null;
    st.prevActivity = snap.activity;
    st.pid = snap.producerPid ?? 0;
    st.project = projectName(snap.cwd);
    st.terminalTitle = snap.terminalTitle ?? "";
    sessionState.set(snap.sessionId, st);
    const status = bubbleStatus(snap.activity, st.doneAt, now);

    let slot = slotEls.get(snap.sessionId);
    if (!slot) {
      slot = document.createElement("div");
      slot.className = "bubble-slot";
      slot.dataset.sessionId = snap.sessionId;
      // hover 触发不再绑定 slot 的 DOM enter/leave（见 evaluateHover）：reparent/重排
      // 产生的合成 mouseenter/mouseleave 无监听器，对 hover 状态零影响。
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      const icon = document.createElement("span");
      icon.className = "b-icon";
      const name = document.createElement("span");
      name.className = "b-name";
      const statusText = document.createElement("span");
      statusText.className = "b-status";
      bubble.append(icon, name, statusText);
      slot.append(bubble);
      shelfEl.append(slot);
      slotEls.set(snap.sessionId, slot);
      bubbleEls.set(snap.sessionId, bubble);
    }
    const bubble = bubbleEls.get(snap.sessionId)!;
    // morph 进行中跳过形态类与 DOM 归属重设：
    // 形态类——collapseBubble 已把 expandedSessionId 置 null，poll 会算成 orb，
    //   但 morphCollapse 尚未切 orb——提前切会破坏宽度收缩动画；
    // DOM 归属——morphCollapse 收缩期间被移回 slot 会瞬移打断收回动画；
    // morph 结束后形态与归属已由 morph 自身切好（morphCollapse 回调上移回 slot），poll 恢复归一。
    const morphing = morphLocks.has(snap.sessionId);
    // single 解除翻转接管（会话增删与 hover 展开互相争抢的修复）：
    // single 模式把气泡自动归属预留行时 expandedSessionId 保持 null；会话恢复使
    // single 解除的瞬间，若气泡仍以展开态驻留预留行且鼠标在热区，接管为悬停展开态。
    // 否则本会话会被强制收回 → slot 重新显示 → 鼠标悬停状态重放 mouseenter →
    // 150ms 后重新展开，形成「收回-展开」往返（B 进程崩溃重启循环时持续抖动）。
    // morphing 排除收回中断/重展接管中（气泡形态/归属由 morph 全权控制）；鼠标不在
    // 热区（真收回意图）时不接管，走正常收回。
    if (
      !single &&
      expandedSessionId === null &&
      !morphing &&
      bubble.parentElement === expandedEl &&
      mouseInExpandZone(snap.sessionId)
    ) {
      expandedSessionId = snap.sessionId;
    }
    // 归属：单会话恒在预留行（胶囊）；多会话按 expandedSessionId 决定在预留行（展开）或 slot（圆球）
    const isExpanded = single || expandedSessionId === snap.sessionId;
    // orphan 兜底：morphCollapse 已切 orb 但收尾被后续 morph 反复接管（token 校验跳过）
    // 而未上移的气泡——会以「orb @ 预留行 + 残留 width/transition」卡住数百 ms。
    // 非展开会话 + orb 形态在预留行 → 收缩已完成，清锁直接归位（无需再走收回动画）
    if (morphing && !isExpanded && bubble.parentElement === expandedEl && !bubble.classList.contains("capsule")) {
      morphLocks.delete(snap.sessionId);
      bubble.style.transition = "";
      bubble.style.width = "";
      slot.append(bubble);
    }
    const shape = morphing
      ? (bubble.classList.contains("capsule") ? "capsule" : "orb")
      : (isExpanded ? "capsule" : "orb");
    syncBubbleAppearance(bubble.classList, shape, status);
    bubble.dataset.status = status;
    bubble.dataset.sessionId = snap.sessionId;
    bubble.dataset.pid = String(st.pid);
    bubble.dataset.project = st.project;
    bubble.dataset.terminalTitle = st.terminalTitle;
    (bubble.querySelector(".b-name") as HTMLSpanElement).textContent = st.project;
    (bubble.querySelector(".b-status") as HTMLSpanElement).textContent = STATUS_LABEL[status];
    // DOM 归属（幂等：expand/collapse 已移动过，这里归一；hover 期间不被 poll 破坏）。
    // morph 进行中跳过：气泡位置由 morph/动画流程全权控制（展开在预留行、收回后回 slot）。
    // 归属变化走动画而非瞬移：会话数抖动（其他会话 heartbeat 停摆/恢复）会让 single 模式
    // 切换——瞬移会造成「胶囊↔圆球瞬跳」且 slot 隐藏/显示触发鼠标在其上时 mouseenter
    // 反复展开（往返抖动）。动画归属与 hover 的 expand/collapse 共用同一套 morph 流程。
    if (!morphing) {
      if (isExpanded) {
        if (bubble.parentElement !== expandedEl) {
          // slot → 预留行（single 自动展开或 poll 兜底）：下移 + morphExpand
          const from = bubble.getBoundingClientRect();
          expandedEl.append(bubble);
          morphLocks.set(snap.sessionId, ++morphSeq);
          animateMove(bubble, from, EXPAND_MOVE_MS, () => {
            if (morphLocks.has(snap.sessionId)) morphExpand(bubble);
          });
        }
      } else if (bubble.parentElement !== slot) {
        // 预留行 → slot（single 解除）：morphCollapse + 上移
        morphCollapse(bubble, () => {
          const from = bubble.getBoundingClientRect();
          slot.append(bubble);
          animateMove(bubble, from, COLLAPSE_MOVE_MS);
        });
      }
    }
    slot.style.display = single ? "none" : "";
  }
  // 删除已消失（stale/关闭）会话的气泡与 slot
  for (const [id, slot] of slotEls) {
    if (!seen.has(id)) {
      // 迟滞期内（heartbeat 停摆/读取瞬时失败）→ 保留气泡显示最后状态；
      // 超时或文件消失（进程退出/正常关闭）→ 立即移除
      if (graceIds.has(id)) continue;
      slot.remove();
      slotEls.delete(id);
      bubbleEls.delete(id);
      sessionState.delete(id);
      lastSeenAt.delete(id);
      if (expandedSessionId === id) expandedSessionId = null;
      morphLocks.delete(id);
      if (pendingEnterId === id) {
        pendingEnterId = null;
        if (pendingEnterTimer !== null) { clearTimeout(pendingEnterTimer); pendingEnterTimer = null; }
      }
      const gt = graceTimers.get(id);
      if (gt !== undefined) {
        clearTimeout(gt);
        graceTimers.delete(id);
      }
    }
  }
  // 按排序重排 shelf 内 slot（行内顺序稳定；wrap-reverse 下最新行在最底、最接近宠物）
  const ordered = sorted
    .map((s) => slotEls.get(s.sessionId))
    .filter((el): el is HTMLDivElement => el !== undefined);
  shelfEl.append(...ordered);
  // 实测气泡区高度并重设窗口高度（底部锚定；预留行恒在，展开不改变高度）
  cachedBubblesHeight = bubblesEl.offsetHeight;
  applyWindowSize(lastWindowWidth);
}

/**
 * 悬停展开（两阶段）：阶段 1 先下移到预留行（保持圆球形态）→ 阶段 2 到位后 morph 展开为胶囊。
 * 动画顺序固定（先移后展），避免"先展开再挪动"的观感；其他气泡不动；排他。
 */
function expandBubble(sessionId: string): void {
  if (expandedSessionId && expandedSessionId !== sessionId) collapseBubble(expandedSessionId);
  if (expandedSessionId === sessionId) return;
  expandedSessionId = sessionId;
  const bubble = bubbleEls.get(sessionId);
  if (!bubble) return;
  const from = bubble.getBoundingClientRect();
  expandedEl.append(bubble);
  // 阶段 1 起即锁 morph（poll 在阶段 1 下移期保持 orb 形态类与 DOM 归属，不提前切 capsule）
  morphLocks.set(sessionId, ++morphSeq);
  // 阶段 1：仅下移（保持 orb）→ 阶段 2：到位后 morph 展开（宽度缓动 + 文字淡入）
  animateMove(bubble, from, EXPAND_MOVE_MS, () => {
    // 期间被收回（leave 触发）则不展开
    if (expandedSessionId === sessionId && bubble.parentElement === expandedEl) {
      morphExpand(bubble);
    }
  });
}

/**
 * 缩回（两阶段，与展开镜像）：阶段 1 先 morph 缩回圆球形态（文字淡出 + 宽度收缩）→
 * 阶段 2 再上移回 slot。期间若被重新展开则取消上移。
 */
function collapseBubble(sessionId: string): void {
  if (expandedSessionId !== sessionId) return;
  expandedSessionId = null;
  const bubble = bubbleEls.get(sessionId);
  const slot = slotEls.get(sessionId);
  if (!bubble || !slot) return;
  // 阶段 1：morphCollapse 缩回 orb → 回调内阶段 2 上移回 slot
  morphCollapse(bubble, () => {
    // 仅本会话被重新展开才取消收回（morphExpand 已接管，气泡留在预留行）；
    // 其他会话展开（排他切换）→ 本会话正常收回上移，不依赖 poll 瞬移归位
    if (expandedSessionId === sessionId || bubble.parentElement !== expandedEl) return;
    const from = bubble.getBoundingClientRect();
    slot.append(bubble);
    animateMove(bubble, from, COLLAPSE_MOVE_MS);
  });
}

/**
 * 圆球→胶囊：锁 28px 起点 → scrollWidth 测目标宽 → width 缓动 → 文字延迟淡入。
 * 文字在 orb 形态是 display:none，切 capsule 后 display 恢复、用 opacity 控制可见性。
 * token 代次校验收尾：期间被 morphCollapse 接管（重新收回）则跳过清理，避免破坏新 morph。
 */
function morphExpand(bubble: HTMLDivElement): void {
  const sid = bubble.dataset.sessionId ?? "";
  const token = ++morphSeq;
  morphLocks.set(sid, token);
  const bubbleStatusValue = bubble.dataset.status as BubbleStatus | undefined;
  if (!bubbleStatusValue) throw new Error("气泡展开时缺少当前状态");
  // 胶囊首帧显式复用当前状态类；状态类不依赖下一轮 poll 才补上。
  syncBubbleAppearance(bubble.classList, "capsule", bubbleStatusValue);
  bubble.style.overflow = "hidden";
  bubble.style.width = "28px";                 // 锁起点（orb 宽），防止切类瞬间跳宽
  void bubble.offsetWidth;                      // 强制 reflow 固定起点
  const targetW = bubble.scrollWidth;           // 内容真实宽度（不受当前 width 限制）
  bubble.style.transition = `width ${MORPH_EXPAND_MS}ms ${EASE_OUT}`;
  bubble.style.width = `${targetW}px`;
  const name = bubble.querySelector(".b-name") as HTMLSpanElement;
  const status = bubble.querySelector(".b-status") as HTMLSpanElement;
  for (const el of [name, status]) {
    el.style.opacity = "0";
    el.style.transition = `opacity ${TEXT_FADE_IN_MS}ms ease ${TEXT_FADE_DELAY_MS}ms`;
  }
  void bubble.offsetWidth;
  name.style.opacity = "";
  status.style.opacity = "";                    // 触发淡入（过渡到 CSS 默认 1）
  window.setTimeout(() => {
    if (morphLocks.get(sid) !== token) return;  // 已被更新的 morph（收回）接管，不动其样式
    bubble.style.overflow = "";
    bubble.style.width = "";                    // 还原 auto（capsule 由内容撑开）
    bubble.style.transition = "";
    name.style.transition = "";
    status.style.transition = "";
    morphLocks.delete(sid);
  }, MORPH_EXPAND_MS + TEXT_FADE_DELAY_MS + TEXT_FADE_IN_MS + 20);
}

/**
 * 胶囊→圆球：锁当前像素宽 → 文字淡出 → width 缓动到 28 → 切 orb。done 在收缩完成后回调。
 * 收缩期间若被重新展开（expandedSessionId 恢复为本会话）→ 跳过切 orb 与样式清理，
 * 由 morphExpand 全权接管（防止展开动画被收回的收尾破坏）。
 */
function morphCollapse(bubble: HTMLDivElement, done: () => void): void {
  const sid = bubble.dataset.sessionId ?? "";
  const token = ++morphSeq;
  morphLocks.set(sid, token);
  const startW = bubble.offsetWidth;
  bubble.style.width = `${startW}px`;           // 锁当前像素宽（auto→数值才能过渡）
  const name = bubble.querySelector(".b-name") as HTMLSpanElement;
  const status = bubble.querySelector(".b-status") as HTMLSpanElement;
  for (const el of [name, status]) {
    el.style.transition = `opacity ${TEXT_FADE_OUT_MS}ms ease`;
    el.style.opacity = "0";
  }
  bubble.style.transition = `width ${MORPH_COLLAPSE_MS}ms ${EASE_IN}`;
  void bubble.offsetWidth;
  bubble.style.width = "28px";
  window.setTimeout(() => {
    if (morphLocks.get(sid) !== token) return;  // 已被更新的 morph 接管
    morphLocks.delete(sid);
    // 期间被重新展开 → 保留 capsule 形态与 morphExpand 的样式，由它接管（不上移）
    if (expandedSessionId === sid) return;
    bubble.classList.remove("capsule");
    bubble.classList.add("orb");
    bubble.style.transition = "";
    bubble.style.width = "";
    name.style.transition = "";
    status.style.transition = "";
    name.style.opacity = "";
    status.style.opacity = "";
    done();
  }, MORPH_COLLAPSE_MS);
}

/**
 * 位移动画代次（animateMove 并发安全）：finish 仅清理自己代次设置的样式。
 * 修复：展开下移（220ms）进行中被收回时，morphCollapse 的 width transition 正在运行，
 * 旧 finish 无条件清 transition 会把收缩动画截断为瞬移；代次校验保证被后续
 * animateMove/morph 接管时旧动画的收尾不再动样式，由新动画全权控制。
 */
let moveSeq = 0;

/**
 * FLIP 简化：元素已移动到新位置，用 transform 从旧位补间回最终位。
 * durationMs 控制补间时长（展开 EXPAND_MOVE_MS / 收起 COLLAPSE_MOVE_MS）；动画结束后清除 inline transition。
 * 位移为 0 时立即执行 onDone（无移动动画，不触碰样式——避免破坏并发 morph 的 width transition）。
 */
function animateMove(el: HTMLElement, from: DOMRect, durationMs = 180, onDone?: () => void): void {
  const to = el.getBoundingClientRect();
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const token = ++moveSeq;
  const finish = (): void => {
    // 期间被新的 animateMove/morph 接管 → 本代次收尾作废，样式由新动画清理
    if (el.dataset.moveToken !== String(token)) return;
    delete el.dataset.moveToken;
    el.style.transform = "";
    el.style.transition = "";
    onDone?.();
  };
  if (dx === 0 && dy === 0) {
    onDone?.();
    return;
  }
  el.dataset.moveToken = String(token);
  el.style.transition = "transform 0s";
  el.style.transform = `translate(${dx}px, ${dy}px)`;
  void el.offsetWidth; // 强制 reflow 使初始位移生效
  el.style.transition = `transform ${durationMs}ms`;
  el.style.transform = "";
  setTimeout(finish, durationMs);
}

/** 宠物本体动画：应用聚合活动状态；非 idle 时取消移动动画 */
function applyPetActivity(activity: Activity): void {
  document.body.classList.toggle("busy", activity !== "idle");
  // 拖拽中不取消 movement：拖拽是用户主动移动，motion 由 updateDrag 驱动；
  // 可见动画由 resolveVisibleState 统一裁决（working 优先级高于 motion），不受影响
  if (activity !== "idle" && !dragging) movement.cancel();
  refreshVisibleAnimation();
}

/** 确保宠物资源已加载（首帧/首次有效会话时触发；后续由 config revision 变化驱动） */
function ensurePetLoaded(): void {
  const key = activePetKeyFromConfig(currentConfig ?? {});
  if (key && key !== lastPetKey) {
    lastPetKey = key;
    void loadPet(key, currentConfig?.petOverrides?.[key]);
  }
}

/** Global Config（~/.omp/ompet/config.json）解析视图 */
interface OMPetConfigFile {
  revision?: number;
  enabled?: boolean;
  activePet?: string | null;
  petOverrides?: Record<string, PetOverride>;
}

/** 当前已加载的 config（损坏/缺失 → null，保持现状） */
let currentConfig: OMPetConfigFile | null = null;
/** 已应用的最新 config revision（热更新判定，方案 §40） */
let lastConfigRevision = -1;

/** 从 config 取 activePet（完整 PetKey，如 "codex:remilia"） */
function activePetKeyFromConfig(config: OMPetConfigFile): string {
  return config.activePet ?? "";
}

/** 桌面生命周期：无有效 session 的起始时刻（跟随 omp 自动退出用） */
let noValidSince: number | null = null;

/**
 * 应用桌面运行时状态（方案 §39 执行顺序）：
 * 1. config.revision 比较（变化 → activePet 变化 → 重新加载宠物）
 * 2. 全部有效会话 → renderBubbles（每会话一个气泡）
 * 3. 聚合活动状态 → applyPetActivity（宠物本体动画）
 * 4. 主会话（宠物本体点击目标）→ selectSession 粘性选择
 */
async function applyRuntimeState(payload: {
  config: string | null;
  snapshots: { file: string; content: string | null }[];
}): Promise<void> {
  // 1. Global Config（方案 §40 热更新：revision 不同才处理）
  if (payload.config) {
    try {
      const config = JSON.parse(payload.config) as OMPetConfigFile;
      if ((config.revision ?? 0) !== lastConfigRevision) {
        const prev = currentConfig;
        lastConfigRevision = config.revision ?? 0;
        currentConfig = config;
        const key = activePetKeyFromConfig(config);
        const prevKey = prev ? activePetKeyFromConfig(prev) : "";
        if (key !== prevKey) {
          // activePet 变化 → 重新加载宠物资源
          lastPetKey = key;
          if (key) void loadPet(key, config.petOverrides?.[key]);
        } else if (key) {
          // 仅行映射变化 → 不重读图集，只更新映射（方案 §40）
          applyStateRows(key, config.petOverrides?.[key]);
        }
      }
    } catch {
      // config 损坏：保持上一个有效配置（方案 §37），不阻断
    }
  }

  // 2–4. snapshots → 有效会话 → 气泡 + 宠物动画 + 主会话
  const snapshots = payload.snapshots
    .map((f) => parseSnapshot(f.content))
    .filter((s): s is Snapshot => s !== null);
  // 本轮快照文件存在的全部会话（含 stale/解析失败）：供 renderBubbles 迟滞保留
  const presentIds = new Set(payload.snapshots.map((f) => decodeSnapshotId(f.file)));
  const now = Date.now();
  const valid = snapshots.filter((s) => !isInvalid(s, now));
  if (valid.length === 0) {
    // 当前主会话的文件本次损坏/占用（文件在但解析失败）→ 保留当前画面（方案 7.3），不进入退出倒计时
    if (primarySnapshot) {
      const broken = payload.snapshots.some(
        (f) => f.content === null && decodeSnapshotId(f.file) === primarySnapshot!.sessionId,
      );
      if (broken) {
        noValidSince = null;
        return;
      }
    }
    // 无有效会话（全部 closed/stale/消失）→ 清空气泡回本地 idle；持续超时后自动退出
    if (noValidSince === null) noValidSince = now;
    renderBubbles([], now, new Set());
    aggregateAct = "idle";
    applyPetActivity("idle");
    primarySnapshot = null;
    currentPid = 0;
    currentProject = "";
    currentTerminalTitle = "";
    if (shouldExitDesktop(noValidSince, now)) {
      // 不走 window.close()：主窗口关闭被托盘常驻逻辑拦截为隐藏，必须退出进程
      void invoke("exit_app");
    }
    return;
  }
  noValidSince = null;
  renderBubbles(valid, now, presentIds);
  aggregateAct = aggregateActivity(valid.map((s) => s.activity));
  applyPetActivity(aggregateAct);
  // 主会话（宠物本体点击目标）：沿用粘性选择（heartbeat 有效 + updatedAt 最新 + 粘性）
  primarySnapshot = selectSession(valid, primarySnapshot, now);
  currentPid = primarySnapshot.producerPid ?? 0;
  currentProject = projectName(primarySnapshot.cwd);
  currentTerminalTitle = primarySnapshot.terminalTitle ?? "";
  ensurePetLoaded();
}

let pollInFlight = false;

async function poll(): Promise<void> {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    // Rust setup 已先恢复持久化尺寸；首轮布局必须等前端拿到真实宽度，
    // 避免 renderBubbles 用默认 240px 把恢复结果覆盖并重新写盘。
    await initialWindowWidthReady;
    let payload: { config: string | null; snapshots: { file: string; content: string | null }[] };
    try {
      payload = (await invoke("read_runtime_state")) as typeof payload;
    } catch {
      return; // 读取失败：保留当前画面
    }
    await applyRuntimeState(payload);
  } finally {
    pollInFlight = false;
  }
}

// 气泡点击：聚焦该气泡对应会话的 omp 终端并切到对应标签。
// stopPropagation 避免触发下方的宠物本体聚焦；suppressClick/focusing 守卫与本体一致。
bubblesEl.addEventListener("click", (e) => {
  if (suppressClick || focusing) return;
  const el = (e.target as HTMLElement).closest(".bubble") as HTMLDivElement | null;
  if (!el) return;
  const pid = Number(el.dataset.pid ?? "0");
  if (!pid) return;
  e.stopPropagation();
  focusing = true;
  void invoke("focus_ompi_terminal", {
    pid,
    project: el.dataset.project ?? "",
    title: el.dataset.terminalTitle ?? "",
  }).finally(() => {
    focusing = false;
  });
});

// 单击窗口本体（宠物区/空白，非气泡）：聚焦主会话（primarySnapshot）的 omp 终端
// （按 registry pid 反查窗口，按项目名切标签）。拖拽（位移超阈值）松手不触发。
// focusing 为 in-flight 锁：聚焦请求执行期间（含 PowerShell 标签切换，耗时 ~1s）忽略
// 后续点击，避免连续点击堆积 spawn 多个 powershell 进程。
let focusing = false;
document.addEventListener("click", () => {
  if (suppressClick) return;
  if (!currentPid) return;
  if (focusing) return;
  focusing = true;
  void invoke("focus_ompi_terminal", {
    pid: currentPid,
    project: currentProject,
    title: currentTerminalTitle,
  }).finally(() => {
    focusing = false;
  });
});

// 轮询快照目录 + 帧动画（参数集中配置，方案第 11 节）
setInterval(() => void poll().catch(() => {}), PET_CONFIG.desktopPollIntervalMs);
setInterval(play, PET_CONFIG.animationTickMs); // 125ms = 8fps
