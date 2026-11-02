import {
  DndContext,
  DragOverlay,
  PointerSensor,
  type DragEndEvent,
  type DragStartEvent,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { AttachEnergyPrompt, Card, CardTarget } from 'ptcg-server';
import type { BoardInteractionService } from '../BoardInteractionService';
import type { BoardEffectDestination } from '../boardEffectInteraction';
import { useBoardEffectInteraction, useBoardEffectSubmission } from '../useBoardEffectInteraction';
import { CardType, PlayerType } from 'ptcg-server';
import type { LocalGameState } from '../types/localGameState';
import { CardFace } from '../../components/cards/CardFace';
import { ShellButton } from '../../components/ui/ShellButton';
import { TableConfirmAction } from '../hud/TablePrimaryAction';
import { cn } from '../../utils/cn';
import {
  attachEnergyToRows,
  buildAttachEnergyFilterMap,
  computeAttachEnergyInvalid,
  isEnergyIndexEligible,
  matchesBlockedToTarget,
  snapshotPokemonRows,
  tryAssignDrop,
  type AttachAssignment,
} from './attachEnergyPromptModel';
import { buildPokemonPromptRows, type PokemonItem, type PokemonRow } from './pokemonPromptRows';
import { getPromptPerspectivePlayerId, promptNeedsPerspectiveSwap, remapCardTargetSeat } from './promptPerspective';
import { findItemByTarget } from './removeDamagePromptModel';
import styles from './AttachEnergyPromptPanel.module.css';

function energyDragId(originalIndex: number): string {
  return `attach-energy-${originalIndex}`;
}

/** 属性色宝石的取色（仅视觉）。 */
const ENERGY_GEM_VARS: Record<string, string> = {
  [CardType.GRASS]: 'var(--a-grass)',
  [CardType.FIRE]: 'var(--a-fire)',
  [CardType.WATER]: 'var(--a-water)',
  [CardType.LIGHTNING]: 'var(--a-lightning)',
  [CardType.PSYCHIC]: 'var(--a-psychic)',
  [CardType.FIGHTING]: 'var(--a-fighting)',
  [CardType.DARK]: 'var(--a-darkness)',
  [CardType.METAL]: 'var(--a-metal)',
  [CardType.DRAGON]: 'var(--a-dragon)',
  [CardType.FAIRY]: 'var(--a-psychic)',
  [CardType.COLORLESS]: 'var(--a-colorless)',
};

function energyGemVar(card: Card): string {
  const type = (card as { cardType?: CardType }).cardType;
  return (type != null && ENERGY_GEM_VARS[type]) || 'var(--a-colorless)';
}

function pokeDropId(target: PokemonItem['target']): string {
  return `attach-poke-${target.player}-${target.slot}-${target.index}`;
}

function parseEnergyDragId(id: string): number | null {
  const m = /^attach-energy-(\d+)$/.exec(id);
  return m ? parseInt(m[1], 10) : null;
}

function parsePokeDropId(id: string): PokemonItem['target'] | null {
  const m = /^attach-poke-(\d+)-(\d+)-(\d+)$/.exec(id);
  if (!m) {
    return null;
  }
  return {
    player: parseInt(m[1], 10),
    slot: parseInt(m[2], 10),
    index: parseInt(m[3], 10),
  };
}

function displayPokemonCard(item: PokemonItem): Card | undefined {
  return item.cardList.getPokemonCard() as Card | undefined;
}

function EnergyDraggable(props: {
  originalIndex: number;
  card: Card;
  getScanUrl: (c: Card) => string;
  disabled: boolean;
}) {
  const { originalIndex, card, getScanUrl, disabled } = props;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: energyDragId(originalIndex),
    disabled,
  });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        styles.cardPrompt,
        styles.energyDraggable,
        isDragging && styles.energyDraggableDragging,
        disabled && styles.energyDraggableDisabled,
      )}
      {...listeners}
      {...attributes}
    >
      <CardFace card={card} src={getScanUrl(card)} name={card.name} />
      <span
        className={styles.energyGem}
        style={{ ['--gem' as string]: energyGemVar(card) }}
        aria-hidden="true"
      />
    </div>
  );
}

function PokemonDroppable(props: {
  id: string;
  disabled: boolean;
  children: React.ReactNode;
}) {
  const { id, disabled, children } = props;
  const { setNodeRef, isOver } = useDroppable({ id, disabled });
  return (
    <div
      ref={setNodeRef}
      className={cn(styles.dropSlot, isOver && styles.dropSlotOver, disabled && styles.dropSlotDisabled)}
    >
      {children}
    </div>
  );
}

export type AttachEnergyPromptPanelProps = {
  prompt: AttachEnergyPrompt;
  localGame: LocalGameState;
  boardInteraction: BoardInteractionService;
  clientId: number;
  getScanUrl: (card: Card) => string;
  t: TFunction;
  gameMessageText: (t: TFunction, message: string | number) => string;
  resolve: (id: number, result: unknown) => void | Promise<void>;
};

export function AttachEnergyPromptPanel(props: AttachEnergyPromptPanelProps) {
  const { prompt, localGame, boardInteraction, clientId, getScanUrl, t, gameMessageText, resolve } = props;
  const { allowCancel, max, blocked, blockedTo } = prompt.options;
  const { pending, submit } = useBoardEffectSubmission(prompt.id, resolve);
  const requestRef = useRef<{ promptId: number } | null>(null);
  const frozen = useCallback(() => pending || !!localGame.deleted || !!localGame.replay ||
    requestRef.current?.promptId === prompt.id, [pending, localGame.deleted, localGame.replay, prompt.id]);
  const submitResult = (result: unknown) => {
    if (frozen()) return;
    const request = { promptId: prompt.id };
    requestRef.current = request;
    return submit(result).finally(() => { if (requestRef.current === request) requestRef.current = null; });
  };
  const disabled = pending || !!localGame.deleted || !!localGame.replay;
  const mapTarget = (target: CardTarget) => promptNeedsPerspectiveSwap(prompt, clientId) ? remapCardTargetSeat(target) : target;

  const sourceCards = prompt.cardList.cards;
  const filterMap = useMemo(
    () => buildAttachEnergyFilterMap(sourceCards, prompt.filter, blocked),
    [sourceCards, prompt.filter, blocked],
  );

  const initialRowsRef = useRef<PokemonRow[]>([]);
  const [rows, setRows] = useState<PokemonRow[]>([]);
  const [assignments, setAssignments] = useState<AttachAssignment[]>([]);
  const [selectedEnergyIndex, setSelectedEnergyIndex] = useState<number | null>(null);
  const rowsRef = useRef(rows);
  const assignmentsRef = useRef(assignments);
  rowsRef.current = rows;
  assignmentsRef.current = assignments;

  useEffect(() => {
    const built = buildPokemonPromptRows(
      localGame.state,
      getPromptPerspectivePlayerId(prompt),
      prompt.playerType,
      prompt.slots,
    );
    const snap = snapshotPokemonRows(built);
    initialRowsRef.current = snap;
    setRows(snapshotPokemonRows(built));
    setAssignments([]);
    setSelectedEnergyIndex(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- prompt identity
  }, [prompt.id]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  /** Energy index currently dragged; rendered in `DragOverlay` so it is not clipped by scroll parents. */
  const [overlayEnergyIndex, setOverlayEnergyIndex] = useState<number | null>(null);

  const assignedIndices = useMemo(() => new Set(assignments.map((a) => a.originalIndex)), [assignments]);

  const availableEnergyIndices = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < sourceCards.length; i++) {
      if (assignedIndices.has(i)) {
        continue;
      }
      if (isEnergyIndexEligible(filterMap, i)) {
        out.push(i);
      }
    }
    return out;
  }, [sourceCards, filterMap, assignedIndices]);

  const isInvalid = useMemo(
    () => computeAttachEnergyInvalid(assignments, prompt.options),
    [assignments, prompt.options],
  );

  const canAssign = (oi: number, to: CardTarget): boolean => {
    if (frozen() || !sourceCards[oi] || !isEnergyIndexEligible(filterMap, oi)) return false;
    const current = assignmentsRef.current;
    const item = findItemByTarget(rowsRef.current, to);
    return !current.some((a) => a.originalIndex === oi) && !!item?.cardList.getPokemonCard() &&
      tryAssignDrop(item, current, prompt.options);
  };
  const assign = (oi: number, to: CardTarget) => {
    if (!canAssign(oi, to)) return;
    const card = sourceCards[oi];
    const nextRows = attachEnergyToRows(rowsRef.current, to, card);
    const nextAssignments = [...assignmentsRef.current, { to, originalIndex: oi, card }];
    rowsRef.current = nextRows;
    assignmentsRef.current = nextAssignments;
    setRows(nextRows);
    setAssignments(nextAssignments);
    setSelectedEnergyIndex(null);
  };

  const onDragStart = (event: DragStartEvent) => {
    if (frozen()) return;
    setOverlayEnergyIndex(parseEnergyDragId(String(event.active.id)));
  };

  const onDragEnd = (event: DragEndEvent) => {
    if (frozen()) return;
    setOverlayEnergyIndex(null);
    if (!event.over) return;
    const oi = parseEnergyDragId(String(event.active.id));
    const to = parsePokeDropId(String(event.over.id));
    if (oi !== null && to !== null) assign(oi, to);
  };

  const onDragCancel = () => {
    if (!frozen()) setOverlayEnergyIndex(null);
  };

  const reset = () => {
    if (frozen()) return;
    rowsRef.current = snapshotPokemonRows(initialRowsRef.current);
    assignmentsRef.current = [];
    setRows(rowsRef.current);
    setAssignments([]);
    setSelectedEnergyIndex(null);
  };

  const onConfirm = () => {
    if (frozen() || computeAttachEnergyInvalid(assignmentsRef.current, prompt.options)) return;
    return submitResult(assignmentsRef.current.map((a) => ({ to: a.to, index: a.originalIndex })));
  };

  const title = t('PROMPT_ATTACH_ENERGY_TITLE', { defaultValue: 'Attach energy' });

  const overlayCard =
    overlayEnergyIndex !== null ? sourceCards[overlayEnergyIndex] : undefined;
  const canDrop = (id: string, destination: BoardEffectDestination) => {
    const oi = parseEnergyDragId(id);
    return destination !== 'discard' && oi !== null && canAssign(oi, mapTarget(destination));
  };
  const confirmAction = <TableConfirmAction onCancel={allowCancel ? () => submitResult(null) : undefined}
    cancelDisabled={disabled} disabled={disabled || isInvalid} onClick={onConfirm}>{t('BUTTON_OK')}</TableConfirmAction>;
  const onBoard = useBoardEffectInteraction(boardInteraction, {
    id: `energy-attach-${prompt.id}`, kind: 'energy-attach', title,
    message: gameMessageText(t, prompt.message), progress: `${assignments.length}/${max}`,
    disabled, getScanUrl,
    targets: rows.flatMap((row) => row.items).filter((item) => !!item.cardList.getPokemonCard()).map((item) => ({
      target: mapTarget(item.target), name: displayPokemonCard(item)?.name ?? '',
      selected: assignments.some((a) => a.to.player === item.target.player && a.to.slot === item.target.slot && a.to.index === item.target.index),
      actionLabel: '附加',
      disabled: disabled || selectedEnergyIndex === null || !canAssign(selectedEnergyIndex, item.target),
    })),
    chips: sourceCards.flatMap((card, index) => !isEnergyIndexEligible(filterMap, index) ? [] : [{
      id: energyDragId(index), label: `${card.name}${assignedIndices.has(index) ? ' · 已附加' : ''}`, card,
      source: assignments.find(assignment => assignment.originalIndex === index)?.to && mapTarget(assignments.find(assignment => assignment.originalIndex === index)!.to),
      selected: selectedEnergyIndex === index,
      disabled: disabled || assignedIndices.has(index) || assignments.length >= max,
    }]),
    onChip: (id) => {
      if (frozen()) return;
      const oi = parseEnergyDragId(id);
      if (oi === null || !isEnergyIndexEligible(filterMap, oi) || assignmentsRef.current.some((a) => a.originalIndex === oi) || assignmentsRef.current.length >= max) return;
      setSelectedEnergyIndex((previous) => previous === oi ? null : oi);
    },
    onTarget: (target) => { if (selectedEnergyIndex !== null) assign(selectedEnergyIndex, mapTarget(target)); },
    canDrop, onDrop: (id, destination) => {
      if (!canDrop(id, destination) || destination === 'discard') return;
      assign(parseEnergyDragId(id)!, mapTarget(destination));
    },
    onReset: reset,
  });
  if (onBoard) return confirmAction;

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
      <div className={styles.backdrop} role="presentation">
        <div className={styles.panel} role="dialog" aria-modal="true">
          <div className={styles.promptTitle}>
            <h2 className={styles.title}>{title}</h2>
          </div>

          <div className={styles.promptContent}>
            <p className={styles.message}>{gameMessageText(t, prompt.message)}</p>

            <div className={styles.pokemonPane}>
              {rows.map((row, rowIdx) => (
                <div
                  key={`${row.playerType}-${row.items[0]?.target.slot ?? 's'}-${rowIdx}`}
                  className={cn(
                    styles.pokemonRow,
                    row.playerType === PlayerType.TOP_PLAYER && styles.pokemonRowUpsideDown,
                  )}
                >
                  {row.items.map((item) => {
                    const empty = item.cardList.cards.length === 0;
                    const card = displayPokemonCard(item);
                    const src = !empty && card ? getScanUrl(card) : '';
                    const dropId = pokeDropId(item.target);
                    const dropDisabled =
                      disabled || empty ||
                      matchesBlockedToTarget(item.target, blockedTo ?? []) ||
                      assignments.length >= max;
                    return (
                      <div key={dropId} className={styles.pokeCardWrap}>
                        <PokemonDroppable id={dropId} disabled={dropDisabled}>
                          <div className={cn(styles.slotInner, styles.cardPrompt)}>
                            {empty ? (
                              <div className={styles.emptySlot} />
                            ) : (
                              <CardFace card={card ?? null} src={src} name={card?.name ?? ''} />
                            )}
                          </div>
                        </PokemonDroppable>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className={styles.energyViewport}>
              <div className={styles.energyList}>
                {availableEnergyIndices.map((i) => (
                  <EnergyDraggable
                    key={`e-${prompt.id}-${i}`}
                    originalIndex={i}
                    card={sourceCards[i]}
                    getScanUrl={getScanUrl}
                    disabled={disabled || assignments.length >= max}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className={styles.promptActions}>
            <ShellButton type="button" variant="secondary" onClick={reset} disabled={disabled || assignments.length === 0}>
              {t('PROMPT_RESET', { defaultValue: 'Reset' })}
            </ShellButton>
            <div className={styles.actionsGrow} aria-hidden />
            {confirmAction}
          </div>
        </div>
      </div>

      <DragOverlay zIndex={2000} dropAnimation={null} className={styles.dragOverlay}>
        {overlayCard ? (
          <div className={cn(styles.cardPrompt, styles.energyDraggable, styles.dragOverlayCard)}>
            <CardFace card={overlayCard} src={getScanUrl(overlayCard)} name={overlayCard.name} />
            <span
              className={styles.energyGem}
              style={{ ['--gem' as string]: energyGemVar(overlayCard) }}
              aria-hidden="true"
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
