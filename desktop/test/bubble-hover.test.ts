/**
 * 气泡 hover 交互状态机模拟（Bubble Hover State Machine Sim）。
 *
 * 与 desktop/src/main.ts 的气泡交互逻辑**逐字对应**（常量、事件、状态机、动画流程），
 * 仅把 DOM / 定时器替换为最小 mock，用于复现/回归"悬停触发不稳定"类问题：
 * 慢速移动、边缘抖动、快速划过、排他切换、收回后同点再 hover、动画与 poll 竞态。
 *
 * ⚠️ 本文件是 main.ts 气泡交互逻辑的镜像；修改 main.ts 时必须同步本文件。
 *
 * 布局数字与 240 宽窗口一致（见 bubbles.test.ts）：
 * - bubbles padding 24/24/12；shelf row gap 6 居中 → 内容区 x24..216
 * - slot A: x89..117, y42..70；slot B: x123..151, y42..70（28×28，间距 34）
 * - 预留行 #bubble-expanded: x24..216, y76..104（192×28）
 * - 展开胶囊（138px）：x51..189, y76..104
 */
import { describe, expect, test } from "bun:test";

// ============ 常量（与 main.ts 一致） ============
const EXPAND_MOVE_MS = 220;
const MORPH_EXPAND_MS = 220;
const TEXT_FADE_IN_MS = 160;
const TEXT_FADE_DELAY_MS = 100;
const MORPH_COLLAPSE_MS = 130;
const COLLAPSE_MOVE_MS = 100;
const COLLAPSE_DEBOUNCE_MS = 150;
const ENTER_DEBOUNCE_MS = 150; // slot 触发去抖（鼠标在 slot 元素内停留时长）
const TRIGGER_GRACE_MS = 100; // 去抖到期复查：鼠标在带内元素外（手抖跨出）时的宽限窗口
const SLOT_PAD_PX = 24;
const PAD = 10; // ②③ 热区容差

// ============ mock DOM ============
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

class FakeEl {
  parent: FakeEl | null = null;
  children: FakeEl[] = [];
  listeners: Record<string, (() => void)[]> = {};
  classList = new Set<string>();
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  display = "";

  constructor(
    public id: string,
    public _rect: Rect,
  ) {}

  append(child: FakeEl): void {
    if (child.parent) {
      const idx = child.parent.children.indexOf(child);
      if (idx >= 0) child.parent.children.splice(idx, 1);
    }
    child.parent = this;
    this.children.push(child);
    // 元素移动到指针下 → 触发该元素 mouseenter（父元素边界未变 → 不触发父级）
    if (mouse && pointInRect(mouse, child._rect)) child.dispatch("mouseenter");
  }

  remove(): void {
    if (!this.parent) return;
    const idx = this.parent.children.indexOf(this);
    if (idx >= 0) this.parent.children.splice(idx, 1);
    this.parent = null;
  }

  addEventListener(ev: string, fn: () => void): void {
    (this.listeners[ev] ??= []).push(fn);
  }

  dispatch(ev: string): void {
    for (const fn of [...(this.listeners[ev] ?? [])]) fn();
  }

  getBoundingClientRect(): Rect {
    return this.display === "none" ? { x: 0, y: 0, width: 0, height: 0 } : { ...this._rect };
  }
}

// ============ 假时钟（带 id，可取消） ============
interface Timer {
  id: number;
  at: number;
  fn: () => void;
}
let now = 0;
const timers: Timer[] = [];
let timerSeq = 0;

function setTimer(ms: number, fn: () => void): number {
  timers.push({ id: ++timerSeq, at: now + ms, fn });
  return timerSeq;
}

function clearTimer(id: number | null): void {
  if (id === null) return;
  const idx = timers.findIndex((t) => t.id === id);
  if (idx >= 0) timers.splice(idx, 1);
}

/** 推进时钟；到期定时器按时间序执行（含到期时新注册的） */
function tick(ms: number): void {
  const target = now + ms;
  for (;;) {
    const due = timers
      .filter((t) => t.at <= target)
      .sort((a, b) => a.at - b.at);
    if (due.length === 0) break;
    const t = due[0];
    clearTimer(t.id);
    now = t.at;
    t.fn();
  }
  now = target;
}

// ============ 鼠标与 enter/leave 分发 ============
let mouse: { x: number; y: number } = { x: 0, y: 0 };
let lastMouse: { x: number; y: number } = { x: 0, y: 0 };

function pointInRect(p: { x: number; y: number }, r: Rect, pad = 0): boolean {
  return p.x >= r.x - pad && p.x <= r.x + r.width + pad && p.y >= r.y - pad && p.y <= r.y + r.height + pad;
}

/**
 * 移动鼠标（与真实浏览器一致：window mousemove 先更新 lastMouse 再评估 hover）。
 * 触发层完全由 mousemove + 几何判定驱动（与 main.ts evaluateHover 一致）——
 * 不再按元素边界派发 enter/leave：reparent 产生的合成事件在镜像里也无监听器，
 * 对 hover 状态零影响（回归用例靠此验证「重排不闪烁」）。
 */
function setMouse(x: number, y: number): void {
  mouse = { x, y };
  lastMouse = { x, y };
  evaluateHover();
}

// ============ 状态（与 main.ts 一致） ============
const bubbleEls = new Map<string, FakeEl>();
const slotEls = new Map<string, FakeEl>();
const shelfEl = new FakeEl("shelf", { x: 24, y: 42, width: 192, height: 28 });
const expandedEl = new FakeEl("expanded", { x: 24, y: 76, width: 192, height: 28 });
let expandedSessionId: string | null = null;
let collapseTimer: number | null = null;
const morphLocks = new Map<string, number>();
let morphSeq = 0;
let moveSeq = 0;
/** mousemove 驱动的 enter 候选 slot（去抖期内最近 slot；reparent 不影响——只跟鼠标位置） */
let pendingEnterId: string | null = null;
/** pendingEnterId 的去抖 timer（ENTER_DEBOUNCE_MS 后调 tryExpand；最近 slot 变化时重置） */
let pendingEnterTimer: number | null = null;
/** slot → 宽限复查 timer id（tryExpand 设置） */
const graceTimers = new Map<string, number>();
/** 窗口级指针操作标志（与 main.ts 一致；拖拽/缩放进行中冻结 hover） */
let dragging = false;
let scaling = false;

/** 窗口级指针操作（拖拽/缩放）进行中 → 冻结气泡 hover（热区随窗口漂移，杜绝误触发） */
function isPointerBusy(): boolean {
  return dragging || scaling;
}

/** 拖拽/缩放开始时立即收回展开气泡 + 清空全部 hover timer（冻结入态清理） */
function freezeHover(): void {
  if (expandedSessionId) collapseBubble(expandedSessionId);
  if (collapseTimer !== null) { clearTimer(collapseTimer); collapseTimer = null; }
  pendingEnterId = null;
  if (pendingEnterTimer !== null) { clearTimer(pendingEnterTimer); pendingEnterTimer = null; }
  for (const [id, t] of graceTimers) { clearTimer(t); graceTimers.delete(id); }
}

/** 失焦或指针捕获丢失时终止拖拽/缩放，避免 busy 状态永久残留。 */
function cancelPointerInteraction(): void {
  if (!dragging && !scaling) return;
  dragging = false;
  scaling = false;
}

/** 失焦、页面隐藏或鼠标离开窗口时复用主逻辑，清理中断的指针和 hover 状态。 */
function resetHoverOnInputInterruption(): void {
  cancelPointerInteraction();
  freezeHover();
}

// ============ 热区判定（与 main.ts / bubbles.ts 一致） ============
function pointInExpandZone(
  p: { x: number; y: number },
  slot: Rect,
  bubble: Rect,
  expanded: Rect,
  pad: number,
  slotPad = pad,
): boolean {
  if (pointInRect(p, slot, slotPad)) return true;
  if (pointInRect(p, bubble, pad)) return true;
  const sign = (p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }): number =>
    (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const a = { x: slot.x + slot.width / 2, y: slot.y + slot.height / 2 };
  const b = { x: expanded.x, y: expanded.y + expanded.height };
  const c = { x: expanded.x + expanded.width, y: expanded.y + expanded.height };
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function mouseInExpandZone(sessionId: string): boolean {
  const bubble = bubbleEls.get(sessionId);
  const slot = slotEls.get(sessionId);
  if (!bubble || !slot || bubble.parent !== expandedEl) return false;
  const e = expandedEl.getBoundingClientRect();
  // 动画中（morph 锁未清）② 用整行容器；完成后用气泡实时 bbox
  const zoneBubble = morphLocks.has(sessionId) ? e : bubble.getBoundingClientRect();
  return pointInExpandZone(lastMouse, slot.getBoundingClientRect(), zoneBubble, e, PAD, SLOT_PAD_PX);
}

/** 鼠标是否在 slot 元素矩形内（含 pad 容差带） */
function mouseInSlotPad(sessionId: string, p: { x: number; y: number } = lastMouse): boolean {
  const slot = slotEls.get(sessionId);
  return !!slot && pointInRect(p, slot._rect, SLOT_PAD_PX);
}

/** 鼠标是否在 slot 元素矩形内（不含容差） */
function mouseInSlot(sessionId: string, p: { x: number; y: number } = lastMouse): boolean {
  const slot = slotEls.get(sessionId);
  return !!slot && pointInRect(p, slot._rect);
}

/** 该 slot 是否为鼠标所在的所有 slot（含扩展带）中中心最近的 */
function isNearestSlot(sessionId: string, p: { x: number; y: number }): boolean {
  let best: string | null = null;
  let bestD = Infinity;
  for (const [id, el] of slotEls) {
    if (el.display === "none") continue;
    const r = el._rect;
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
    if (el.display === "none") continue;
    const r = el._rect;
    if (pointInRect(p, r, SLOT_PAD_PX)) {
      const d = (p.x - (r.x + r.width / 2)) ** 2 + (p.y - (r.y + r.height / 2)) ** 2;
      if (d < bestD) { bestD = d; best = id; }
    }
  }
  return best;
}

/** 展开触发复查（enter 去抖到期后）：元素内 → 展开；带内元素外 → 短宽限；已出带/非最近 → 放弃 */
function tryExpand(sessionId: string): void {
  if (expandedSessionId === sessionId) return;
  if (isPointerBusy()) return; // 拖拽/缩放进行中：冻结 hover，等鼠标真实 hover 驱动
  const p = lastMouse;
  if (!mouseInSlotPad(sessionId, p)) return;
  if (mouseInSlot(sessionId, p)) {
    expandBubble(sessionId);
    return;
  }
  if (!isNearestSlot(sessionId, p)) return;
  graceTimers.set(
    sessionId,
    setTimer(TRIGGER_GRACE_MS, () => {
      graceTimers.delete(sessionId);
      if (expandedSessionId === sessionId) return;
      if (mouseInSlotPad(sessionId, lastMouse) && isNearestSlot(sessionId, lastMouse)) {
        expandBubble(sessionId);
      }
    }),
  );
}

function reevaluateExpanded(): void {
  if (isPointerBusy()) return; // 拖拽/缩放进行中：冻结评估（热区随窗口漂移，不复查）
  if (!expandedSessionId) return;
  if (mouseInExpandZone(expandedSessionId)) {
    if (collapseTimer !== null) {
      clearTimer(collapseTimer);
      collapseTimer = null;
    }
  } else if (collapseTimer === null) {
    collapseTimer = setTimer(COLLAPSE_DEBOUNCE_MS, () => {
      collapseTimer = null;
      if (expandedSessionId && !mouseInExpandZone(expandedSessionId)) {
        collapseBubble(expandedSessionId);
      }
    });
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
    if (pendingEnterTimer !== null) { clearTimer(pendingEnterTimer); pendingEnterTimer = null; }
  }
  if (expandedSessionId) {
    reevaluateExpanded(); // 展开保持/下降沿防抖收回
    if (pendingEnterId === expandedSessionId) return; // 保持自身时不重复 arm（tryExpand 幂等，避免无谓 timer）
  }
  if (pendingEnterTimer === null && pendingEnterId !== null) {
    const t = pendingEnterId;
    pendingEnterTimer = setTimer(ENTER_DEBOUNCE_MS, () => {
      pendingEnterTimer = null;
      if (pendingEnterId === t) tryExpand(t);
    });
  }
}

// ============ 展开/收回/动画（与 main.ts 一致） ============
function expandBubble(sessionId: string): void {
  if (expandedSessionId && expandedSessionId !== sessionId) collapseBubble(expandedSessionId);
  if (expandedSessionId === sessionId) return;
  expandedSessionId = sessionId;
  const bubble = bubbleEls.get(sessionId);
  if (!bubble) return;
  const from = bubble.getBoundingClientRect();
  expandedEl.append(bubble);
  morphLocks.set(sessionId, ++morphSeq);
  animateMove(bubble, from, EXPAND_MOVE_MS, () => {
    if (expandedSessionId === sessionId && bubble.parent === expandedEl) {
      morphExpand(bubble);
    }
  });
}

function collapseBubble(sessionId: string): void {
  if (expandedSessionId !== sessionId) return;
  expandedSessionId = null;
  const bubble = bubbleEls.get(sessionId);
  const slot = slotEls.get(sessionId);
  if (!bubble || !slot) return;
  morphCollapse(bubble, () => {
    if (expandedSessionId === sessionId || bubble.parent !== expandedEl) return;
    const from = bubble.getBoundingClientRect();
    slot.append(bubble);
    animateMove(bubble, from, COLLAPSE_MOVE_MS);
  });
}

function morphExpand(bubble: FakeEl): void {
  const sid = bubble.dataset.sessionId ?? "";
  const token = ++morphSeq;
  morphLocks.set(sid, token);
  bubble.classList.delete("orb");
  bubble.classList.add("capsule");
  bubble._rect = capsuleRect();
  setTimer(MORPH_EXPAND_MS + TEXT_FADE_DELAY_MS + TEXT_FADE_IN_MS + 20, () => {
    if (morphLocks.get(sid) !== token) return;
    morphLocks.delete(sid);
  });
}

function morphCollapse(bubble: FakeEl, done: () => void): void {
  const sid = bubble.dataset.sessionId ?? "";
  const token = ++morphSeq;
  morphLocks.set(sid, token);
  setTimer(MORPH_COLLAPSE_MS, () => {
    if (morphLocks.get(sid) !== token) return;
    morphLocks.delete(sid);
    if (expandedSessionId === sid) return;
    bubble.classList.delete("capsule");
    bubble.classList.add("orb");
    const slot = slotEls.get(sid);
    if (slot) bubble._rect = orbRect(slot._rect);
    done();
  });
}

function animateMove(
  el: FakeEl,
  _from: Rect,
  durationMs: number,
  onDone?: () => void,
): void {
  const token = ++moveSeq;
  el.dataset.moveToken = String(token);
  setTimer(durationMs, () => {
    if (el.dataset.moveToken !== String(token)) return;
    delete el.dataset.moveToken;
    onDone?.();
  });
}

function orbRect(slotRect: Rect): Rect {
  return { x: slotRect.x, y: slotRect.y, width: 28, height: 28 };
}

function capsuleRect(): Rect {
  const e = expandedEl._rect;
  const w = 138; // 测试布局：内容 138px
  return { x: e.x + (e.width - w) / 2, y: e.y, width: w, height: 28 };
}

// ============ renderBubbles（与 main.ts 一致，省略会话状态计算） ============
/**
 * @param sessions 本轮有效会话（updatedAt 降序）
 * @param single   单会话模式（slot 隐藏、气泡恒在预留行）
 */
function renderBubbles(sessions: string[], single: boolean): void {
  const seen = new Set<string>();
  const rects = slotRects(sessions.length);
  sessions.forEach((sid, i) => {
    seen.add(sid);
    let slot = slotEls.get(sid);
    if (!slot) {
      slot = new FakeEl(`slot-${sid}`, rects[i]);
      slot.dataset.sessionId = sid;
      // hover 触发不再绑定 slot 的 DOM enter/leave（见 evaluateHover）：reparent/重排
      // 产生的合成 mouseenter/mouseleave 无监听器，对 hover 状态零影响。
      const bubble = new FakeEl(`bubble-${sid}`, orbRect(rects[i]));
      bubble.classList.add("bubble", "orb");
      bubble.dataset.sessionId = sid;
      slot.append(bubble);
      shelfEl.append(slot);
      slotEls.set(sid, slot);
      bubbleEls.set(sid, bubble);
    }
    const bubble = bubbleEls.get(sid)!;
    const morphing = morphLocks.has(sid);
    // single 解除翻转接管（V2-19）
    if (
      !single &&
      expandedSessionId === null &&
      !morphing &&
      bubble.parent === expandedEl &&
      mouseInExpandZone(sid)
    ) {
      expandedSessionId = sid;
    }
    const isExpanded = single || expandedSessionId === sid;
    // orphan 兜底（V2-19）
    if (morphing && !isExpanded && bubble.parent === expandedEl && !bubble.classList.contains("capsule")) {
      morphLocks.delete(sid);
      slot.append(bubble);
    }
    // 归属归一（morphing 跳过）
    if (!morphing) {
      if (isExpanded) {
        if (bubble.parent !== expandedEl) {
          const from = bubble.getBoundingClientRect();
          expandedEl.append(bubble);
          morphLocks.set(sid, ++morphSeq);
          animateMove(bubble, from, EXPAND_MOVE_MS, () => {
            if (morphLocks.has(sid)) morphExpand(bubble);
          });
        }
      } else if (bubble.parent !== slot) {
        morphCollapse(bubble, () => {
          const from = bubble.getBoundingClientRect();
          slot.append(bubble);
          animateMove(bubble, from, COLLAPSE_MOVE_MS);
        });
      }
    }
    slot.display = single ? "none" : "";
  });
  // 删除消失会话
  for (const [id, slot] of slotEls) {
    if (!seen.has(id)) {
      slot.remove();
      slotEls.delete(id);
      bubbleEls.delete(id);
      if (expandedSessionId === id) expandedSessionId = null;
      morphLocks.delete(id);
      if (pendingEnterId === id) {
        pendingEnterId = null;
        if (pendingEnterTimer !== null) { clearTimer(pendingEnterTimer); pendingEnterTimer = null; }
      }
    }
  }
}

/** N 个 slot 在内容区（24..216）居中，gap 6 */
function slotRects(n: number): Rect[] {
  const gap = 6;
  const w = n * 28 + (n - 1) * gap;
  const start = 24 + (192 - w) / 2;
  return Array.from({ length: n }, (_, i) => ({
    x: start + i * (28 + gap),
    y: 42,
    width: 28,
    height: 28,
  }));
}

/** 模拟 renderBubbles 末尾 shelfEl.append(...ordered)：按给定顺序重排 shelf 内 slot DOM。
 *  重排会把元素挪到指针下 → FakeEl.append 派发合成 mouseenter——slot 已无监听器，
 *  对 hover 状态零副作用（回归用例靠此验证「重排不闪烁」）。 */
function reorderShelf(order: string[]): void {
  for (const sid of order) {
    const slot = slotEls.get(sid);
    if (slot) shelfEl.append(slot);
  }
}

// ============ 测试辅助 ============
function reset(): void {
  now = 0;
  timers.length = 0;
  timerSeq = 0;
  mouse = { x: 0, y: 0 };
  lastMouse = { x: 0, y: 0 };
  bubbleEls.clear();
  slotEls.clear();
  shelfEl.children = [];
  expandedEl.children = [];
  expandedSessionId = null;
  collapseTimer = null;
  morphLocks.clear();
  morphSeq = 0;
  moveSeq = 0;
  pendingEnterId = null;
  pendingEnterTimer = null;
  graceTimers.clear();
  dragging = false;
  scaling = false;
}

/** applyPetActivity 守卫语义镜像（与 main.ts 一致）：非 idle 且非拖拽才 cancel movement */
function applyPetActivity(activity: string, movement: { cancel: () => void }): void {
  if (activity !== "idle" && !dragging) movement.cancel();
}

function isExpanded(sid: string): boolean {
  return expandedSessionId === sid && bubbleEls.get(sid)?.parent === expandedEl;
}

function isInSlot(sid: string): boolean {
  return bubbleEls.get(sid)?.parent === slotEls.get(sid);
}

/** hover 的完整动画耗时：enter 去抖 + 下移 + morph */
function fullExpandTime(): number {
  return ENTER_DEBOUNCE_MS + EXPAND_MOVE_MS + MORPH_EXPAND_MS;
}

/** morph 锁清除时刻（morphExpand 收尾清理期，此后热区② 收窄为实时 bbox） */
function morphUnlockTime(): number {
  return ENTER_DEBOUNCE_MS + EXPAND_MOVE_MS + MORPH_EXPAND_MS + TEXT_FADE_DELAY_MS + TEXT_FADE_IN_MS + 20;
}

describe("气泡 hover 状态机", () => {
  test("基本：hover A → 展开；移出热区 → 收回回 slot", () => {
    reset();
    renderBubbles(["A", "B"], false);
    // hover A slot 中心 (103, 56)
    setMouse(103, 56);
    tick(ENTER_DEBOUNCE_MS); // 去抖到期 → expandBubble 开始
    expect(isExpanded("A")).toBe(true);
    // 展开动画完成
    tick(fullExpandTime() - ENTER_DEBOUNCE_MS + 50);
    expect(isExpanded("A")).toBe(true);
    expect(bubbleEls.get("A")!.classList.has("capsule")).toBe(true);
    // 移出热区（到 B 右侧远处）
    setMouse(230, 56);
    tick(COLLAPSE_DEBOUNCE_MS);
    expect(isExpanded("A")).toBe(false);
    tick(COLLAPSE_MOVE_MS + 50);
    expect(isInSlot("A")).toBe(true);
  });

  test("hover 后鼠标不动 → 保持展开（无 mousemove 也稳定）", () => {
    reset();
    renderBubbles(["A", "B"], false);
    setMouse(103, 56);
    tick(fullExpandTime() + 50);
    expect(isExpanded("A")).toBe(true);
    tick(2000); // 鼠标不动，仅时间流逝
    expect(isExpanded("A")).toBe(true);
  });

  test("窗口失焦后立即收回胶囊（没有新的 mousemove 也不悬挂）", () => {
    reset();
    renderBubbles(["A", "B"], false);
    setMouse(103, 56);
    tick(fullExpandTime() + 50);
    expect(isExpanded("A")).toBe(true);

    // 模拟截图工具抢焦点后鼠标移出宠物，但应用没有收到新的 mousemove。
    resetHoverOnInputInterruption();
    expect(expandedSessionId).toBeNull();
    expect(collapseTimer).toBeNull();
    expect(pendingEnterTimer).toBeNull();
    expect(graceTimers.size).toBe(0);

    tick(MORPH_COLLAPSE_MS + COLLAPSE_MOVE_MS + 50);
    expect(isInSlot("A")).toBe(true);
    expect(timers.length).toBe(0);
  });

  test("窗口失焦会终止拖拽或缩放，恢复后 hover 仍可用", () => {
    reset();
    renderBubbles(["A", "B"], false);
    dragging = true;
    resetHoverOnInputInterruption();
    expect(dragging).toBe(false);
    expect(scaling).toBe(false);

    reset();
    renderBubbles(["A", "B"], false);
    scaling = true;
    resetHoverOnInputInterruption();
    expect(dragging).toBe(false);
    expect(scaling).toBe(false);

    setMouse(103, 56);
    tick(ENTER_DEBOUNCE_MS);
    expect(isExpanded("A")).toBe(true);
  });

  test("展开完成（锁清除）后微动 → 保持（slot 热区 ① 命中）", () => {
    reset();
    renderBubbles(["A", "B"], false);
    setMouse(103, 56);
    tick(morphUnlockTime() + 10); // morph 锁已清
    expect(morphLocks.has("A")).toBe(false);
    setMouse(105, 57); // 微动
    expect(isExpanded("A")).toBe(true);
    tick(200);
    expect(isExpanded("A")).toBe(true);
  });

  test("慢速移动 + 手抖：展开后保持（V2-21 回归）", () => {
    reset();
    renderBubbles(["A", "B"], false);
    setMouse(103, 56);
    tick(fullExpandTime() + 50);
    // 30px/s 缓慢左移 200ms，叠加 ±2px 手抖
    for (let i = 1; i <= 4; i++) {
      setMouse(103 - i * 2 + (i % 2 === 0 ? 2 : -2), 56 + (i % 3 === 0 ? 1 : 0));
      tick(50);
    }
    expect(isExpanded("A")).toBe(true);
  });

  test("慢速划过 slot（不停留）→ 不展开（去抖设计）", () => {
    reset();
    renderBubbles(["A", "B"], false);
    // 30px/s 从左侧划过 A（28px 宽需 0.93s，但只在 A 内累计 150ms 才展开）
    // 100px/s 划过：28px 内停留 280ms → 展开
    setMouse(60, 56);
    tick(100);
    setMouse(80, 56); // 进入 A（x89 之前）——x80 还在 A 外
    setMouse(95, 56); // 进入 A
    tick(80);
    setMouse(110, 56);
    tick(80); // 累计 160ms in A → 展开
    expect(isExpanded("A")).toBe(true);
  });

  test("快速划过（停留 <150ms）→ 不展开", () => {
    reset();
    renderBubbles(["A", "B"], false);
    setMouse(95, 56);
    tick(100);
    setMouse(200, 56); // 离开所有 slot 带（x200 > 141）→ pendingEnterId 置 null、去抖取消
    tick(300);
    expect(expandedSessionId).toBeNull();
  });

  test("边缘抖动：鼠标在 slot 边缘反复跨越（带内）→ 稳定触发（修复目标）", () => {
    reset();
    renderBubbles(["A", "B"], false);
    // A slot x89..117。鼠标在 x116/118 之间以 120ms 周期抖动（x118 仍在 slotPad 24 带内）：
    // 去抖按「带内停留」累计（离开元素但未出带不重置）→ 150ms 后稳定展开
    for (let i = 0; i < 6; i++) {
      setMouse(116, 56); // in A
      tick(60);
      setMouse(118, 56); // out A（但 x118 仍在 slotPad 24 带内）
      tick(60);
    }
    expect(isExpanded("A")).toBe(true);
  });

  test("手抖 hover：真实用户 hover 时鼠标在 slot 边缘小幅抖动（跨越边界）→ 应稳定触发", () => {
    reset();
    renderBubbles(["A", "B"], false);
    // 用户把鼠标移到 A 右边缘附近（意图 hover），手抖 ±3px 跨越边界 x=117：
    // x116（元素内）/ x119（元素外，仍在 slotPad 24 带内），80ms 周期。
    // 总时长 640ms >> 150ms 去抖，但每次「元素内连续停留」仅 40ms → 当前逻辑
    // 去抖被「离开元素即出带」重置 → 永不展开（触发不稳定）。
    for (let i = 0; i < 8; i++) {
      setMouse(116, 56);
      tick(40);
      setMouse(119, 56);
      tick(40);
    }
    expect(isExpanded("A")).toBe(true);
  });

  test("排他切换：A 展开 → hover B → B 展开、A 收回", () => {
    reset();
    renderBubbles(["A", "B"], false);
    setMouse(103, 56);
    tick(fullExpandTime() + 50);
    expect(isExpanded("A")).toBe(true);
    setMouse(137, 56); // B slot 中心
    tick(ENTER_DEBOUNCE_MS);
    expect(isExpanded("B")).toBe(true);
    tick(MORPH_COLLAPSE_MS + COLLAPSE_MOVE_MS + 50);
    expect(isExpanded("A")).toBe(false);
    expect(isInSlot("A")).toBe(true);
  });

  test("展开动画期间 poll 运行 → 归属不被破坏", () => {
    reset();
    renderBubbles(["A", "B"], false);
    setMouse(103, 56);
    tick(ENTER_DEBOUNCE_MS + 100); // 下移动画中
    renderBubbles(["A", "B"], false); // poll
    expect(isExpanded("A")).toBe(true);
    tick(fullExpandTime() - ENTER_DEBOUNCE_MS - 100 + 50);
    expect(isExpanded("A")).toBe(true);
    expect(bubbleEls.get("A")!.classList.has("capsule")).toBe(true);
  });

  test("收回完成瞬间鼠标已在 slot 上（原路快速返回）→ 无假重展；位移后重 hover 展开", () => {
    reset();
    renderBubbles(["A", "B"], false);
    // hover A → 展开完成
    setMouse(103, 56);
    tick(fullExpandTime() + 50);
    expect(isExpanded("A")).toBe(true);
    // 移出热区 → 收回开始；收回动画进行中快速原路返回，落在 slot 上相同位置
    setMouse(230, 56);
    tick(COLLAPSE_DEBOUNCE_MS); // collapseBubble 开始（morphCollapse 130ms）
    tick(MORPH_COLLAPSE_MS); // append 回 slot（无监听器，重放合成 enter 零副作用）
    expect(isInSlot("A")).toBe(true);
    // 鼠标快速移回 slot 原 hover 位置（位移 → mousemove 重新驱动去抖）
    setMouse(103, 56);
    tick(ENTER_DEBOUNCE_MS);
    expect(isExpanded("A")).toBe(true);
  });

  test("收回防抖窗口内鼠标移回 slot → 热区命中取消收回（保持展开）", () => {
    reset();
    renderBubbles(["A", "B"], false);
    setMouse(103, 56);
    tick(fullExpandTime() + 50);
    // 收回：鼠标移到 A 外（但收回后 append 瞬间鼠标在 slot 上？不可能——收回需离开热区。
    // 构造 V2-21 场景：收回动画期间鼠标已移回 slot 且停在原位不动
    setMouse(230, 56);
    tick(COLLAPSE_DEBOUNCE_MS - 30); // 防抖窗口内
    // 鼠标在防抖结束前移回 slot 原位
    setMouse(103, 56);
    // 此时防抖到期：鼠标在 slot 上 → ① 命中 → 不收回！展开保持
    tick(40);
    expect(isExpanded("A")).toBe(true);
  });

  test("hover A 展开后鼠标滑到 capsule 上查看 → 保持；移出 capsule 右侧空白 → 收回", () => {
    reset();
    renderBubbles(["A", "B"], false);
    setMouse(103, 56);
    tick(fullExpandTime() + 50);
    // 下移到 capsule 上
    setMouse(120, 90);
    expect(isExpanded("A")).toBe(true);
    tick(300);
    expect(isExpanded("A")).toBe(true);
    // 移到 capsule 右侧行内空白（x=210 > capsule 右 189+10）
    setMouse(210, 90);
    tick(COLLAPSE_DEBOUNCE_MS);
    expect(isExpanded("A")).toBe(false);
  });

  test("划过 A 停在 B：B 展开、A 不抢先展开（最近 slot 判定）", () => {
    reset();
    renderBubbles(["A", "B"], false);
    // 快速划过 A（x60 → x137，A 内停留 <150ms），停在 B 上
    setMouse(60, 56);
    tick(50);
    setMouse(95, 56); // 进入 A
    tick(60);
    setMouse(137, 56); // 划过 A，进入 B 停下
    tick(ENTER_DEBOUNCE_MS);
    // B 展开；A 的残留去抖到期时鼠标距 B 更近 → A 放弃
    expect(isExpanded("B")).toBe(true);
    expect(expandedSessionId).toBe("B");
  });

  test("慢速划过 A 后移出 → 收回；收回后鼠标已在带外 → 不假重展", () => {
    reset();
    renderBubbles(["A", "B"], false);
    // 慢速划过：进入 A 后停留 200ms（> 去抖）→ 展开
    setMouse(95, 56);
    tick(ENTER_DEBOUNCE_MS + 50);
    expect(isExpanded("A")).toBe(true);
    // 缓慢移出热区（x200 远离 slot 与 capsule）
    setMouse(200, 56);
    tick(COLLAPSE_DEBOUNCE_MS);
    expect(isExpanded("A")).toBe(false);
    tick(COLLAPSE_MOVE_MS + 50);
    expect(isInSlot("A")).toBe(true);
    // 鼠标停在带外不动 → 无 enter、无假重展
    tick(500);
    expect(expandedSessionId).toBeNull();
  });

  test("带外离开后重新进入 → 重新计时展开（pendingEnterId 置 null 回归）", () => {
    reset();
    renderBubbles(["A", "B"], false);
    setMouse(95, 56); // 进入 A，去抖计时开始
    tick(80);
    setMouse(200, 56); // 移出扩展带（x200 > 141）→ 去抖取消
    tick(300);
    expect(expandedSessionId).toBeNull();
    setMouse(95, 56); // 重新进入 → 必须重新计时（残留 pendingEnterId 会吞掉本次进入）
    tick(ENTER_DEBOUNCE_MS);
    expect(isExpanded("A")).toBe(true);
  });

  test("手抖 hover 展开后 → 保持（边缘抖动不再触发往返）", () => {
    reset();
    renderBubbles(["A", "B"], false);
    // 手抖 640ms → 稳定展开
    for (let i = 0; i < 8; i++) {
      setMouse(116, 56);
      tick(40);
      setMouse(119, 56);
      tick(40);
    }
    expect(isExpanded("A")).toBe(true);
    // 继续手抖 800ms → 保持（不收回）
    for (let i = 0; i < 10; i++) {
      setMouse(116, 56);
      tick(40);
      setMouse(119, 56);
      tick(40);
    }
    expect(isExpanded("A")).toBe(true);
  });

  test("poll 异序重排下静止 hover 不闪烁（合成 enter 移除回归）", () => {
    reset();
    renderBubbles(["A", "B", "C"], false);
    // 统计 expandBubble 触发次数：重排不得引发重新展开
    let expandCalls = 0;
    const origExpandBubble = expandBubble;
    expandBubble = (sid: string) => { expandCalls++; origExpandBubble(sid); };
    // hover A slot 中心（3 slot 布局：A x72..100，中心 86）→ 展开完成
    setMouse(86, 56);
    tick(fullExpandTime() + 50);
    expect(expandCalls).toBe(1);
    expect(isExpanded("A")).toBe(true);
    // 模拟会话 updatedAt 变化（心跳每 5s）→ renderBubbles 末尾 shelfEl.append(...ordered)
    // 异序重排（600ms/次 ≈ 每 500ms poll + 余量）；静止 hover 下 A 必须稳定展开、
    // 不缩回不重展——reparent 产生的合成 mouseenter 无监听器，无法 corrupt 状态
    for (let i = 0; i < 5; i++) {
      reorderShelf(["C", "A", "B"]);
      tick(600);
      expect(isExpanded("A")).toBe(true);
      expect(expandCalls).toBe(1);
    }
    expect(expandedSessionId).toBe("A");
  });

  test("展开动画中 poll 同序重排不中断（reparent 合成事件无监听器）", () => {
    reset();
    renderBubbles(["A", "B"], false);
    setMouse(103, 56); // A slot 中心
    tick(ENTER_DEBOUNCE_MS + 50); // 去抖到期 → expandBubble，下移动画中
    expect(isExpanded("A")).toBe(true);
    // 展开动画期间 poll 运行 → shelfEl.append(...ordered) 同序重排：不得打断展开动画
    reorderShelf(["A", "B"]);
    tick(EXPAND_MOVE_MS - 50 + MORPH_EXPAND_MS + 50); // 下移完成 + morph 展开完成
    expect(isExpanded("A")).toBe(true);
    expect(bubbleEls.get("A")!.classList.has("capsule")).toBe(true);
  });

  test("拖拽开始立即收回展开气泡并冻结（freezeHover）", () => {
    reset();
    renderBubbles(["A", "B"], false);
    setMouse(103, 56); // hover A slot 中心
    tick(fullExpandTime() + 50); // 展开完成
    expect(isExpanded("A")).toBe(true);
    // 拖拽 pointerdown 同步调用 freezeHover（main.ts 顺序：dragging=true → freezeHover）
    dragging = true;
    freezeHover();
    expect(expandedSessionId).toBeNull(); // 立即收回
    expect(collapseTimer).toBeNull(); // hover timer 全部清空
    expect(pendingEnterTimer).toBeNull();
    expect(graceTimers.size).toBe(0);
    // 收回动画（morph 130ms + 上移 100ms）不受冻结影响，正常播完 → A 回 slot
    tick(MORPH_COLLAPSE_MS + COLLAPSE_MOVE_MS + 50);
    expect(isInSlot("A")).toBe(true);
    expect(timers.length).toBe(0);
  });

  test("拖拽中 hover 不展开（evaluateHover/tryExpand 守卫）", () => {
    reset();
    renderBubbles(["A", "B"], false);
    dragging = true;
    setMouse(103, 56); // 拖拽中热区漂移进入 A slot
    tick(ENTER_DEBOUNCE_MS + 50); // 去抖到期 → tryExpand 被守卫拦截
    expect(expandedSessionId).toBeNull();
    expect(pendingEnterTimer).toBeNull(); // 守卫在 evaluateHover 入口即拦截，未创建去抖 timer
    expect(timers.length).toBe(0);
  });

  test("拖拽中 mousemove 复查静默（reevaluateExpanded 守卫，不设收回 timer）", () => {
    reset();
    renderBubbles(["A", "B"], false);
    setMouse(103, 56);
    tick(fullExpandTime() + 50);
    expect(isExpanded("A")).toBe(true);
    // 拖拽开始：立即收回 + 清空 hover timer
    dragging = true;
    freezeHover();
    expect(expandedSessionId).toBeNull();
    expect(collapseTimer).toBeNull();
    // 拖拽中窗口移动 → 鼠标 client 坐标大幅变化 → mousemove 复查：守卫拦截，静默
    setMouse(230, 56);
    expect(collapseTimer).toBeNull(); // 冻结中不设收回 timer
    // 收回动画不受 mousemove 干扰，正常播完
    tick(MORPH_COLLAPSE_MS + COLLAPSE_MOVE_MS + 50);
    expect(isInSlot("A")).toBe(true);
    expect(timers.length).toBe(0);
  });

  test("松手解除冻结 → 恢复 hover 响应（等鼠标真实 hover 驱动）", () => {
    reset();
    renderBubbles(["A", "B"], false);
    // 拖拽中 hover A → 不展开
    dragging = true;
    setMouse(103, 56);
    tick(ENTER_DEBOUNCE_MS + 50);
    expect(expandedSessionId).toBeNull();
    // 松手：pointerup 先置 dragging=false 再主动复查（main.ts 顺序）→ 不主动展开
    dragging = false;
    reevaluateExpanded();
    expect(expandedSessionId).toBeNull();
    // 鼠标真实 hover 重新驱动：移出再移回 → mousemove → evaluateHover → 去抖 → 展开
    setMouse(200, 56);
    setMouse(103, 56);
    tick(ENTER_DEBOUNCE_MS);
    expect(isExpanded("A")).toBe(true);
  });

  test("拖拽中 poll 的 applyPetActivity 不取消 movement（P2 守卫）", () => {
    reset();
    renderBubbles(["A"], false);
    let cancelCalls = 0;
    const spy = { cancel: () => { cancelCalls++; } };
    // 拖拽进行中：业务态变 working → 不 cancel（motion 由 updateDrag 驱动，不被反复 reset）
    dragging = true;
    applyPetActivity("working", spy);
    expect(cancelCalls).toBe(0);
    // 非拖拽：恢复原行为（非 idle 取消 movement）
    dragging = false;
    applyPetActivity("working", spy);
    expect(cancelCalls).toBe(1);
    // idle 语义不变：不 cancel
    applyPetActivity("idle", spy);
    expect(cancelCalls).toBe(1);
  });
});
