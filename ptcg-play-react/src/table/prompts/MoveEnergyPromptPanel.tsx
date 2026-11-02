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
import type { Card, CardTarget, MoveEnergyPrompt } from 'ptcg-server';
import { CardType, PlayerType } from 'ptcg-server';
import type { LocalGameState } from '../types/localGameState';
import type { BoardInteractionService } from '../BoardInteractionService';
import type { BoardEffectDestination } from '../boardEffectInteraction';
import { useBoardEffectInteraction, useBoardEffectSubmission } from '../useBoardEffectInteraction';
import { CardFace } from '../../components/cards/CardFace';
import { ShellButton } from '../../components/ui/ShellButton';
import { TableConfirmAction } from '../hud/TablePrimaryAction';
import { cn } from '../../utils/cn';
import { snapshotPokemonRows } from './attachEnergyPromptModel';
import {
  appendMoveResult,
  buildBlockedCardsForSource,
  buildMoveEnergyResolvePayload,
  buildOriginalCardIndexMap,
  canDropOnTarget,
  canSelectSource,
  computeMoveEnergyInvalid,
  filterEligibleEnergyCards,
  hasMoveEnergyTransferLimit,
  moveEnergyBetweenRows,
  type MoveEnergyTransfer,
} from './moveEnergyPromptModel';
import { buildPokemonPromptRows, type PokemonItem, type PokemonRow } from './pokemonPromptRows';
import { getPromptPerspectivePlayerId, promptNeedsPerspectiveSwap, remapCardTargetSeat } from './promptPerspective';
import { findItemByTarget, targetsEqual } from './removeDamagePromptModel';
import styles from './MoveEnergyPromptPanel.module.css';

function energyDragId(card: Card): string {
  return `move-energy-${card.fullName}-${card.id ?? card.name}`;
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

function pokeDropId(target: CardTarget): string {
  return `move-poke-${target.player}-${target.slot}-${target.index}`;
}

function parseEnergyDragId(id: string, eligibleCards: Card[]): Card | null {
  for (const card of eligibleCards) {
    if (energyDragId(card) === id) {
      return card;
    }
  }
  return null;
}

function parsePokeDropId(id: string): CardTarget | null {
  const m = /^move-poke-(\d+)-(\d+)-(\d+)$/.exec(id);
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
  card: Card;
  getScanUrl: (c: Card) => string;
  disabled: boolean;
}) {
  const { card, getScanUrl, disabled } = props;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: energyDragId(card),
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
  showBlocked?: boolean;
  children: React.ReactNode;
}) {
  const { id, disabled, showBlocked = false, children } = props;
  const { setNodeRef, isOver } = useDroppable({ id, disabled });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        styles.dropSlot,
        isOver && !disabled && styles.dropSlotOver,
        showBlocked && styles.dropSlotBlocked,
      )}
    >
      {children}
    </div>
  );
}

export type MoveEnergyPromptPanelProps = {
  prompt: MoveEnergyPrompt;
  localGame: LocalGameState;
  boardInteraction: BoardInteractionService;
  clientId: number;
  getScanUrl: (card: Card) => string;
  t: TFunction;
  gameMessageText: (t: TFunction, message: string | number) => string;
  resolve: (id: number, result: unknown) => void | Promise<void>;
};

export function MoveEnergyPromptPanel(props: MoveEnergyPromptPanelProps) {
  const { prompt, localGame, boardInteraction, clientId, getScanUrl, t, gameMessageText, resolve } = props;
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
  const { allowCancel, min, max, blockedFrom, blockedTo, blockedMap } = prompt.options;

  const initialRowsRef = useRef<PokemonRow[]>([]);
  const indexMapRef = useRef<Map<Card, number>>(new Map());

  const [rows, setRows] = useState<PokemonRow[]>([]);
  const [selectedSource, setSelectedSource] = useState<CardTarget | undefined>(undefined);
  const [transfers, setTransfers] = useState<MoveEnergyTransfer[]>([]);
  const [selectedEnergyId, setSelectedEnergyId] = useState<string | null>(null);
  const rowsRef = useRef(rows);
  const transfersRef = useRef(transfers);
  rowsRef.current = rows;
  transfersRef.current = transfers;

  useEffect(() => {
    const built = buildPokemonPromptRows(
      localGame.state,
      getPromptPerspectivePlayerId(prompt),
      prompt.playerType,
      prompt.slots,
    );
    const snap = snapshotPokemonRows(built);
    initialRowsRef.current = snap;
    indexMapRef.current = buildOriginalCardIndexMap(snap);
    setRows(snapshotPokemonRows(built));
    setSelectedSource(undefined);
    setTransfers([]);
    setSelectedEnergyId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- prompt identity
  }, [prompt.id]);

  const selectedItem = useMemo(
    () => findItemByTarget(rows, selectedSource),
    [rows, selectedSource],
  );

  const eligibleEnergyCards = useMemo(() => {
    if (!selectedItem) {
      return [];
    }
    const original = findItemByTarget(initialRowsRef.current, selectedItem.target);
    if (!original || !canSelectSource(original, blockedFrom ?? [])) return [];
    const blockedCards = buildBlockedCardsForSource(original, blockedMap ?? []);
    return filterEligibleEnergyCards(original, prompt.filter, blockedCards)
      .filter((card) => selectedItem.cardList.energies.cards.includes(card));
  }, [selectedItem, prompt.filter, blockedMap, blockedFrom]);

  const movedCardSet = useMemo(() => new Set(transfers.map((tr) => tr.card)), [transfers]);

  const visibleEnergyCards = useMemo(
    () => eligibleEnergyCards.filter((card) => !movedCardSet.has(card)),
    [eligibleEnergyCards, movedCardSet],
  );

  const isInvalid = useMemo(
    () => computeMoveEnergyInvalid(transfers, { min, max }),
    [transfers, min, max],
  );

  const atMaxTransfers = hasMoveEnergyTransferLimit(max) && transfers.length >= max;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const [overlayCard, setOverlayCard] = useState<Card | null>(null);

  const onSelectSource = useCallback(
    (item: PokemonItem) => {
      if (frozen() || !canSelectSource(item, blockedFrom ?? [])) {
        return;
      }
      setSelectedSource({ ...item.target });
      setSelectedEnergyId(null);
    },
    [blockedFrom, frozen],
  );

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      if (frozen()) return;
      const card = parseEnergyDragId(String(event.active.id), visibleEnergyCards);
      setOverlayCard(card);
    },
    [visibleEnergyCards, frozen],
  );

  // Eligibility and payload indices always come from the original source, never a shifted draft list.
  const energyEntries = initialRowsRef.current.flatMap((row) => row.items).flatMap((item) => {
    if (!canSelectSource(item, blockedFrom ?? [])) return [];
    return filterEligibleEnergyCards(item, prompt.filter, buildBlockedCardsForSource(item, blockedMap ?? []))
      .map((card) => ({ card, from: item.target,
        id: `move-${item.target.player}-${item.target.slot}-${item.target.index}-${card.id}-${indexMapRef.current.get(card)}` }));
  });
  const canMove = (entry: typeof energyEntries[number] | undefined, to: CardTarget): boolean => {
    if (frozen() || !entry || transfersRef.current.some((tr) => tr.card === entry.card)) return false;
    if (hasMoveEnergyTransferLimit(max) && transfersRef.current.length >= max) return false;
    const fromItem = findItemByTarget(rowsRef.current, entry.from);
    const toItem = findItemByTarget(rowsRef.current, to);
    return !!fromItem?.cardList.energies.cards.includes(entry.card) && !!toItem?.cardList.getPokemonCard() &&
      canDropOnTarget(toItem, entry.from, blockedTo ?? []);
  };
  const move = (entry: typeof energyEntries[number] | undefined, to: CardTarget) => {
    if (!entry || !canMove(entry, to)) return;
    rowsRef.current = moveEnergyBetweenRows(rowsRef.current, entry.from, to, entry.card);
    transfersRef.current = appendMoveResult(transfersRef.current, { from: entry.from, to, card: entry.card });
    setRows(rowsRef.current);
    setTransfers(transfersRef.current);
    setSelectedEnergyId(null);
  };
  const onDragEnd = (event: DragEndEvent) => {
    if (frozen()) return;
    setOverlayCard(null);
    if (!event.over) return;
    const card = parseEnergyDragId(String(event.active.id), visibleEnergyCards);
    const to = parsePokeDropId(String(event.over.id));
    if (card && to) move(energyEntries.find((entry) => entry.card === card), to);
  };
  const onDragCancel = () => { if (!frozen()) setOverlayCard(null); };
  const reset = () => {
    if (frozen()) return;
    rowsRef.current = snapshotPokemonRows(initialRowsRef.current);
    transfersRef.current = [];
    setRows(rowsRef.current);
    setTransfers([]);
    setSelectedSource(undefined);
    setSelectedEnergyId(null);
  };
  const onConfirm = () => {
    if (frozen() || computeMoveEnergyInvalid(transfersRef.current, { min, max })) return;
    return submitResult(buildMoveEnergyResolvePayload(transfersRef.current, indexMapRef.current));
  };

  const title = t('PROMPT_MOVE_ENERGY_TITLE', { defaultValue: 'Move energy' });
  const selectedEntry = energyEntries.find((entry) => entry.id === selectedEnergyId);
  const canDrop = (id: string, destination: BoardEffectDestination) => destination !== 'discard' &&
    canMove(energyEntries.find((entry) => entry.id === id), mapTarget(destination));
  const confirmAction = <TableConfirmAction onCancel={allowCancel ? () => submitResult(null) : undefined}
    cancelDisabled={disabled} disabled={disabled || isInvalid} onClick={onConfirm}>{t('BUTTON_OK')}</TableConfirmAction>;
  const onBoard = useBoardEffectInteraction(boardInteraction, {
    id: `energy-move-${prompt.id}`, kind: 'energy-move', title, message: gameMessageText(t, prompt.message),
    progress: hasMoveEnergyTransferLimit(max) ? `${transfers.length}/${max}` : `${transfers.length}`,
    disabled, getScanUrl, focusedTarget: selectedSource && mapTarget(selectedSource),
    targets: rows.flatMap((row) => row.items).filter((item) => !!item.cardList.getPokemonCard()).map((item) => ({
      target: mapTarget(item.target), name: displayPokemonCard(item)?.name ?? '',
      selected: transfers.some(transfer => targetsEqual(transfer.to, item.target)),
      actionLabel: '移到这里',
      disabled: disabled || !canMove(selectedEntry, item.target),
    })),
    chips: energyEntries.map((entry) => ({ id: entry.id, label: `${entry.card.name}${movedCardSet.has(entry.card) ? ' · 已移动' : ''}`, card: entry.card,
      source: mapTarget(transfers.find(transfer => transfer.card === entry.card)?.to ?? entry.from), selected: selectedEnergyId === entry.id,
      disabled: disabled || movedCardSet.has(entry.card) || atMaxTransfers,
    })),
    onChip: (id) => {
      if (frozen()) return;
      const entry = energyEntries.find((entry) => entry.id === id);
      if (!entry || transfersRef.current.some((tr) => tr.card === entry.card) ||
        (hasMoveEnergyTransferLimit(max) && transfersRef.current.length >= max)) return;
      setSelectedSource(entry.from);
      setSelectedEnergyId((previous) => previous === id ? null : id);
    },
    onTarget: (visualTarget) => {
      if (frozen()) return;
      const target = mapTarget(visualTarget);
      if (selectedEntry && canMove(selectedEntry, target)) { move(selectedEntry, target); return; }
      const item = findItemByTarget(rowsRef.current, target);
      if (!item || !canSelectSource(item, blockedFrom ?? [])) return;
      setSelectedSource(item.target);
      const first = energyEntries.find((entry) => targetsEqual(entry.from, target) && !transfersRef.current.some((tr) => tr.card === entry.card));
      setSelectedEnergyId(first?.id ?? null);
    },
    canDrop, onDrop: (id, destination) => {
      if (destination !== 'discard' && canDrop(id, destination)) move(energyEntries.find((entry) => entry.id === id), mapTarget(destination));
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
                    const isSource = selectedSource !== undefined && targetsEqual(item.target, selectedSource);
                    const sourceDisabled = disabled || !canSelectSource(item, blockedFrom ?? []);
                    const dropDisabled =
                      disabled || selectedSource === undefined ||
                      empty ||
                      !canDropOnTarget(item, selectedSource, blockedTo ?? []) ||
                      atMaxTransfers;
                    const showDropBlocked =
                      selectedSource !== undefined &&
                      (empty || !canDropOnTarget(item, selectedSource, blockedTo ?? []) || atMaxTransfers);
                    return (
                      <div key={dropId} className={styles.pokeCardWrap}>
                        <PokemonDroppable
                          id={dropId}
                          disabled={dropDisabled}
                          showBlocked={showDropBlocked}
                        >
                          <div
                            role="button"
                            tabIndex={sourceDisabled ? -1 : 0}
                            className={cn(
                              styles.sourceButton,
                              isSource && styles.sourceSelected,
                              sourceDisabled && styles.sourceButtonDisabled,
                            )}
                            onClick={() => !sourceDisabled && onSelectSource(item)}
                            onKeyDown={(e) => {
                              if (!sourceDisabled && (e.key === 'Enter' || e.key === ' ')) {
                                e.preventDefault();
                                onSelectSource(item);
                              }
                            }}
                            aria-pressed={isSource}
                            aria-disabled={sourceDisabled}
                          >
                            <div className={cn(styles.slotInner, styles.cardPrompt)}>
                              {empty ? (
                                <div className={styles.emptySlot} />
                              ) : (
                                <CardFace card={card ?? null} src={src} name={card?.name ?? ''} />
                              )}
                            </div>
                          </div>
                        </PokemonDroppable>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className={styles.energyViewport}>
              {selectedItem ? (
                <div className={styles.energyList}>
                  {visibleEnergyCards.map((card) => (
                    <EnergyDraggable
                      key={energyDragId(card)}
                      card={card}
                      getScanUrl={getScanUrl}
                      disabled={disabled || atMaxTransfers}
                    />
                  ))}
                </div>
              ) : (
                <p className={styles.energyHint}>
                  {t('REACT_MOVE_ENERGY_SELECT_SOURCE', {
                    defaultValue: 'Select a Pokémon to move energy from.',
                  })}
                </p>
              )}
            </div>
          </div>

          <div className={styles.promptActions}>
            <ShellButton type="button" variant="secondary" onClick={reset} disabled={disabled || transfers.length === 0}>
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
