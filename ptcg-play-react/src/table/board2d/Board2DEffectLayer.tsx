import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { useDndContext, useDraggable, useDroppable } from '@dnd-kit/core';
import { PlayerType, SlotType, type Card, type CardTarget } from 'ptcg-server';
import { CardFace } from '../../components/cards/CardFace';
import { cardDisplayName, localizeGameValue } from '../../duo/chineseCatalog';
import {
  BOARD_EFFECT_DISCARD_DROP_ID,
  boardEffectDragId,
  parseBoardEffectDragId,
  type BoardEffectChip,
  type BoardEffectInteraction,
  type BoardEffectTarget,
} from '../boardEffectInteraction';
import styles from './Board2DEffectLayer.module.css';

type Rect = { left: number; top: number; width: number; height: number };
type Layout = { clip: Rect; root: Rect; slots: Record<string, Rect>; occupiedSlots: string[]; obstacles: Rect[]; hud: Rect[]; persistentHud: Rect[]; handSpace?: Rect; discard?: Rect; ownActive?: Rect };
type CurrentEffect = () => BoardEffectInteraction;
const TOUCH = 44;
const GAP = 5;
const keyOf = (target: CardTarget) => `${target.player}-${target.slot}-${target.index}`;
const right = (rect: Rect) => rect.left + rect.width;
const bottom = (rect: Rect) => rect.top + rect.height;
const styleOf = (rect: Rect): CSSProperties => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
const intersects = (a: Rect, b: Rect, gap = 0) => a.left < right(b) + gap && right(a) + gap > b.left && a.top < bottom(b) + gap && bottom(a) + gap > b.top;
const contains = (outer: Rect, inner: Rect) => inner.left >= outer.left && inner.top >= outer.top && right(inner) <= right(outer) && bottom(inner) <= bottom(outer);
function intersection(...rects: Rect[]): Rect {
  const left = Math.max(...rects.map(rect => rect.left));
  const top = Math.max(...rects.map(rect => rect.top));
  return { left, top, width: Math.max(0, Math.min(...rects.map(right)) - left), height: Math.max(0, Math.min(...rects.map(bottom)) - top) };
}
function rectOf(node: Element): Rect {
  const rect = node.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/** Coordinates remain in CSS pixels: the portal must not inherit the mat's scale/tilt. */
function useBoardGeometry(rootRef: RefObject<HTMLDivElement | null>, effect: BoardEffectInteraction) {
  const [layout, setLayout] = useState<Layout | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) { setLayout(null); return; }
    let frame = 0;
    const update = () => {
      const viewport = root.querySelector<HTMLElement>('[data-board2d-mat-viewport]');
      const visual = window.visualViewport;
      const screen: Rect = { left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0, width: visual?.width ?? window.innerWidth, height: visual?.height ?? window.innerHeight };
      const rootRect = intersection(rectOf(root), screen);
      const clip = intersection(rootRect, viewport ? rectOf(viewport) : rootRect);
      const slots: Record<string, Rect> = {};
      const occupiedSlots: string[] = [];
      root.querySelectorAll<HTMLElement>('[data-slot-key]').forEach(node => {
        if (!node.dataset.slotKey) return;
        const row = node.closest<HTMLElement>('[data-board2d-bench-row]');
        slots[node.dataset.slotKey] = row ? intersection(rectOf(node), rectOf(row)) : rectOf(node);
        if (!node.querySelector('[data-empty="true"]')) occupiedSlots.push(node.dataset.slotKey);
      });
      const discard = root.querySelector<HTMLElement>('[data-board2d-discard="bottom"]');
      const ownActive = root.querySelector<HTMLElement>('[data-board2d-active="bottom"]');
      const obstacles = [...root.querySelectorAll<HTMLElement>('[data-board2d-deck], [data-board2d-discard], [data-board2d-supporter], [data-board2d-lostzone], [data-board2d-prize]:not([data-empty]), [data-board2d-stadium]')]
        .filter(node => getComputedStyle(node).visibility !== 'hidden' && !node.querySelector('[data-empty="true"]')).map(rectOf);
      const hudNodes = [...root.querySelectorAll<HTMLElement>('[data-hand-index]'), ...document.querySelectorAll<HTMLElement>('[data-table-actions]')];
      const hud = hudNodes.map(rectOf);
      const persistentHud = hudNodes.filter(node => !node.closest('[data-board2d-hand="bottom"]')).map(rectOf);
      const hand = root.querySelector<HTMLElement>('[data-board2d-hand="bottom"]');
      const next: Layout = { clip, root: rootRect, slots, occupiedSlots, obstacles, hud, persistentHud, handSpace: hand ? rectOf(hand) : undefined, discard: discard ? rectOf(discard) : undefined, ownActive: ownActive ? rectOf(ownActive) : undefined };
      setLayout(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    const resize = new ResizeObserver(schedule);
    const observe = () => {
      resize.disconnect();
      resize.observe(root);
      root.querySelectorAll<HTMLElement>('[data-slot-key], [data-board2d-mat-viewport], [data-board2d-discard], [data-board2d-active]').forEach(node => resize.observe(node));
    };
    // Parent style/class mutations include mat scaling, perspective and seat/layout changes.
    // The portal is outside this subtree, so these observers cannot observe our own paint.
    const mutations = new MutationObserver(() => { observe(); schedule(); });
    mutations.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'data-slot-key', 'data-empty'] });
    observe();
    update();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [rootRef, effect.id, effect.kind, effect.targets, effect.chips, effect.focusedTarget, effect.disabled]);
  return layout;
}

/** Never clamp an offscreen card onto an edge: only its genuine visible slot can anchor UI. */
function visibleAnchor(rect: Rect | undefined, clip: Rect): rect is Rect {
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  const visible = intersection(rect, clip);
  return visible.width >= Math.min(24, rect.width) && visible.height >= Math.min(32, rect.height);
}

/** Prefer free felt alongside the card, then a small overlap of that card's edge. */
function place(anchor: Rect, width: number, height: number, bounds: Rect, cards: Rect[], occupied: Rect[], preferSide = false, searchBoard = false): Rect | null {
  const x = anchor.left + (anchor.width - width) / 2;
  const y = anchor.top + (anchor.height - height) / 2;
  const below = { left: x, top: bottom(anchor) + GAP, width, height };
  const above = { left: x, top: anchor.top - height - GAP, width, height };
  const beside = [
    { left: right(anchor) + GAP, top: y, width, height },
    { left: anchor.left - width - GAP, top: y, width, height },
  ];
  const candidates = preferSide ? [...beside, below, above] : [below, above, ...beside];
  // Narrow benches can have eight cards: two offset lanes preserve 44px hit areas.
  candidates.push(
    { ...below, top: below.top + height + GAP },
    { ...above, top: above.top - height - GAP },
    ...beside.flatMap(rect => [{ ...rect, top: anchor.top - height - GAP }, { ...rect, top: bottom(anchor) + GAP }]),
    { left: anchor.left, top: bottom(anchor) - Math.min(height, 20), width, height },
    { left: right(anchor) - width, top: anchor.top - Math.max(0, height - 20), width, height },
  );
  for (const candidate of candidates) {
    // Horizontal correction is local to a visible anchor, never a hidden target.
    const rect = { ...candidate, left: Math.max(bounds.left, Math.min(candidate.left, right(bounds) - width)) };
    if (contains(bounds, rect) && !occupied.some(other => intersects(rect, other, 2)) && !cards.some(other => other !== anchor && intersects(rect, other, 1))) return rect;
  }
  // Search nearby free felt rather than covering an unrelated card on a dense bench.
  const nearby: Rect[] = [];
  const search = searchBoard ? bounds : { left: x - 120, top: y - 160, width: 240 + width, height: 320 + height };
  for (let top = search.top; top + height <= bottom(search); top += 20) {
    for (let left = search.left; left + width <= right(search); left += 20) nearby.push({ left, top, width, height });
  }
  nearby.sort((a, b) => Math.hypot(a.left - x, a.top - y) - Math.hypot(b.left - x, b.top - y));
  for (const rect of nearby) {
    if (contains(bounds, rect) && !occupied.some(other => intersects(rect, other, 2)) && !cards.some(other => intersects(rect, other, 1))) return rect;
  }
  // A partly scrolled card can still expose an edge button, but never an offscreen proxy.
  const visible = intersection(anchor, bounds);
  const edge = { left: Math.max(bounds.left, Math.min(anchor.left, right(bounds) - width)), top: Math.max(bounds.top, Math.min(bottom(visible) - 20, bottom(bounds) - height)), width, height };
  if (contains(bounds, edge) && !occupied.some(other => intersects(edge, other, 2)) && !cards.some(other => other !== anchor && intersects(edge, other, 1))) return edge;
  return null;
}

function currentTarget(getEffect: CurrentEffect, key: string) {
  const effect = getEffect();
  const target = effect.targets.find(item => keyOf(item.target) === key);
  return !effect.disabled && target && !target.disabled ? { effect, target } : null;
}
function currentChip(getEffect: CurrentEffect, id: string) {
  const effect = getEffect();
  const chip = effect.chips?.find(item => item.id === id);
  return !effect.disabled && chip && !chip.disabled ? { effect, chip } : null;
}

function useEffectDrag(id: string, disabled: boolean, allowed: () => boolean) {
  const { attributes, listeners, setNodeRef, isDragging, transform } = useDraggable({ id: boardEffectDragId(id), disabled, data: { type: 'board-effect', chipId: id } });
  const { activeNodeRect } = useDndContext();
  const suppressClickUntil = useRef(0);
  useLayoutEffect(() => {
    if (isDragging) suppressClickUntil.current = Infinity;
    else if (suppressClickUntil.current === Infinity) suppressClickUntil.current = Date.now() + 200;
  }, [isDragging]);
  const guardedListeners = Object.fromEntries(Object.entries(listeners ?? {}).map(([name, listener]) => [name, (event: SyntheticEvent) => {
    if (!allowed()) { event.preventDefault(); event.stopPropagation(); return; }
    listener(event);
  }]));
  const ghostStyle: CSSProperties | null = isDragging && transform && activeNodeRect && allowed() ? {
    ...styleOf(activeNodeRect), transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
  } : null;
  return { attributes, listeners: guardedListeners, setNodeRef, isDragging, ghostStyle, canClick: () => Date.now() > suppressClickUntil.current };
}

function DragGhost({ position, children }: { position: CSSProperties | null; children: ReactNode }) {
  // A visual copy only: the original remains registered with the parent's DndContext.
  // Do not install another DragOverlay, which would compete with the board's own one.
  return position ? createPortal(<div className={styles.dragGhost} style={position} aria-hidden="true">{children}</div>, document.body) : null;
}

function Check() {
  return <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><path d="m3 8 3 3 7-7" /></svg>;
}

function Leader({ anchor, control }: { anchor: Rect; control: Rect }) {
  const ax = anchor.left + anchor.width / 2;
  const ay = anchor.top + anchor.height / 2;
  const bx = control.left + control.width / 2;
  const by = control.top + control.height / 2;
  const dx = bx - ax;
  const dy = by - ay;
  const start = Math.min(anchor.width / (2 * Math.abs(dx)), anchor.height / (2 * Math.abs(dy)));
  const end = Math.min(control.width / (2 * Math.abs(dx)), control.height / (2 * Math.abs(dy)));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start + end >= 1) return null;
  return <line x1={ax + dx * start} y1={ay + dy * start} x2={bx - dx * end} y2={by - dy * end} />;
}

function EnergyChip({ chip, getEffect, inspect }: { chip: BoardEffectChip; getEffect: CurrentEffect; inspect: (card: Card) => void }) {
  const allowed = () => !!currentChip(getEffect, chip.id);
  const canDrag = allowed() && !!getEffect().onDrop;
  const drag = useEffectDrag(chip.id, !canDrag, allowed);
  const assignment = chip.label.endsWith(' · 已移动') ? '已移动' : chip.label.endsWith(' · 已附加') ? '已附加' : undefined;
  const unit = getEffect().kind === 'energy-choose' ? chip.label.split(' · ').at(-1) : undefined;
  const source = chip.source;
  const sourceName = source && getEffect().targets.find(target => keyOf(target.target) === keyOf(source))?.name;
  const location = source ? `${source.player === PlayerType.BOTTOM_PLAYER ? '己方' : '对方'}${source.slot === SlotType.ACTIVE ? '战斗场' : `备战${source.index + 1}`}${sourceName ? ` · ${sourceName}` : ''}` : '';
  const caption = location ? `${assignment ? '去向' : '来源'}：${location}` : assignment ?? (getEffect().kind === 'energy-attach' ? '待附加' : '可选能量');
  const captionId = useId();
  const choose = () => { const current = currentChip(getEffect, chip.id); current?.effect.onChip?.(chip.id); };
  return <><div className={styles.chip} data-board-effect-chip={chip.id} data-selected={chip.selected || undefined} data-dragging={drag.isDragging || undefined}>
    <div className={styles.chipControls}>
    {chip.card ? <button type="button" ref={drag.setNodeRef} {...drag.attributes} {...drag.listeners}
      className={styles.energyCard} data-can-drag={canDrag || undefined} aria-disabled={undefined}
      aria-roledescription={canDrag ? drag.attributes['aria-roledescription'] : undefined}
      aria-describedby={canDrag ? drag.attributes['aria-describedby'] : undefined}
      aria-label={`查看${chip.label}详情${canDrag ? '，也可拖动' : ''}`}
      onClick={event => {
        event.stopPropagation();
        const card = getEffect().chips?.find(item => item.id === chip.id)?.card;
        if (card && drag.canClick()) inspect(card);
      }}>
      <CardFace src={getEffect().getScanUrl?.(chip.card) ?? ''} card={chip.card} name={chip.label} draggable={false} />
      {unit ? <span className={styles.unitNumber} aria-hidden="true">{unit}</span> : null}
    </button> : <button type="button" ref={drag.setNodeRef} {...drag.attributes} {...drag.listeners}
      className={styles.textChip} disabled={!allowed()} aria-label={`选择${chip.label}，也可拖动`}
      onClick={event => { event.stopPropagation(); if (allowed() && drag.canClick()) choose(); }}>{chip.label}</button>}
    <button type="button" className={styles.chipSelect} disabled={!allowed() || !getEffect().onChip}
      aria-pressed={!!chip.selected} aria-describedby={captionId} aria-label={assignment ? chip.label : `${chip.selected ? '取消选择' : '选择'}${chip.label}`}
      onClick={event => { event.stopPropagation(); choose(); }}>
      {chip.selected ? <Check /> : null}{assignment ?? (chip.selected ? '已选' : '选择')}
    </button>
    </div>
    <span id={captionId} className={styles.chipCaption} title={caption}>{caption}</span>
  </div><DragGhost position={drag.ghostStyle}>{chip.card ? <CardFace src={getEffect().getScanUrl?.(chip.card) ?? ''} card={chip.card} name={chip.label} draggable={false} /> : chip.label}</DragGhost></>;
}

function TargetAction({ item, position, getEffect, describedBy }: { item: BoardEffectTarget; position: Rect; getEffect: CurrentEffect; describedBy: string }) {
  const effect = getEffect();
  const immediate = effect.kind === 'hand-target';
  const counter = effect.kind.startsWith('damage');
  const canPick = () => {
    const current = currentTarget(getEffect, keyOf(item.target));
    return !!item.tokenId && !!current?.effect.onChip && current.target.tokenId === item.tokenId;
  };
  const drag = useEffectDrag(item.tokenId ?? `target:${keyOf(item.target)}`, !canPick(), canPick);
  const label = immediate ? '出牌' : item.actionLabel ?? (item.selected ? '已选' : item.value !== undefined ? '调整' : '选择');
  const click = () => {
    const current = currentTarget(getEffect, keyOf(item.target));
    if (!current || !drag.canClick()) return;
    const picked = current.effect.chips?.find(chip => chip.selected);
    if (canPick() && (!picked || picked.id === item.tokenId)) current.effect.onChip?.(item.tokenId!);
    else current.effect.onTarget(current.target.target);
  };
  return <><button type="button" ref={drag.setNodeRef} {...drag.attributes} {...drag.listeners}
    className={styles.targetAction} style={styleOf(position)} data-counter={counter || undefined} data-can-drag={canPick() || undefined}
    data-board-effect-target={keyOf(item.target)} data-board-effect-chip={item.tokenId} data-dragging={drag.isDragging || undefined} data-selected={item.selected || undefined}
    aria-disabled={undefined} aria-roledescription={canPick() ? '可拖动指示物' : undefined} aria-pressed={immediate ? undefined : !!item.selected} aria-describedby={describedBy}
    aria-label={immediate ? `以${item.name}为目标并完成出牌` : `${item.name}：${label}${counter ? `，${item.value ?? 0}点` : ''}`}
    disabled={!!effect.disabled || !!item.disabled}
    onClick={event => { event.stopPropagation(); click(); }}>
    {item.selected ? <Check /> : null}<span>{counter ? item.value ?? 0 : label}</span>
  </button><DragGhost position={drag.ghostStyle}><span className={styles.tokenDisc} /><span>{item.tokenLabel ?? '伤害指示物'}</span></DragGhost></>;
}

function Adjuster({ item, position, getEffect }: { item: BoardEffectTarget; position: Rect; getEffect: CurrentEffect }) {
  const adjust = (direction: -1 | 1) => {
    const current = currentTarget(getEffect, keyOf(item.target));
    if (current && current.effect.focusedTarget && keyOf(current.effect.focusedTarget) === keyOf(current.target.target) && (direction < 0 ? current.target.canDecrease : current.target.canIncrease)) current.effect.onAdjust?.(current.target.target, direction);
  };
  const blocked = !!getEffect().disabled || !!item.disabled || !getEffect().onAdjust;
  return <div className={styles.adjuster} style={styleOf(position)} data-stacked={position.height > TOUCH || undefined} role="group" aria-label={`调整${item.name}`}>
    <button type="button" data-board-effect-adjust="decrease" disabled={blocked || !item.canDecrease} aria-label={`减少${item.name}的数值`}
      onClick={event => { event.stopPropagation(); adjust(-1); }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10" /></svg></button>
    <output aria-live="polite" aria-label={`${item.name}：${item.originalValue !== undefined ? `初值${item.originalValue}，` : ''}草稿${item.value ?? 0}`}>
      {item.originalValue !== undefined && item.originalValue !== item.value ? <small>{item.originalValue}<span aria-hidden="true"> → </span></small> : null}
      <strong>{item.value ?? 0}</strong>
    </output>
    <button type="button" data-board-effect-adjust="increase" disabled={blocked || !item.canIncrease} aria-label={`增加${item.name}的数值`}
      onClick={event => { event.stopPropagation(); adjust(1); }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10M8 3v10" /></svg></button>
  </div>;
}

function DiscardLanding({ position, getEffect }: { position: Rect; getEffect: CurrentEffect }) {
  const { active } = useDndContext();
  const effect = getEffect();
  const selected = effect.chips?.find(chip => chip.selected && !chip.disabled);
  const activeId = active ? parseBoardEffectDragId(String(active.id)) : null;
  const canDiscard = (id: string | undefined) => {
    if (!id) return false;
    const current = currentChip(getEffect, id);
    return !!current?.effect.onDrop && !!current.effect.canDrop?.(id, 'discard');
  };
  const accepting = canDiscard(activeId ?? selected?.id);
  const { setNodeRef, isOver } = useDroppable({ id: BOARD_EFFECT_DISCARD_DROP_ID, disabled: !accepting, data: { type: 'board-effect-discard' } });
  return <div ref={setNodeRef} className={styles.discardLanding} style={styleOf(position)} data-over={isOver && accepting || undefined} data-accepting={accepting || undefined}>
    <span className={styles.discardLabel}>{isOver && accepting ? '松手弃置' : '弃牌区'}</span>
    <button type="button" disabled={!canDiscard(selected?.id)} aria-label="弃置所选能量"
      onClick={event => {
        event.stopPropagation();
        const chip = getEffect().chips?.find(item => item.selected && !item.disabled);
        if (chip && canDiscard(chip.id)) getEffect().onDrop?.(chip.id, 'discard');
      }}>弃置<span>所选能量</span></button>
  </div>;
}

/** On crowded screens, temporarily use the inactive hand's space; restore it on cleanup. */
function EnergyHandSpace({ rootRef }: { rootRef: RefObject<HTMLDivElement | null> }) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.dataset.energyTrayDocked = '';
    return () => { delete root.dataset.energyTrayDocked; };
  }, [rootRef]);
  return null;
}

export function Board2DEffectLayer({ effect: rawEffect, rootRef, inspect }: {
  effect: BoardEffectInteraction;
  rootRef: RefObject<HTMLDivElement | null>;
  inspect: (card: Card) => void;
}) {
  const effect = useMemo(() => ({ ...rawEffect,
    targets: rawEffect.targets.map(item => ({ ...item, name: String(localizeGameValue(item.name)) })),
    chips: rawEffect.chips?.map(chip => ({ ...chip, label: chip.card ? chip.label.replace(chip.card.name, cardDisplayName(chip.card)) : chip.label })),
  }), [rawEffect]);
  const latest = useRef(effect);
  latest.current = effect;
  const getEffect = () => latest.current;
  const descriptionId = useId();
  const layerRef = useRef<HTMLDivElement | null>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const layout = useBoardGeometry(rootRef, effect);
  const statusRef = useRef<HTMLElement | null>(null);
  const [statusHeight, setStatusHeight] = useState(96);
  const [showHelp, setShowHelp] = useState(false);
  useLayoutEffect(() => { setShowHelp(false); }, [effect.id]);
  useLayoutEffect(() => {
    const node = statusRef.current;
    if (!node) return;
    const measure = () => setStatusHeight(node.getBoundingClientRect().height);
    const observer = new ResizeObserver(measure);
    observer.observe(node); measure();
    return () => observer.disconnect();
  }, [!!layout, effect.id]);
  useLayoutEffect(() => {
    // Consuming a unit can remove its button. Keep keyboard users in this effect,
    // without stealing focus from the board, dialogs or the parent's completion UI.
    if (lastFocused.current && !lastFocused.current.isConnected && document.activeElement === document.body) {
      const next = layerRef.current?.querySelector<HTMLElement>('[data-board-effect-chip] [aria-pressed]:not(:disabled), button[data-board-effect-target]:not(:disabled)')
        ?? layerRef.current?.querySelector<HTMLElement>('button:not(:disabled), [tabindex="0"]');
      next?.focus({ preventScroll: true });
    }
  });
  if (!layout || layout.clip.width < TOUCH || layout.clip.height < TOUCH || typeof document === 'undefined') return null;
  const clip = layout.root;
  const compact = clip.width <= 600 && effect.targets.length > 12;
  const compactHeading = { left: clip.left + 50, top: clip.top, width: clip.width - 50, height: TOUCH };
  const local = (rect: Rect): Rect => ({ ...rect, left: rect.left - clip.left, top: rect.top - clip.top });
  const bounds = { left: 2, top: 2, width: clip.width - 4, height: clip.height - 4 };
  const slotRects = Object.fromEntries(Object.entries(layout.slots).map(([key, rect]) => [key, local(rect)]));
  const cards = layout.occupiedSlots.map(key => slotRects[key]).filter(rect => rect.width > 0 && rect.height > 0);
  const obstacles = [...cards, ...layout.obstacles.map(local), ...layout.hud.map(local), ...(compact ? [local(compactHeading)] : [])];
  const occupied: Rect[] = [];
  // Put constrained cards first; wide-open anchors can use the remaining nearby felt.
  const room = (item: BoardEffectTarget) => {
    const anchor = slotRects[keyOf(item.target)];
    if (!anchor) return 0;
    let count = 0;
    for (let dy = -120; dy <= 120; dy += 24) for (let dx = -120; dx <= 120; dx += 24) {
      const rect = { left: anchor.left + dx, top: anchor.top + dy, width: TOUCH, height: TOUCH };
      if (contains(bounds, rect) && !obstacles.some(other => other !== anchor && intersects(rect, other, 1))) count++;
    }
    return count;
  };
  const energyTransfer = effect.kind === 'energy-attach' || effect.kind === 'energy-move';
  const focusedKey = effect.focusedTarget ? keyOf(effect.focusedTarget) : undefined;
  // Placement needs its editor; transfers remain complete through counter→target taps.
  // Never spend a transfer destination's touch target on the optional quantity editor.
  const reserveEditor = effect.kind === 'damage-put';
  const orderedTargets = effect.targets.map(item => ({ item, room: compact ? room(item) : 0 })).sort((a, b) =>
    (reserveEditor ? Number(keyOf(b.item.target) === focusedKey) - Number(keyOf(a.item.target) === focusedKey) : 0) || a.room - b.room).map(({ item }) => item);
  const placeEditor = (anchor: Rect) => place(anchor, Math.min(clip.width <= 600 ? 132 : 168, bounds.width), TOUCH, bounds, obstacles, occupied, true)
    ?? place(anchor, TOUCH, TOUCH * 3, bounds, obstacles, occupied, true);
  let adjustPosition: Rect | null = null;
  const targets = orderedTargets.flatMap(item => {
    // Unit payment and discard act on energy chips, not a second source-selection button.
    if (effect.kind === 'energy-choose' || effect.kind === 'energy-discard') return [];
    const absolute = layout.slots[keyOf(item.target)];
    if (!visibleAnchor(absolute, layout.clip)) return [];
    // Use the same rectangle object when excluding the anchor in placement checks.
    const anchor = slotRects[keyOf(item.target)];
    // Energy destinations are the real card itself, not another floating action button.
    if (energyTransfer) return [{ item, anchor, position: anchor }];
    const position = place(anchor, TOUCH, TOUCH, bounds, obstacles, occupied);
    if (!position) return [];
    occupied.push(position);
    if (reserveEditor && keyOf(item.target) === focusedKey && effect.onAdjust && item.value !== undefined) {
      adjustPosition = placeEditor(anchor);
      if (adjustPosition) occupied.push(adjustPosition);
    }
    return [{ item, anchor, position }];
  });
  const focused = targets.find(({ item }) => keyOf(item.target) === focusedKey);
  if (!reserveEditor && focused && effect.onAdjust && focused.item.value !== undefined) {
    adjustPosition = placeEditor(focused.anchor);
    if (adjustPosition) occupied.push(adjustPosition);
  }

  // All authorized energy chips share one tray, independent of their source or draft destination.
  // Source cards may be scrolled out of view; destinations still require a genuinely visible slot.
  const energyChips = effect.kind.startsWith('energy-') ? effect.chips ?? [] : [];
  const cardWidth = Math.max(80, Math.min(112, layout.ownActive?.width ?? 80));
  const cardHeight = Math.round(cardWidth * 1.4);
  const chipWidth = cardWidth + TOUCH;
  const chipHeight = cardHeight + 28;
  const trayHeaderHeight = 22;
  const maxColumns = Math.min(3, energyChips.length, Math.floor(bounds.width / (chipWidth + 6)));
  const traySizes = Array.from({ length: maxColumns }, (_, index) => index + 1).flatMap(columns => {
    const maxRows = Math.min(2, Math.ceil(energyChips.length / columns));
    return Array.from({ length: maxRows }, (_, index) => ({ columns, rows: index + 1 }));
  }).sort((a, b) => b.columns * b.rows - a.columns * a.rows || b.columns - a.columns);
  let energyTray: Rect | null = null;
  for (const { columns, rows } of traySizes) {
    const width = columns * chipWidth + (columns - 1) * 6 + 6;
    const height = rows * chipHeight + (rows - 1) * 6 + 6 + trayHeaderHeight;
    // Find open felt without tying the tray to a particular Pokémon or moving it after each assignment.
    const anchor = { left: bounds.left, top: bounds.top, width: 0, height: 0 };
    energyTray = place(anchor, width, height, bounds, obstacles, occupied, true, true);
    if (energyTray) { occupied.push(energyTray); break; }
  }
  let handDocked = false;
  if (!energyTray && energyChips.length && layout.handSpace) {
    // Keep full-size energy cards reachable when there is no free felt. Only the
    // inactive bottom hand may yield space; Pokémon and confirmation controls stay clear.
    const fallbackObstacles = [...cards, ...layout.obstacles.map(local), ...layout.persistentHud.map(local)];
    for (const { columns } of traySizes.filter(size => size.rows === 1)) {
      const width = columns * chipWidth + (columns - 1) * 6 + 6;
      const height = chipHeight + 6 + trayHeaderHeight;
      energyTray = place(local(layout.handSpace), width, height, bounds, fallbackObstacles, occupied, true, true);
      if (energyTray) { handDocked = true; occupied.push(energyTray); break; }
    }
  }
  const discardAnchor = effect.kind === 'energy-discard' && visibleAnchor(layout.discard, layout.clip) ? layout.discard : null;
  const discard = discardAnchor ? {
    left: Math.max(clip.left, Math.min(discardAnchor.left + (discardAnchor.width - Math.max(TOUCH, discardAnchor.width)) / 2, right(clip) - Math.max(TOUCH, discardAnchor.width))),
    top: Math.max(clip.top, Math.min(discardAnchor.top, bottom(clip) - Math.max(TOUCH, discardAnchor.height))),
    width: Math.max(TOUCH, discardAnchor.width), height: Math.max(TOUCH, discardAnchor.height),
  } : null;
  const preferredStatusWidth = layout.root.width <= 600 ? 220 : 320;
  const availableStatusWidth = handDocked && layout.ownActive
    ? layout.ownActive.left - layout.root.left - 16 : layout.root.width - 170;
  const statusWidth = Math.min(preferredStatusWidth, Math.max(TOUCH, availableStatusWidth));
  const statusBlocks = [...layout.occupiedSlots.map(key => layout.slots[key]), ...layout.obstacles, ...(handDocked ? layout.persistentHud : layout.hud),
    ...occupied.map(rect => ({ ...rect, left: rect.left + clip.left, top: rect.top + clip.top }))];
  const candidates: Rect[] = [
    { left: layout.root.left + 8, top: layout.root.top + 8, width: statusWidth, height: statusHeight },
    { left: layout.root.left + 8, top: Math.max(...layout.occupiedSlots.map(key => bottom(layout.slots[key]))) + 12, width: statusWidth, height: statusHeight },
  ];
  for (let y = layout.root.top + 8; y + statusHeight <= bottom(layout.root) - 8; y += 24) {
    for (let x = layout.root.left + 8; x + statusWidth <= right(layout.root) - 8; x += 24) candidates.push({ left: x, top: y, width: statusWidth, height: statusHeight });
  }
  const statusPosition = compact ? compactHeading : candidates.find(rect => contains(layout.root, rect) && !statusBlocks.some(block => intersects(rect, block, 3))) ?? candidates[0];
  const repeatedMessage = effect.message.replace(/[。，.\s]/g, '') === effect.title.replace(/[。，.\s]/g, '');

  return createPortal(<div ref={layerRef} className={styles.layer} data-board-effect-layer={effect.kind} data-disabled={effect.disabled || undefined}
    onFocusCapture={event => { if (event.target instanceof HTMLElement) lastFocused.current = event.target; }}>
    {handDocked ? <EnergyHandSpace rootRef={rootRef} /> : null}
    <section ref={statusRef} className={styles.status} style={{ left: statusPosition.left, top: statusPosition.top, width: compact ? compactHeading.width : statusWidth }} aria-label={effect.title} aria-busy={!!effect.disabled}>
      <div className={styles.statusHeading}>
        <div><strong>{effect.title}</strong><span role="status" aria-live="polite">{effect.disabled ? '正在处理…' : effect.progress}</span></div>
        {compact ? <button type="button" aria-expanded={showHelp} aria-controls={descriptionId} onClick={event => { event.stopPropagation(); setShowHelp(value => !value); }}>说明</button> : null}
        <button type="button" disabled={!!effect.disabled} onClick={event => { event.stopPropagation(); const current = getEffect(); if (!current.disabled) current.onReset(); }}>重置</button>
      </div>
      <p className={styles.message} id={descriptionId} tabIndex={0} hidden={compact && !showHelp}>
        {repeatedMessage ? null : effect.message}
        {effect.kind === 'hand-target' || effect.kind === 'target-select' ? null : <span className={styles.hint}>{effect.kind === 'energy-choose' ? '每个能量单位独立选择，牌多时向下滚动，罗盘确认。' : effect.kind === 'damage-put' ? '点牌旁指示物加减数量，罗盘确认。' : effect.kind.startsWith('damage') ? '点来源指示物再点目标，也可直接拖动，罗盘确认。' : effect.kind === 'energy-discard' ? '点选能量或拖入真实弃牌区，罗盘确认。' : `在能量选区点“选择”，再点${effect.kind === 'energy-attach' ? '接收能量' : '要移到'}的宝可梦，逐张分配后罗盘确认。`}</span>}
      </p>
    </section>
    <div className={styles.boardClip} style={styleOf(clip)}>
      <svg className={styles.connections} aria-hidden="true">
        {energyTransfer ? null : targets.map(({ item, anchor, position }) => <Leader key={keyOf(item.target)} anchor={anchor} control={position} />)}
      </svg>
      {targets.map(({ item, anchor, position }) => <div key={keyOf(item.target)}>
        {item.selected ? <div className={styles.selectionMark} style={styleOf(anchor)} aria-hidden="true"><Check /></div> : null}
        {item.value !== undefined && item.originalValue !== undefined && item.value !== item.originalValue ? <output className={styles.draftValue} style={{ left: anchor.left + anchor.width / 2, top: anchor.top + 2 }} aria-label={`${item.name}：${item.originalValue ?? 0}变为${item.value}`}><span>{item.originalValue ?? 0}</span><span aria-hidden="true"> → </span><strong>{item.value}</strong></output> : null}
        {energyTransfer ? !item.disabled && !effect.disabled ? <div className={styles.energyDestination} style={styleOf(anchor)} aria-hidden="true"><span>{effect.kind === 'energy-attach' ? '附加到这里' : '移到这里'}</span></div> : null : <TargetAction item={item} position={position} getEffect={getEffect} describedBy={descriptionId} />}
      </div>)}
      {focused && adjustPosition ? <Adjuster item={focused.item} position={adjustPosition} getEffect={getEffect} /> : null}
      {energyTray ? <section className={styles.chipGroup} data-board-effect-energy-tray data-hand-docked={handDocked || undefined} style={{ ...styleOf(energyTray), '--effect-card-width': `${cardWidth}px`, '--effect-card-height': `${cardHeight}px` } as CSSProperties} aria-label={handDocked ? '能量选区（暂用手牌区）' : '能量选区'}>
        <span className={styles.poolLabel}>能量 · {energyChips.length}</span>
        <div className={styles.chipScroll} tabIndex={energyChips.length > 1 ? 0 : undefined} aria-label="能量选区，牌多时向下滚动查看">
          {energyChips.map(chip => <EnergyChip key={chip.id} chip={chip} getEffect={getEffect} inspect={inspect} />)}
        </div>
      </section> : null}
      {discard ? <DiscardLanding position={local(discard)} getEffect={getEffect} /> : null}
    </div>
  </div>, document.body);
}
