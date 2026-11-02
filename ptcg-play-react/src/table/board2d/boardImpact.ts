import { CardType } from 'ptcg-server';
import type { AttackAnimationEvent } from '../BoardInteractionService';
import { CARD_SETTLE_MS, cardSpringFrames, cardTransform, type CardPose } from './cardSpring';
import styles from './BoardImpact.module.css';

const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const EASE_MOVE = 'cubic-bezier(0.77, 0, 0.175, 1)';
const palette: Partial<Record<CardType, string>> = {
  [CardType.GRASS]: '#a9e89a', [CardType.FIRE]: '#ffad68', [CardType.WATER]: '#8edbff',
  [CardType.LIGHTNING]: '#ffe58a', [CardType.PSYCHIC]: '#d8b0ff', [CardType.FIGHTING]: '#e9b58c',
  [CardType.DARK]: '#c2b4df', [CardType.METAL]: '#d1e5e8',
};
export const impactColor = (type?: CardType) => type === undefined ? '#f4d193' : palette[type] ?? '#f4d193';
export const impactWeight = (damage: number) => damage >= 200 ? 3 : damage >= 100 ? 2 : 1;

/** Card material, not a screen effect: the mat, hands and controls stay stationary. */
export class BoardImpact {
  private nodes = new Set<HTMLElement>();
  private animations = new Set<Animation>();
  private moves = new Map<Element, Animation>();
  private disposed = false;
  constructor(private reduced: () => boolean) {}

  private mount(className: string, rect: DOMRect, color: string): HTMLDivElement {
    const node = document.createElement('div');
    node.className = className;
    node.setAttribute('aria-hidden', 'true');
    Object.assign(node.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    node.style.setProperty('--impact-color', color);
    document.body.append(node); this.nodes.add(node);
    return node;
  }
  private animate(node: Element, frames: Keyframe[], options: KeyframeAnimationOptions): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const animation = node.animate(frames, { easing: EASE_OUT, ...options });
    this.animations.add(animation);
    return animation.finished.catch(() => undefined).then(() => { this.animations.delete(animation); });
  }
  private move(node: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const previous = this.moves.get(node);
    if (previous) {
      // Interrupt from the presented pose; remove only this controller's additive contribution.
      const presented = new DOMMatrix(getComputedStyle(node).transform);
      previous.cancel();
      const base = new DOMMatrix(getComputedStyle(node).transform);
      if (Math.abs(base.a * base.d - base.b * base.c) > .0001) {
        frames = [{ ...frames[0], transform: base.inverse().multiply(presented).toString() }, ...frames.slice(1)];
      }
    }
    const animation = node.animate(frames, { duration: CARD_SETTLE_MS, easing: 'linear', composite: 'add', ...options });
    this.moves.set(node, animation); this.animations.add(animation);
    return animation.finished.then(() => true, () => false).then(completed => {
      this.animations.delete(animation);
      if (this.moves.get(node) === animation) this.moves.delete(node);
      return completed;
    });
  }
  private remove(node: HTMLElement) { node.remove(); this.nodes.delete(node); }
  private effect(className: string, rect: DOMRect, color: string, frames: Keyframe[], duration: number, delay = 0) {
    const node = this.mount(className, rect, color);
    void this.animate(node, frames, { duration, delay, fill: 'both' }).then(() => this.remove(node));
  }

  /** Includes upside-down seats, condition rotation and board scale. */
  private vector(node: HTMLElement, dx: number, dy: number) {
    let matrix = new DOMMatrix();
    for (let element: HTMLElement | null = node; element; element = element.parentElement) {
      const transform = getComputedStyle(element).transform;
      if (transform !== 'none') {
        const m = new DOMMatrix(transform);
        matrix = new DOMMatrix([m.a, m.b, m.c, m.d, 0, 0]).multiply(matrix);
      }
    }
    const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
    if (Math.abs(determinant) < .0001) return { x: dx, y: dy };
    return { x: (matrix.d * dx - matrix.c * dy) / determinant, y: (matrix.a * dy - matrix.b * dx) / determinant };
  }

  /** Actual public stack layers lag behind the face, fan out, then spring back independently. */
  private loosen(actor: HTMLElement, strength: number, sign: number, delay = 0) {
    actor.querySelectorAll<HTMLElement>('[data-board2d-leaf]').forEach((leaf, index) => {
      const face = leaf.dataset.board2dLeaf === 'face';
      const sideways = sign * (face ? -2 : 3 + index * 2) * strength;
      const local = this.vector(leaf, sideways, (face ? -2 : 2 + index) * strength);
      const pose: CardPose = { ...local, angle: sign * (face ? -2.5 : 3.5 + index * 2) * strength };
      const tail = cardSpringFrames(pose, 540);
      void this.move(leaf, [{ transform: cardTransform(), offset: 0 },
        ...tail.map(frame => ({ ...frame, offset: .065 + Number(frame.offset) * .935 }))],
      { duration: 580, delay: delay + (face ? 0 : 16 + index * 12) });
    });
  }
  private contact(rect: DOMRect, strength: number, delay = 0) {
    const shadow = new DOMRect(rect.left - rect.width * .08, rect.bottom - 6, rect.width * 1.16, 16);
    this.effect(styles.contact, shadow, '#000', [
      { opacity: 0, transform: 'scale(.75,.5)', offset: 0 },
      { opacity: .22 + strength * .05, transform: 'scale(1.1,.8)', offset: .12 },
      { opacity: 0, transform: 'scale(1.25,.6)', offset: 1 },
    ], 280, delay);
  }

  /** Resolve the existing server WaitPrompt at contact; the spring recovery never gates play. */
  attack(actor: HTMLElement, event: AttackAnimationEvent, top: boolean): Promise<void> {
    if (this.reduced()) return this.animate(actor, [{ opacity: .75 }, { opacity: 1 }], { duration: 150 });
    const weight = impactWeight(event.damage ?? 0);
    const direction = top ? 1 : -1;
    const height = actor.getBoundingClientRect().height;
    const windup = this.vector(actor, -3, -Math.min(height * .10, 15) * direction);
    const lunge = this.vector(actor, 2, Math.min(height * (.20 + weight * .045), 48) * direction);
    const contact: CardPose = { ...lunge, angle: direction * 4, sx: 1.035, sy: 1.015 };
    this.loosen(actor, .65, direction);
    return this.move(actor, [
      { transform: cardTransform(), offset: 0, easing: EASE_OUT },
      { transform: cardTransform({ ...windup, angle: -direction * 7, sx: .985, sy: 1.025 }), offset: .45, easing: EASE_MOVE },
      { transform: cardTransform(contact), offset: .91 },
      { transform: cardTransform(contact), offset: 1 },
    ], { duration: 240 }).then(completed => {
      if (completed && !this.disposed) void this.move(actor, cardSpringFrames(contact), {});
    });
  }

  /** Called at the actual flight/face handoff, so a landing is one continuous object. */
  land(actor: HTMLElement, delay = 0) {
    if (this.reduced()) return;
    const rect = actor.getBoundingClientRect();
    const sign = rect.left + rect.width / 2 < innerWidth / 2 ? -1 : 1;
    const local = this.vector(actor, sign * 2, Math.min(rect.height * .045, 7));
    void this.move(actor, cardSpringFrames({ ...local, angle: sign * 5, sx: 1.065, sy: .935 }), { delay });
    this.loosen(actor, 1.15, sign, delay);
    this.contact(rect, 2, delay);
  }

  number(rect: DOMRect, damage: number, heavy = false, color = '#f4d193') {
    const node = this.mount(styles.number, rect, color);
    node.textContent = `−${damage}`;
    node.dataset.weight = heavy ? 'heavy' : 'normal';
    const reduce = this.reduced();
    void this.animate(node, reduce ? [{ opacity: 1 }, { opacity: 1, offset: .7 }, { opacity: 0 }] : [
      { opacity: 0, transform: 'translate(9px,-3px) scale(.95)', offset: 0 },
      { opacity: 1, transform: 'translate(9px,-10px) scale(1.04)', offset: .12 },
      { opacity: 1, transform: 'translate(9px,-12px) scale(1)', offset: .65 },
      { opacity: 0, transform: 'translate(9px,-26px) scale(1)', offset: 1 },
    ], { duration: reduce ? 500 : 720, fill: 'both' }).then(() => this.remove(node));
  }

  hit(rect: DOMRect, target: HTMLElement | null, damage: number, options: { top: boolean; type?: CardType; knockout?: boolean; source?: DOMRect }) {
    if (this.disposed) return;
    const color = impactColor(options.type);
    const weight = impactWeight(damage);
    const reduce = this.reduced();
    if (damage > 0) this.number(rect, damage, weight > 1, color);
    this.effect(styles.flash, rect, color, [{ opacity: 0 }, { opacity: reduce ? .06 : .10 + weight * .025, offset: .1 }, { opacity: 0 }], 120);
    if (options.knockout) {
      const label = this.mount(styles.knockout, rect, color); label.textContent = '击倒';
      void this.animate(label, [{ opacity: 0 }, { opacity: 1, offset: .16 }, { opacity: 1, offset: .65 }, { opacity: 0 }],
        { duration: 650, fill: 'both' }).then(() => this.remove(label));
    }
    if (reduce) return;
    this.contact(rect, weight);
    const source = options.source;
    const dx = source ? rect.left + rect.width / 2 - source.left - source.width / 2 : 0;
    const dy = source ? rect.top + rect.height / 2 - source.top - source.height / 2 : options.top ? -1 : 1;
    const length = Math.hypot(dx, dy) || 1;
    if (target) {
      const distance = Math.min(rect.height * (.09 + weight * .045), 38);
      const local = this.vector(target, dx / length * distance, dy / length * distance);
      const sign = options.top ? -1 : 1;
      const pose = { ...local, angle: sign * (3 + weight * 1.5), sx: 1.035 + weight * .005, sy: .975 - weight * .005 };
      const tail = cardSpringFrames(pose, 570);
      void this.move(target, [
        { transform: cardTransform(), offset: 0, easing: EASE_OUT },
        { transform: cardTransform(pose), offset: .045 },
        ...tail.map(frame => ({ ...frame, offset: .10 + Number(frame.offset) * .90 })),
      ], { duration: 640 });
      this.loosen(target, .8 + weight * .3, sign);
    }
  }

  dispose() {
    this.disposed = true;
    this.animations.forEach(animation => animation.cancel()); this.animations.clear(); this.moves.clear();
    this.nodes.forEach(node => node.remove()); this.nodes.clear();
  }
}
