import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { GamePhase, PlayerType, SlotType, SuperType, type Card, type CardList, type CardType, type Player } from 'ptcg-server';
import type { LocalGameState } from '../types/localGameState';
import type { BoardInteractionService } from '../BoardInteractionService';
import { publicAssetUrl } from '../../utils/publicAssetUrl';
import { cardDisplayName, localizeGameValue } from '../../duo/chineseCatalog';
import { motionMoves, motionSnapshot, type MotionSnapshot } from './boardMotionModel';
import styles from './BoardMotion.module.css';
import { BoardImpact } from './boardImpact';
import { resolveBoardHits } from './boardImpactModel';
import { cardTransform } from './cardSpring';

const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const EASE_MOVE = 'cubic-bezier(0.77, 0, 0.175, 1)';
type Stored = { model: MotionSnapshot; rects: Map<string, DOMRect>; damage: Map<string, number>; key: number; logIds: Set<number>; phase: GamePhase };

export function useBoardMotion(
  root: RefObject<HTMLDivElement | null>, game: LocalGameState, top: Player, bottom: Player,
  scan: (card: Card, list?: CardList | null) => string, interaction: BoardInteractionService, layoutKey: string,
) {
  const previous = useRef<Stored | null>(null);
  const artifacts = useRef(new Set<HTMLElement>());
  const arrivals = useRef(new Set<Animation>());
  const latest = useRef({ top, bottom });
  latest.current = { top, bottom };
  const revealQueue = useRef<{ src: string; name: string }[]>([]);
  const revealActive = useRef(false);
  const generation = useRef(0);
  const reduce = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const impact = useRef<BoardImpact | null>(null);
  const attack = useRef<{ source: DOMRect; type?: CardType; time: number } | null>(null);
  const impacts = () => impact.current ??= new BoardImpact(reduce);

  const attach = (node: HTMLElement) => { document.body.append(node); artifacts.current.add(node); };
  const remove = (node: HTMLElement) => { node.remove(); artifacts.current.delete(node); };
  const playReveal = () => {
    if (revealActive.current || !revealQueue.current.length) return;
    const item = revealQueue.current.shift()!;
    const gen = generation.current;
    revealActive.current = true;
    const node = document.createElement('div');
    node.className = styles.reveal;
    node.setAttribute('role', 'status');
    const title = document.createElement('strong'); title.textContent = '对手打出了';
    const img = document.createElement('img'); img.src = item.src; img.alt = item.name;
    const name = document.createElement('span'); name.textContent = item.name;
    node.append(title, img, name); attach(node);
    void (async () => {
      await node.animate(reduce() ? [{ opacity: 0 }, { opacity: 1 }] : [
        { opacity: 0, transform: 'translateX(32px) rotate(7deg) scale(.95)' },
        { opacity: 1, transform: 'translateX(0) rotate(0) scale(1)' },
      ], { duration: 200, easing: EASE_OUT, fill: 'both' }).finished.catch(() => undefined);
      await new Promise(resolve => window.setTimeout(resolve, 1400));
      if (gen !== generation.current) return;
      await node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, fill: 'forwards' }).finished.catch(() => undefined);
      remove(node); revealActive.current = false; playReveal();
    })();
  };

  useLayoutEffect(() => {
    const host = root.current;
    if (!host) return;
    const model = motionSnapshot(top, bottom);
    const rects = new Map<string, DOMRect>();
    const rect = (selector: string) => {
      const result = host.querySelector(selector)?.getBoundingClientRect();
      if (result?.width && result.height) rects.set(selector, result);
      return result;
    };
    for (const card of model.cards.values()) rect(card.selector);
    for (const side of ['top', 'bottom']) {
      for (const zone of ['hand', 'deck', 'discard']) rect(`[data-board2d-${zone}="${side}"]`);
      rect(`[data-board2d-prize^="${side}-"]`);
    }
    const damage = new Map<string, number>();
    for (const player of [top, bottom]) for (const list of [player.active, ...player.bench]) {
      const pokemon = list.getPokemonCard();
      if (pokemon) damage.set(`${player.id}:${pokemon.id}`, list.damage);
    }
    const old = previous.current?.key === game.localId ? previous.current : null;
    if (!old && previous.current) {
      impact.current?.dispose(); impact.current = null; attack.current = null;
      arrivals.current.forEach(animation => animation.cancel()); arrivals.current.clear();
    }
    previous.current = { model, rects, damage, key: game.localId, logIds: new Set(game.logs.map(log => log.id)), phase: game.state.phase };
    const hits = old ? resolveBoardHits(old.model, model, old.damage, damage,
      game.logs.filter(log => !old.logIds.has(log.id)), old.phase === GamePhase.ATTACK || game.state.phase === GamePhase.ATTACK) : [];
    const knockedOut = new Set(hits.filter(hit => hit.knockout).map(hit => hit.key));
    const knockoutSlots = new Set(hits.filter(hit => hit.knockout).map(hit => hit.card.selector));
    if (!old && game.state.phase !== GamePhase.SETUP) return; // Reconnect is not a replay of past moves.
    const before = old?.model ?? { cards: new Map(), counts: {
      top: { deck: model.counts.top.deck + model.counts.top.hand, hand: 0, prizes: 0 },
      bottom: { deck: model.counts.bottom.deck + model.counts.bottom.hand, hand: 0, prizes: 0 },
    } };
    const movements = motionMoves(before, model).slice(0, 24);
    const flights: Promise<unknown>[] = [];
    movements.forEach((move, index) => {
      // A KO retires one visible stack, not separate full-size energy/tool/evolution cards.
      if (!knockedOut.has(move.key) && move.card?.zone === 'discard' && knockoutSlots.has(move.from)) return;
      const from = old?.rects.get(move.from) ?? rect(move.from);
      const to = rects.get(move.to) ?? rect(move.to);
      if (!from?.width || !to?.width) return;
      const ko = knockedOut.has(move.key);
      const prior = before.cards.get(move.key);
      const entrance = move.card?.card.superType === SuperType.POKEMON &&
        (move.card.zone === 'active' || move.card.zone.startsWith('bench-')) &&
        (prior?.zone === 'hand' || (!prior && move.from.includes('data-board2d-hand')));
      const img = document.createElement('img');
      img.className = styles.flight;
      img.alt = '';
      img.src = move.faceDown || !move.card ? publicAssetUrl('assets/duo-cardback.svg') : scan(move.card.card, move.card.list);
      // Hand-strip bounds are wider than a card; use a realistic card footprint.
      const width = ko ? from.width : Math.min(from.width, 96);
      const height = ko ? from.height : Math.min(from.height, width * 1.4);
      const x = from.left + (from.width - width) / 2;
      const y = from.top + (from.height - height) / 2;
      Object.assign(img.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
      attach(img);
      const endWidth = Math.min(to.width, 104);
      const endHeight = Math.min(to.height, endWidth * 1.4);
      const dx = to.left + (to.width - endWidth) / 2 - x;
      const dy = to.top + (to.height - endHeight) / 2 - y;
      const endAngle = entrance && move.card?.side === 'top' ? 180 : 0;
      const facing = ko && move.card?.side === 'top' ? 180 : entrance ? -12 : -5;
      const start = cardTransform({ angle: facing });
      const end = cardTransform({ x: dx, y: dy, angle: endAngle, sx: endWidth / width, sy: endHeight / height });
      const sign = to.left + to.width / 2 < innerWidth / 2 ? -1 : 1;
      const landingY = Math.min(to.height * .045, 7);
      const landing = cardTransform({ x: dx + sign * 2, y: dy + landingY, angle: endAngle + sign * 5,
        sx: endWidth / width * 1.065, sy: endHeight / height * .935 });
      const flightDelay = Math.min(index, 8) * 40;
      const animation = img.animate(reduce() ? [{ opacity: 0 }, { opacity: .9 }, { opacity: 0 }] : ko ? [
        { opacity: 1, transform: start, offset: 0, easing: EASE_OUT },
        { opacity: 1, transform: cardTransform({ y: -20, angle: facing - 9, sx: 1.05, sy: .96 }), offset: .08 },
        { opacity: 1, transform: cardTransform({ y: -20, angle: facing - 9, sx: 1.05, sy: .96 }), offset: .14, easing: EASE_OUT },
        { opacity: 1, transform: cardTransform({ y: 7, angle: facing + 4, sx: .99, sy: 1.02 }), offset: .34, easing: EASE_MOVE },
        { opacity: .15, transform: end, offset: 1 },
      ] : entrance ? [
        { opacity: 1, transform: start, offset: 0, easing: EASE_OUT },
        { opacity: 1, transform: cardTransform({ x: dx * .92, y: dy - 38, angle: endAngle - sign * 8,
          sx: endWidth / width * 1.16, sy: endHeight / height * 1.16 }), offset: .64, easing: EASE_MOVE },
        { opacity: 1, transform: landing, offset: .97 },
        { opacity: 0, transform: landing, offset: 1 },
      ] : [
        { opacity: .95, transform: start }, { opacity: 1, transform: end },
      ], { duration: reduce() ? 100 : ko ? 760 : entrance ? 300 : 250, delay: flightDelay, easing: entrance || ko ? 'linear' : EASE_MOVE, fill: 'both' });
      if (entrance && !reduce()) {
        const destination = host.querySelector<HTMLElement>(`${move.to} [data-kind]`);
        if (destination) {
          impacts().land(destination, flightDelay + 291);
          const reveal = destination.animate([{ opacity: 0, offset: 0 }, { opacity: 0, offset: .96 }, { opacity: 1, offset: 1 }],
            { duration: 300, delay: flightDelay, fill: 'both' });
          arrivals.current.add(reveal);
          flights.push(reveal.finished.catch(() => undefined).then(() => { reveal.cancel(); arrivals.current.delete(reveal); }));
        }
      }
      flights.push(animation.finished.catch(() => undefined).then(() => remove(img)));
      if (move.card?.side === 'top' && move.card.card.superType === SuperType.TRAINER &&
        prior?.zone !== move.card.zone && (!prior || prior.zone === 'hand')) {
        revealQueue.current.push({ src: scan(move.card.card, move.card.list), name: cardDisplayName(move.card.card) });
      }
    });
    playReveal();
    const finished = Promise.all(flights).then(() => undefined);
    interaction.setPendingDrawAnimationPromise(finished);
    interaction.setPendingHandToDeckAnimationPromise(finished);
    // Damage and KO are driven by public server state/logs, never a client HP prediction.
    for (const hit of hits) {
      const anchor = hit.knockout ? old?.rects.get(hit.card.selector) : rects.get(hit.card.selector);
      if (!anchor) continue;
      const target = hit.knockout ? null : host.querySelector<HTMLElement>(`${hit.card.selector} [data-kind]`);
      if (hit.attack || hit.knockout) {
        const context = attack.current && performance.now() - attack.current.time < 15000 ? attack.current : null;
        impacts().hit(anchor, target, hit.damage, { top: hit.card.side === 'top', knockout: hit.knockout,
          type: context?.type, source: context?.source });
      } else if (hit.damage > 0) impacts().number(anchor, hit.damage);
    }
  }, [game.state, game.logs, game.localId, top, bottom, scan, interaction, root, layoutKey]);

  useEffect(() => {
    const getActor = (id: number, slot: string | number | undefined, index?: number) => {
      const { top, bottom } = latest.current;
      const player = id === top.id ? top : id === bottom.id ? bottom : undefined;
      if (!player) return;
      const value = String(slot).toLowerCase();
      const kind = value === 'bench' || value === String(SlotType.BENCH) ? SlotType.BENCH
        : value === 'active' || value === String(SlotType.ACTIVE) ? SlotType.ACTIVE : undefined;
      if (kind === undefined) return;
      // Active is unique; a Bench event must identify its actual index, including zero.
      const targetIndex = kind === SlotType.ACTIVE ? index ?? 0 : index;
      if (typeof targetIndex !== 'number' || !Number.isInteger(targetIndex) || targetIndex < 0 ||
        (kind === SlotType.ACTIVE ? targetIndex !== 0 : targetIndex >= player.bench.length)) return;
      const seat = player === top ? PlayerType.TOP_PLAYER : PlayerType.BOTTOM_PLAYER;
      return root.current?.querySelector<HTMLElement>(`[data-slot-key="${seat}-${kind}-${targetIndex}"]`);
    };
    const feedback = (node: HTMLElement | null | undefined) => {
      if (!node) return Promise.resolve();
      const keyframes = reduce() ? [{ opacity: .6 }, { opacity: 1 }]
        : [{ transform: 'scale(.95)', opacity: .7 }, { transform: 'scale(1)', opacity: 1 }];
      return node.animate(keyframes, { duration: 250, easing: EASE_OUT }).finished.then(() => undefined).catch(() => undefined);
    };
    const subscriptions = [
      interaction.attackAnimation$.subscribe(event => {
        const slot = getActor(event.playerId, event.slot, event.index);
        const actor = slot?.querySelector<HTMLElement>('[data-kind]');
        attack.current = slot ? { source: slot.getBoundingClientRect(), type: event.cardType, time: performance.now() } : null;
        interaction.setPendingAttackAnimationPromise(actor ? impacts().attack(actor, event, event.playerId === latest.current.top.id) : Promise.resolve());
      }),
      interaction.abilityAnimation$.subscribe(event => {
        const actor = getActor(event.playerId, event.slot, event.index);
        interaction.setPendingAbilityAnimationPromise(feedback(actor));
        if (!actor) return;
        const rect = actor.getBoundingClientRect();
        const text = document.createElement('span'); text.className = styles.ability; text.textContent = String(localizeGameValue(event.abilityName));
        Object.assign(text.style, { left: `${rect.left + rect.width / 2}px`, top: `${rect.top}px` }); attach(text);
        void text.animate([{ opacity: 1 }, { opacity: 1, offset: .75 }, { opacity: 0 }], { duration: 1000 }).finished.catch(() => undefined).then(() => remove(text));
      }),
      interaction.basicAnimation$.subscribe(event => { void feedback(getActor(event.playerId, event.slot, event.index)); }),
      interaction.evolutionAnimation$.subscribe(event => { void feedback(getActor(event.playerId, event.slot, event.index)); }),
      interaction.deckShuffleAnimation$.subscribe(event => {
        const side = event.playerId === latest.current.top.id ? 'top' : 'bottom';
        const deck = root.current?.querySelector<HTMLElement>(`[data-board2d-deck="${side}"]`);
        const result = !deck ? Promise.resolve() : deck.animate(reduce() ? [{ opacity: .65 }, { opacity: 1 }] : [
          { transform: 'translateX(0) rotate(0)' }, { transform: 'translateX(-8px) rotate(-5deg)', offset: .3 },
          { transform: 'translateX(8px) rotate(5deg)', offset: .65 }, { transform: 'translateX(0) rotate(0)' },
        ], { duration: 250, easing: EASE_MOVE }).finished.then(() => undefined).catch(() => undefined);
        interaction.setPendingDeckShuffleAnimationPromise(result);
      }),
    ];
    return () => subscriptions.forEach(s => s.unsubscribe());
  }, [interaction, root]);

  useEffect(() => () => {
    generation.current++;
    revealQueue.current = [];
    for (const node of artifacts.current) { node.getAnimations().forEach(a => a.cancel()); node.remove(); }
    artifacts.current.clear();
    arrivals.current.forEach(animation => animation.cancel()); arrivals.current.clear();
    impact.current?.dispose(); impact.current = null; attack.current = null;
  }, []);
}
