import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  useSensor,
  useSensors,
  useDroppable,
  pointerWithin,
  rectIntersection,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  GamePhase,
  PlayerType,
  SlotType,
  Stage,
  SuperType,
  type PokemonCard,
  type Card,
  type CardList,
  type CardTarget,
  type Player,
  type PokemonCardList,
  type ChoosePokemonPrompt,
} from 'ptcg-server';
import { cn } from '../../utils/cn';
import { localizeGameValue } from '../../duo/chineseCatalog';
import { publicAssetUrl } from '../../utils/publicAssetUrl';
import { tableThemeOption } from '../../settings/tableThemes';
import type { TableTheme } from '../../settings/settingsStorage';
import type { LocalGameState } from '../types/localGameState';
import type { BoardInteractionService } from '../BoardInteractionService';
import type { Board3dCardsAdapter } from '../board3d/board3dCardsAdapter';
import type { Board3dGameActions } from '../board3d/board3dGameActions';
import { CardFace } from '../../components/cards/CardFace';
import { Board2DHand } from './Board2DHand';
import { Board2DPlayerHalf } from './Board2DPlayerHalf';
import { Board2DCard } from './Board2DCard';
import {
  parseBoard2dActiveBenchDragId,
  parseBoard2dDropId,
  parseBoard2dHandDragId,
  board2dBoardDropId,
  board2dSlotDropId,
} from './board2dDropIds';
import {
  applyCardInfoResult,
  isBoard2dEnergyTarget,
  handleBoard2dActiveClick,
  handleBoard2dBenchClick,
  handleBoard2dActiveInfo,
  handleBoard2dBenchInfo,
  handleBoard2dDeckClick,
  handleBoard2dDiscardClick,
  handleBoard2dLostZoneClick,
  handleBoard2dPlayFromHand,
  handleBoard2dPrizeClick,
  handleBoard2dRetreat,
  handleBoard2dStadiumClick,
  tryLegendAssemblyClickToPlay,
  resolveClickToPlayTarget,
  type Board2dActionContext,
} from './board2dActions';
import styles from './Board2D.module.css';
import { useBoardMotion } from './useBoardMotion';
import { BoardCoinFlip } from './BoardCoinFlip';
import { pendingTurnOrderPrompt } from '../activeGamePrompt';
import { useOpeningDraft } from './useOpeningDraft';
import { openingSlotCardId } from './openingDraftModel';
import { isSwitchSelection, switchDropTarget } from './board2dSelection';
import type { BoardSelectionItem } from './Board2DSelectionTray';
import { Board2DEffectLayer } from './Board2DEffectLayer';
import { BOARD_EFFECT_DISCARD_DROP_ID, parseBoardEffectDragId, type BoardEffectInteraction } from '../boardEffectInteraction';
import { BoardTouchSensor } from './BoardTouchSensor';

// A finger's actual release point selects the slot, not the overlapping drag image.
const boardCollision: CollisionDetection = args => {
  if (!args.pointerCoordinates) return rectIntersection(args);
  const point = args.pointerCoordinates;
  return pointerWithin(args).filter(hit => {
    const node = args.droppableContainers.find(container => container.id === hit.id)?.node.current;
    const viewport = node?.closest<HTMLElement>('[data-board2d-mat-viewport]');
    if (!viewport) return true; // The unscaled hand is outside this clipped mat.
    const clips = [viewport, node?.closest<HTMLElement>('[data-board2d-bench-row]')].filter((element): element is HTMLElement => !!element);
    return clips.every(element => {
      const rect = element.getBoundingClientRect();
      return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
    });
  }).sort((a, b) => {
    const ra = args.droppableRects.get(a.id), rb = args.droppableRects.get(b.id);
    return (ra ? ra.width * ra.height : Infinity) - (rb ? rb.width * rb.height : Infinity);
  });
};
import { MatPrint } from './MatPrint';
import { TableTurnOrb } from '../hud/TableTurnOrb';
import { TablePrimaryAction } from '../hud/TablePrimaryAction';

function BoardWideDroppable({ children }: { children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id: board2dBoardDropId() });
  return (
    <div ref={setNodeRef} data-board2d-surface style={{ width: '100%', height: '100%', pointerEvents: 'none' }}>
      {children}
    </div>
  );
}

function StadiumMidlineSlot({ cardList, owner, scanUrl, onClick }: {
  cardList: CardList | null;
  owner: boolean;
  scanUrl: (card: Card, list?: CardList | PokemonCardList | null) => string;
  onClick: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: board2dSlotDropId(PlayerType.BOTTOM_PLAYER, SlotType.BOARD, 0) });
  return <div ref={setNodeRef} className={cn(styles.stadiumMidline, isOver && styles.dropHighlight)}>
    <div data-board2d-stadium style={{ width: '100%', height: '100%' }}>
      <Board2DCard cardList={cardList} owner={owner} scanUrl={scanUrl} onClick={onClick} />
    </div>
  </div>;
}

export type Board2DProps = {
  gameState: LocalGameState;
  topPlayer: Player;
  bottomPlayer: Player;
  bottomPlayerHand: CardList;
  topPlayerHand: CardList;
  clientId: number;
  boardInteraction: BoardInteractionService;
  gameActions: Board3dGameActions;
  cardsAdapter: Board3dCardsAdapter;
  perspectiveEnabled: boolean;
  tableTheme?: TableTheme;
  onPassTurn: () => void | Promise<void>;
  adminSpectatorReveal?: { hands?: boolean; prizes?: boolean };
};

function resolveStadium(top?: Player, bottom?: Player): {
  cardList: CardList | null;
  owner: boolean;
} {
  const topStadium = top?.stadium;
  const bottomStadium = bottom?.stadium;
  if (bottomStadium?.cards?.length) {
    return { cardList: bottomStadium, owner: true };
  }
  if (topStadium?.cards?.length) {
    return { cardList: topStadium, owner: false };
  }
  return { cardList: bottomStadium ?? topStadium ?? null, owner: false };
}

export function Board2D(props: Board2DProps) {
  const { t } = useTranslation();
  const {
    gameState,
    topPlayer,
    bottomPlayer,
    bottomPlayerHand,
    topPlayerHand,
    clientId,
    boardInteraction,
    gameActions,
    cardsAdapter,
    perspectiveEnabled,
    tableTheme = 'black-gold',
    onPassTurn,
    adminSpectatorReveal,
  } = props;

  const rootRef = useRef<HTMLDivElement>(null);
  const [boardEffect, setBoardEffect] = useState<BoardEffectInteraction | null>(() => boardInteraction.getBoardEffect());
  const [dragEffectChip, setDragEffectChip] = useState<string | null>(null);
  useLayoutEffect(() => boardInteraction.registerBoardEffectSurface(), [boardInteraction]);
  useEffect(() => {
    const subscription = boardInteraction.boardEffect$.subscribe(setBoardEffect);
    return () => subscription.unsubscribe();
  }, [boardInteraction]);
  const boardHostRef = useRef<HTMLDivElement>(null);
  const boardCanvasRef = useRef<HTMLDivElement>(null);
  // 角色插画桌布；黑金没有插画，由 CSS 绘制。
  const themeOption = tableThemeOption(tableTheme);
  // 角色插画桌布；`mat` 家族没有插画，图案与配色由 CSS 绘制。
  const matAsset = themeOption.asset;
  const [boardScale, setBoardScale] = useState(1);
  const [hostWideEnough, setHostWideEnough] = useState(true);
  const [portrait, setPortrait] = useState(false);
  const [landscapeWidth, setLandscapeWidth] = useState(1280);

  // Separate desktop/portrait geometry; fit the playfield, not the legacy WebGL card-size setting.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const host = boardHostRef.current;
    if (!root || !host) return;

    const LANDSCAPE_H = 860;
    const PORTRAIT_W = 400;
    const PORTRAIT_H = 480;

    const update = () => {
      const { clientWidth: rootW, clientHeight: rootH } = root;
      if (rootW <= 0 || rootH <= 0) return;

      const aspect = rootW / rootH;
      // Opening a keyboard changes visual height, not the phone's orientation.
      const mobilePortrait = rootW <= 600 && (window.matchMedia('(orientation: portrait)').matches ||
        window.screen.orientation?.type.startsWith('portrait'));
      const nextPortrait = mobilePortrait || aspect < 0.85;
      setPortrait(nextPortrait);
      setHostWideEnough(aspect >= 4 / 3);

      const { clientWidth, clientHeight } = host;
      if (clientWidth <= 0 || clientHeight <= 0) return;
      // A real horizontal mat: widen the design space rather than stretching card faces.
      const wideW = Math.round(Math.max(1000, Math.min(2200, clientWidth / clientHeight * LANDSCAPE_H)));
      setLandscapeWidth(wideW);
      const designW = nextPortrait ? PORTRAIT_W : wideW;
      const designH = nextPortrait ? PORTRAIT_H : LANDSCAPE_H;
      // Leave room for the lower edge projected towards the viewer by the tilt.
      // Portrait keeps readable width; short screens scroll the mat instead of shrinking cards.
      const fit = (nextPortrait ? clientWidth / designW : Math.min(clientWidth / designW, clientHeight / designH)) *
        (perspectiveEnabled && aspect >= 4 / 3 && !nextPortrait ? .96 : 1);
      setBoardScale(fit);
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(root);
    ro.observe(host);
    return () => ro.disconnect();
  }, [portrait, perspectiveEnabled]);

  useLayoutEffect(() => {
    const host = boardHostRef.current;
    if (!portrait || !host) return;
    // On shorter screens keep both active Pokémon and the own bench in view first.
    host.scrollTop = Math.min(Math.max(0, host.scrollHeight - host.clientHeight), 96 * boardScale);
  }, [portrait, boardScale]);

  const tipBoard = perspectiveEnabled && hostWideEnough && !portrait;
  const boardTransform = tipBoard
    ? `scale(${boardScale}) rotateX(7deg) translate3d(0, 0, 0)`
    : `scale(${boardScale})`;
  const scanUrl = useCallback(
    (card: Card, list?: CardList | PokemonCardList | null) =>
      cardsAdapter.getScanUrlFor3D(card, list ?? undefined),
    [cardsAdapter],
  );

  const [selectionMode, setSelectionMode] = useState(false);
  const [handPlayCardId, setHandPlayCardId] = useState<number | null>(null);
  const [selectedTargets, setSelectedTargets] = useState<CardTarget[]>([]);
  const [dragCard, setDragCard] = useState<Card | null>(null);
  const [dragSource, setDragSource] = useState<CardTarget | null>(null);
  const [selectionPrompt, setSelectionPrompt] = useState<ChoosePokemonPrompt | null>(null);
  const [dropNotice, setDropNotice] = useState('');
  const opening = useOpeningDraft(gameState, bottomPlayer, clientId, bottomPlayerHand.cards, gameActions);
  useEffect(() => {
    if (!dropNotice) return;
    const timer = window.setTimeout(() => setDropNotice(''), 2000);
    return () => clearTimeout(timer);
  }, [dropNotice]);

  useEffect(() => {
    const subs = [
      boardInteraction.selectionMode$.subscribe(active => {
        setSelectionMode(active);
        if (!active) setHandPlayCardId(null);
      }),
      boardInteraction.selectedTargets$.subscribe(setSelectedTargets),
      boardInteraction.prompt$.subscribe(setSelectionPrompt),
    ];
    return () => subs.forEach((s) => s.unsubscribe());
  }, [boardInteraction]);

  useBoardMotion(rootRef, gameState, topPlayer, bottomPlayer, scanUrl, boardInteraction, boardTransform);

  const ctx: Board2dActionContext = useMemo(
    () => ({
      gameState,
      topPlayer,
      bottomPlayer,
      clientId,
      cardsAdapter,
      gameActions,
      boardInteraction,
    }),
    [
      gameState,
      topPlayer,
      bottomPlayer,
      clientId,
      cardsAdapter,
      gameActions,
      boardInteraction,
    ],
  );

  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const isBottomOwner = bottomPlayer?.id === clientId;
  const canAct = isBottomOwner && !gameState.deleted && !gameState.replay &&
    gameState.state.phase === GamePhase.PLAYER_TURN &&
    gameState.state.players[gameState.state.activePlayer]?.id === clientId &&
    !gameState.state.prompts.some(p => p.result === undefined);
  const canInteract = canAct || opening.editable || (isBottomOwner && (selectionMode || !!boardEffect) && !gameState.deleted && !gameState.replay);
  const handPlaySelecting = selectionMode && boardInteraction.isHandPlayTargetSelectionActive();
  const chooseHandCardsActive = boardInteraction.isChooseHandCardsSelectionActive();
  const legendAssemblyActive = boardInteraction.isLegendAssemblySelectionActive();
  const cancelHandPlay = useCallback(() => {
    boardInteraction.cancelHandPlayTargetSelection();
  }, [boardInteraction]);
  useEffect(() => {
    if (!handPlaySelecting && !legendAssemblyActive) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing &&
        !(event.target instanceof Element && event.target.closest('[role="dialog"]'))) {
        event.preventDefault();
        if (legendAssemblyActive) boardInteraction.cancelSelection();
        else cancelHandPlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handPlaySelecting, legendAssemblyActive, cancelHandPlay, boardInteraction]);
  useEffect(() => {
    if (handPlaySelecting && (!canAct || !bottomPlayerHand.cards.some(card => card.id === handPlayCardId))) {
      boardInteraction.clearHandPlayTargetSelectionSilently();
    }
  }, [handPlaySelecting, canAct, bottomPlayerHand, handPlayCardId, boardInteraction]);
  useEffect(() => () => boardInteraction.clearHandPlayTargetSelectionSilently(), [boardInteraction]);
  const stadium = resolveStadium(topPlayer, bottomPlayer);

  const isTopActive =
    !!gameState.state &&
    topPlayer &&
    gameState.state.players[gameState.state.activePlayer]?.id === topPlayer.id;
  const isBottomActive =
    !!gameState.state &&
    bottomPlayer &&
    gameState.state.players[gameState.state.activePlayer]?.id === bottomPlayer.id;

  const topHandFaceDown =
    !(adminSpectatorReveal?.hands) &&
    topPlayer?.id !== clientId &&
    !(topPlayerHand?.isPublic || topPlayer?.hand?.isPublic);
  const topCards = topPlayerHand?.cards ?? topPlayer?.hand?.cards ?? [];
  const bottomCards = bottomPlayerHand?.cards ?? bottomPlayer?.hand?.cards ?? [];

  const playableIds = useMemo(() => {
    return new Set(bottomPlayer?.playableCardIds ?? []);
  }, [bottomPlayer]);

  const handSelectionHighlights = useMemo(() => {
    if (!selectionMode || (!chooseHandCardsActive && !legendAssemblyActive)) {
      return null;
    }

    const selected = new Set<number>();
    const selectable = new Set<number>();

    for (const target of selectedTargets) {
      if (target.player === PlayerType.BOTTOM_PLAYER && target.slot === SlotType.HAND) {
        selected.add(target.index);
      }
    }

    for (let index = 0; index < bottomCards.length; index++) {
      const target: CardTarget = {
        player: PlayerType.BOTTOM_PLAYER,
        slot: SlotType.HAND,
        index,
      };
      if (boardInteraction.isTargetEligible(target)) {
        selectable.add(index);
      }
    }

    return { selected, selectable };
  }, [
    selectionMode,
    chooseHandCardsActive,
    legendAssemblyActive,
    selectedTargets,
    bottomCards,
    boardInteraction,
  ]);

  const isSelectable = useCallback(
    (target: CardTarget) =>
      selectionMode && boardInteraction.isTargetEligible(target),
    [selectionMode, boardInteraction],
  );

  const energyTargetAction = (target: CardTarget): string | undefined => {
    if (!canInteract || !boardEffect || boardEffect.disabled ||
      (boardEffect.kind !== 'energy-attach' && boardEffect.kind !== 'energy-move') ||
      !boardEffect.chips?.some(chip => chip.selected && !chip.disabled)) return undefined;
    const item = boardEffect.targets.find(item => item.target.player === target.player && item.target.slot === target.slot && item.target.index === target.index);
    return item && !item.disabled ? `${localizeGameValue(item.name)}：${boardEffect.kind === 'energy-attach' ? '附加所选能量' : '将所选能量移到这里'}` : undefined;
  };

  const isSelected = useCallback(
    (target: CardTarget) =>
      selectedTargets.some(
        (t) =>
          t.player === target.player &&
          t.slot === target.slot &&
          t.index === target.index,
      ),
    [selectedTargets],
  );

  const switching = selectionMode && isSwitchSelection(selectionPrompt);
  const getSelectionItem = (target: CardTarget): BoardSelectionItem | null => {
    if (target.slot === SlotType.HAND && target.player !== PlayerType.BOTTOM_PLAYER) return null;
    const player = target.player === PlayerType.BOTTOM_PLAYER ? opening.displayPlayer : topPlayer;
    const list = target.slot === SlotType.HAND ? bottomPlayerHand : target.slot === SlotType.ACTIVE ? player.active : player.bench[target.index];
    if (!list || list.isSecret || (!list.isPublic && player.id !== clientId)) return null;
    const card = target.slot === SlotType.HAND ? list.cards[target.index] :
      (list as PokemonCardList).getPokemonCard?.() ?? list.cards[list.cards.length - 1];
    return card ? { card, list, target } : null;
  };
  const selectTarget = (target: CardTarget) => {
    if (!canInteract) return;
    const currentEffect = boardInteraction.getBoardEffect();
    if (currentEffect) {
      if (!currentEffect.disabled) currentEffect.onTarget(target);
      return;
    }
    if (!selectionMode || !getSelectionItem(target) || !boardInteraction.isTargetEligible(target)) return;
    boardInteraction.toggleTarget(target);
    if (switching && boardInteraction.isSelectionValid()) boardInteraction.confirmSelection();
  };
  const canDragTarget = (target: CardTarget) => {
    if (boardEffect || !canInteract || !getSelectionItem(target)) return false;
    if (selectionMode && !opening.active) {
      if (boardInteraction.isTargetEligible(target)) return true;
      const player = target.player === PlayerType.BOTTOM_PLAYER ? bottomPlayer : topPlayer;
      return switching && target.slot === SlotType.ACTIVE && player.bench.some((list, index) =>
        list.cards.length > 0 && boardInteraction.isTargetEligible({ player: target.player, slot: SlotType.BENCH, index }));
    }
    return target.player === PlayerType.BOTTOM_PLAYER && (opening.active ? opening.editable : canAct);
  };
  const isAttachTarget = useCallback(
    (target: CardTarget) =>
      boardInteraction.isHandPlayTargetSelectionActive() &&
      boardInteraction.isTargetEligible(target),
    [boardInteraction, selectionMode, selectedTargets],
  );

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(BoardTouchSensor),
  );

  const acceptDrop = (target: CardTarget) => {
    if (boardEffect) return !!dragEffectChip && !boardEffect.disabled && !!boardEffect.canDrop?.(dragEffectChip, target);
    if (selectionMode && !opening.active) return switching &&
      !!switchDropTarget(dragSource, target, t => !!getSelectionItem(t) && boardInteraction.isTargetEligible(t));
    if (target.player !== PlayerType.BOTTOM_PLAYER) return false;
    if (opening.editable) return !!dragCard && opening.canDrop(dragCard.id, target);
    if (!canAct) return false;
    if (dragCard?.superType === SuperType.ENERGY) return isBoard2dEnergyTarget(ctx, target);
    if (dragCard?.superType === SuperType.POKEMON && (dragCard as PokemonCard).stage === Stage.BASIC) {
      return target.slot === SlotType.BENCH ? !bottomPlayer.bench[target.index]?.cards.length : target.slot === SlotType.ACTIVE && !bottomPlayer.active.cards.length;
    }
    return target.slot === SlotType.ACTIVE || target.slot === SlotType.BENCH;
  };

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      setDropNotice('');
      const effectChip = parseBoardEffectDragId(String(event.active.id));
      setDragEffectChip(effectChip);
      if (effectChip) {
        setDragSource(null);
        // Effect chips render their own same-size ghost; the hand overlay stays for real cards.
        setDragCard(null);
        return;
      }
      const handIndex = parseBoard2dHandDragId(String(event.active.id));
      const from = handIndex != null ? { player: PlayerType.BOTTOM_PLAYER, slot: SlotType.HAND, index: handIndex } :
        parseBoard2dActiveBenchDragId(String(event.active.id));
      setDragSource(from);
      setDragCard(from ? getSelectionItem(from)?.card ?? null : null);
    },
    [bottomPlayerHand, opening.displayPlayer, topPlayer, clientId],
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDragCard(null);
      setDragSource(null);
      setDragEffectChip(null);
      const { active, over } = event;
      if (!over || !canInteract) {
        return;
      }

      const effectChip = parseBoardEffectDragId(String(active.id));
      const dropTarget = parseBoard2dDropId(String(over.id));
      const currentEffect = boardInteraction.getBoardEffect();
      if (effectChip) {
        const destination = String(over.id) === BOARD_EFFECT_DISCARD_DROP_ID ? 'discard' : dropTarget;
        if (currentEffect && !currentEffect.disabled && destination && currentEffect.canDrop?.(effectChip, destination)) currentEffect.onDrop?.(effectChip, destination);
        return;
      }
      if (currentEffect) return;
      const handIndex = parseBoard2dHandDragId(String(active.id));
      if (opening.active) {
        const from = parseBoard2dActiveBenchDragId(String(active.id));
        const id = handIndex != null ? bottomCards[handIndex]?.id : from ? openingSlotCardId(opening.draft, from.slot, from.index) : null;
        if (id !== null && id !== undefined && dropTarget) opening.move(id, dropTarget);
        return;
      }

      if (selectionMode) {
        const from = handIndex != null ? { player: PlayerType.BOTTOM_PLAYER, slot: SlotType.HAND, index: handIndex } :
          parseBoard2dActiveBenchDragId(String(active.id));
        if (!from || !getSelectionItem(from)) return;
        if (switching) {
          const target = switchDropTarget(from, dropTarget, t => !!getSelectionItem(t) && boardInteraction.isTargetEligible(t));
          if (target) selectTarget(target);
        }
        return;
      }
      if (handIndex != null && dropTarget && canAct) {
        if (bottomCards[handIndex]?.superType === SuperType.ENERGY && !isBoard2dEnergyTarget(ctx, dropTarget)) {
          setDropNotice('能量只能附加给自己的宝可梦');
          return;
        }
        void handleBoard2dPlayFromHand(ctx, handIndex, dropTarget).catch(() => undefined);
        return;
      }
      if (!canAct) return;

      // Retreat: active ↔ bench
      const fromBoard = parseBoard2dActiveBenchDragId(String(active.id));
      if (fromBoard?.player === PlayerType.BOTTOM_PLAYER && dropTarget && dropTarget.player === PlayerType.BOTTOM_PLAYER) {
        if (
          fromBoard.slot === SlotType.ACTIVE &&
          dropTarget.slot === SlotType.BENCH
        ) {
          void handleBoard2dRetreat(ctx, dropTarget.index).catch(() => undefined);
        } else if (
          fromBoard.slot === SlotType.BENCH &&
          dropTarget.slot === SlotType.ACTIVE
        ) {
          void handleBoard2dRetreat(ctx, fromBoard.index).catch(() => undefined);
        }
      }
    },
    [canInteract, canAct, selectionMode, bottomCards, ctx, opening, switching, topPlayer, clientId],
  );

  const onHandCardClick = useCallback(
    async (card: Card, index: number) => {
      const result = await cardsAdapter.showCardInfo({
        card,
        cardList: bottomPlayerHand,
        players: [topPlayer, bottomPlayer],
        options: { enableAbility: canAct && !selectionMode && playableIds.has(card.id) ? { useFromHand: true } : undefined, enableAttack: false },
        onPlayFromHand: canAct && !selectionMode ? () => {
          const latest = ctxRef.current;
          const handIndex = latest.bottomPlayer.hand.cards.findIndex(c => c.id === card.id);
          if (handIndex < 0 || latest.gameState.state.phase !== GamePhase.PLAYER_TURN ||
            latest.gameState.state.players[latest.gameState.state.activePlayer]?.id !== clientId ||
            latest.gameState.state.prompts.some(p => p.result === undefined)) return;
          if (tryLegendAssemblyClickToPlay(latest, card, handIndex)) return;
          const resolved = resolveClickToPlayTarget(latest.bottomPlayer, card);
          if (Array.isArray(resolved)) {
            boardInteraction.startHandPlayTargetSelection(resolved, picked => {
              const current = ctxRef.current;
              const currentIndex = current.bottomPlayer.hand.cards.findIndex(c => c.id === card.id);
              if (picked && currentIndex >= 0) void handleBoard2dPlayFromHand(current, currentIndex, picked).catch(() => undefined);
            });
            setHandPlayCardId(card.id);
          } else if (resolved) {
            void handleBoard2dPlayFromHand(latest, handIndex, resolved).catch(() => undefined);
          }
        } : undefined,
      });
      const latest = ctxRef.current;
      const currentIndex = latest.bottomPlayer.hand.cards.findIndex(c => c.id === card.id);
      if (result && !boardInteraction.isSelectionActive() && currentIndex >= 0 && latest.gameState.state.players[latest.gameState.state.activePlayer]?.id === clientId &&
        latest.gameState.state.phase === GamePhase.PLAYER_TURN && !latest.gameState.state.prompts.some(p => p.result === undefined)) {
        await applyCardInfoResult(latest, result, { player: PlayerType.BOTTOM_PLAYER, slot: SlotType.HAND, index: currentIndex }, card);
      }
    },
    [
      opening, canAct, playableIds, selectionMode, cardsAdapter, bottomPlayerHand, topPlayer, bottomPlayer,
      isBottomOwner, gameState.replay, clientId, boardInteraction, ctx, handPlayCardId, cancelHandPlay,
    ],
  );

  const turnOrder = pendingTurnOrderPrompt(gameState);
  const isChoosingTurnOrder = turnOrder?.playerId === clientId;
  const turnOrderStatus = isChoosingTurnOrder ? '请选择先手或后手' : isBottomOwner ? '等待对方选择先后手' : '等待玩家选择先后手';
  const inSetup = gameState.state.phase === GamePhase.SETUP;
  const showTurnOrderWait = !!turnOrder && !isChoosingTurnOrder && !gameState.replay;
  const orbState = opening.active ? opening.pending ? 'pending' : opening.waiting ? 'waiting' : opening.canConfirm ? 'ready' : 'choose' : inSetup ? 'waiting' : handPlaySelecting || legendAssemblyActive ? 'choose' : gameState.state.phase === GamePhase.FINISHED ? 'finished' : 'turn';
  const statusText = opening.active ? opening.pending ? '正在提交预备牌阵' : opening.waiting ? '已确认，等待对方' : opening.canConfirm ? '牌阵已准备好，可按罗盘确认' : '拖动基础宝可梦到战斗区或备战区；点击查看详情' : turnOrder ? turnOrderStatus : inSetup ? '准备对局' : isBottomActive ? '己方回合' : '对方回合';

  const bottomHandView = <Board2DHand
    inactive={!canInteract}
    cards={opening.displayHand as Card[]}
    handIndexes={opening.displayHand.map(card => bottomCards.findIndex(original => original.id === card.id))}
    draggableCardIds={opening.active ? opening.eligible : handPlaySelecting ? new Set<number>() : canAct ? playableIds : undefined}
    highlightMode={opening.active || chooseHandCardsActive || legendAssemblyActive ? 'selection' : undefined}
    allowDrop={opening.editable}
    cardList={bottomPlayerHand ?? bottomPlayer?.hand}
    interactive={canInteract}
    playableCardIds={canAct ? playableIds : []}
    selectedHandIndexes={handSelectionHighlights?.selected}
    selectableHandIndexes={opening.editable ? new Set(bottomCards.flatMap((card, index) => opening.eligible.has(card.id) ? [index] : [])) : handSelectionHighlights?.selectable}
    scanUrl={scanUrl}
    onCardClick={onHandCardClick}
    onCardSelect={!opening.active && (chooseHandCardsActive || legendAssemblyActive) ? (_card, index) => selectTarget({ player: PlayerType.BOTTOM_PLAYER, slot: SlotType.HAND, index }) : undefined}
    handTag="bottom"
    dense={portrait ? false : undefined}
  />;

  const selectionEffect: BoardEffectInteraction | null = selectionMode && !boardEffect && !opening.active && isBottomOwner ? {
    id: `selection:${gameState.localId}`,
    kind: handPlaySelecting ? 'hand-target' : 'target-select',
    title: switching ? '选择换位宝可梦' : handPlaySelecting ? '选择出牌目标' : legendAssemblyActive ? '选择组合手牌' : '选择宝可梦',
    message: [selectionPrompt && 'message' in selectionPrompt ? t(`GAME_MESSAGES.${selectionPrompt.message}`, { defaultValue: String(selectionPrompt.message) }) : '',
      handPlaySelecting ? '点牌旁「出牌」立即完成出牌；点卡面查看详情' : switching ? '拖到真实换位位置，或点牌旁按钮立即换位；点卡面查看详情' : legendAssemblyActive ? '选择两张配对手牌即可完成组合；点击卡图查看详情' : '点牌旁按钮选择；点击卡面查看详情，最后按罗盘确认'].filter(Boolean).join(' · '),
    progress: `${selectedTargets.length} 个已选`, disabled: !canInteract,
    targets: [PlayerType.BOTTOM_PLAYER, PlayerType.TOP_PLAYER].flatMap(player => {
      const owner = player === PlayerType.BOTTOM_PLAYER ? opening.displayPlayer : topPlayer;
      return [{ player, slot: SlotType.ACTIVE, index: 0 }, ...owner.bench.map((_, index) => ({ player, slot: SlotType.BENCH, index }))]
        .flatMap(target => {
          const item = getSelectionItem(target);
          return item && boardInteraction.isTargetEligible(target) ? [{ target, name: item.card.name, selected: boardInteraction.isTargetSelected(target), actionLabel: switching ? '换到战斗区' : handPlaySelecting ? '选为目标' : boardInteraction.isTargetSelected(target) ? '取消选择' : '选择这张' }] : [];
        });
    }),
    onTarget: selectTarget,
    onReset: () => { if (canInteract && !handPlaySelecting) for (const target of boardInteraction.getPromptSelectedTargets()) boardInteraction.toggleTarget(boardInteraction.toVisualCardTarget(target)); },
  } : null;
  const effectView = boardEffect ?? selectionEffect;
  const hideDamage = (target: CardTarget) => !!effectView?.kind.startsWith('damage') && effectView.targets.some(item =>
    item.target.player === target.player && item.target.slot === target.slot && item.target.index === target.index);

  return (
    <div
      ref={rootRef}
      className={cn(styles.root, portrait && styles.portrait)}
      style={{ ['--design-w' as string]: `${portrait ? 400 : landscapeWidth}px`,
        ['--board-scale' as string]: boardScale,
        ['--playmat-art' as string]: matAsset ? `url("${publicAssetUrl(matAsset)}")` : undefined }}
      data-table-theme={tableTheme}
      data-mat-family={themeOption.family}
      data-portrait={portrait ? '' : undefined}
      data-effect-dense={portrait && (rootRef.current?.clientWidth ?? 0) <= 600 && (effectView?.targets.length ?? 0) > 12 || undefined}
      data-turn={gameState.state.phase === GamePhase.PLAYER_TURN ? isBottomActive ? 'self' : 'opponent' : gameState.state.phase === GamePhase.FINISHED ? 'finished' : 'setup'}
      data-opening={opening.editable && opening.activeRequired && opening.draft.activeId === null ? 'choose' : undefined}
    >
      <DndContext sensors={sensors} collisionDetection={boardCollision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => { setDragCard(null); setDragSource(null); setDragEffectChip(null); }}
        accessibility={{ screenReaderInstructions: { draggable: '点击或按 Enter 查看卡牌详情。拖放执行操作；效果选择时，聚焦高亮卡牌并按 Shift + Enter 可选择目标。' } }}>
        <div className={styles.handsAndBoard}>
          <div
            ref={boardHostRef}
            data-board2d-mat-viewport
            className={cn(
              styles.boardHost,
              tipBoard ? styles.perspective : styles.flat,
            )}
          >
            <div
              ref={boardCanvasRef}
              className={styles.boardCanvas}
              style={{ transform: boardTransform }}
            >
              {themeOption.print ? <MatPrint portrait={portrait} /> : null}
              <div className={styles.matShade} aria-hidden="true" />
              <div className={styles.midRail} aria-hidden="true" />
              <div className={styles.turnMarker} aria-hidden="true" />
              <TableTurnOrb className={styles.turnOrbOpponent} active={isTopActive && gameState.state.phase === GamePhase.PLAYER_TURN} />
              <Board2DHand cards={topCards} cardList={topPlayerHand ?? topPlayer?.hand} opponent
                faceDown={topHandFaceDown} scanUrl={scanUrl} handTag="top" dense={portrait ? false : undefined}
                onCardClick={card => { if (!topHandFaceDown) void cardsAdapter.showCardInfo({ card, cardList: topPlayerHand, players: [topPlayer, bottomPlayer] }); }} />

              <BoardWideDroppable>
              <div className={styles.boardInner}>
                <Board2DPlayerHalf
                  player={topPlayer}
                  playerType={PlayerType.TOP_PLAYER}
                  clientId={clientId}
                  upsideDown
                  isOwner={topPlayer?.id === clientId}
                  canInteract={false}
                  canDragTarget={canDragTarget}
                  onSelectTarget={selectTarget}
                  targetAction={energyTargetAction}
                  canAcceptDrop={acceptDrop}
                  scanUrl={scanUrl}
                  getSleeveUrl={(p) => cardsAdapter.getSleeveUrl(p)}
                  isSelectable={isSelectable}
                  isSelected={isSelected}
                  isAttachTarget={isAttachTarget}
                  hideDamage={hideDamage}
                  onActiveClick={() => void handleBoard2dActiveInfo(ctx, 'top')}
                  onActiveContextMenu={() => void handleBoard2dActiveInfo(ctx, 'top')}
                  onBenchClick={(i) => void handleBoard2dBenchClick(ctx, i, 'top')}
                  onBenchContextMenu={(i) => void handleBoard2dBenchInfo(ctx, i, 'top')}
                  onSupporterClick={() => {
                    const list = topPlayer?.supporter;
                    const card = list?.cards?.[list.cards.length - 1];
                    if (card && list) {
                      void cardsAdapter.showCardInfo({
                        card,
                        cardList: list,
                        players: [topPlayer, bottomPlayer],
                      });
                    }
                  }}
                  onDiscardClick={() => void handleBoard2dDiscardClick(ctx, 'top')}
                  onDeckClick={() => void handleBoard2dDeckClick(ctx, 'top')}
                  onLostZoneClick={() => void handleBoard2dLostZoneClick(ctx, 'top')}
                  onPrizeClick={(prize) =>
                    void handleBoard2dPrizeClick(ctx, topPlayer, prize)
                  }
                  onEnergyClick={(card, _t, list) =>
                    void cardsAdapter.showCardInfo({
                      card,
                      cardList: list,
                      players: [topPlayer, bottomPlayer],
                    })
                  }
                  onToolClick={(card, _t, list) =>
                    void cardsAdapter.showCardInfo({
                      card,
                      cardList: list,
                      players: [topPlayer, bottomPlayer],
                    })
                  }
                />

                <Board2DPlayerHalf
                  player={opening.displayPlayer}
                  draftCardIds={opening.active ? opening.placedIds : undefined}
                  canDragTarget={canDragTarget}
                  onSelectTarget={selectTarget}
                  targetAction={energyTargetAction}
                  canAcceptDrop={acceptDrop}
                  playerType={PlayerType.BOTTOM_PLAYER}
                  clientId={clientId}
                  isOwner={isBottomOwner}
                  canInteract={canInteract}
                  scanUrl={scanUrl}
                  getSleeveUrl={(p) => cardsAdapter.getSleeveUrl(p)}
                  isSelectable={isSelectable}
                  isSelected={isSelected}
                  isAttachTarget={isAttachTarget}
                  hideDamage={hideDamage}
                  onActiveClick={() => void handleBoard2dActiveClick({ ...ctx, bottomPlayer: opening.displayPlayer })}
                  onBenchClick={(i) => void handleBoard2dBenchClick({ ...ctx, bottomPlayer: opening.displayPlayer }, i, 'bottom')}
                  onActiveContextMenu={() => void handleBoard2dActiveInfo({ ...ctx, bottomPlayer: opening.displayPlayer })}
                  onBenchContextMenu={(i) => void handleBoard2dBenchInfo({ ...ctx, bottomPlayer: opening.displayPlayer }, i, 'bottom')}
                  onSupporterClick={() => {
                    const list = bottomPlayer?.supporter;
                    const card = list?.cards?.[list.cards.length - 1];
                    if (card && list) {
                      void cardsAdapter.showCardInfo({
                        card,
                        cardList: list,
                        players: [topPlayer, bottomPlayer],
                      });
                    }
                  }}
                  onDiscardClick={() => void handleBoard2dDiscardClick(ctx, 'bottom')}
                  onDeckClick={() => void handleBoard2dDeckClick(ctx, 'bottom')}
                  onLostZoneClick={() => void handleBoard2dLostZoneClick(ctx, 'bottom')}
                  onPrizeClick={(prize) =>
                    void handleBoard2dPrizeClick(ctx, bottomPlayer, prize)
                  }
                  onEnergyClick={(card, _target, list) => {
                    void cardsAdapter.showCardInfo({
                      card,
                      cardList: list,
                      players: [topPlayer, bottomPlayer],
                    });
                  }}
                  onToolClick={(card, _target, list) => {
                    void cardsAdapter.showCardInfo({
                      card,
                      cardList: list,
                      players: [topPlayer, bottomPlayer],
                    });
                  }}
                />
              </div>
              </BoardWideDroppable>

              <StadiumMidlineSlot
                cardList={stadium.cardList}
                owner={stadium.owner}
                scanUrl={scanUrl}
                onClick={() => void handleBoard2dStadiumClick(ctx, stadium.cardList)}
              />

              {!portrait && bottomHandView}
            </div>
          </div>
          {portrait && bottomHandView}
        </div>

        {effectView && isBottomOwner ? <Board2DEffectLayer effect={effectView} rootRef={rootRef}
          inspect={card => { void cardsAdapter.showCardInfo({ card, players: [topPlayer, bottomPlayer] }); }} /> : null}
        <DragOverlay dropAnimation={null}>
          {dragCard ? (
            <div style={{ width: portrait ? 96 : 112, opacity: 0.95 }}>
              <CardFace
                src={scanUrl(dragCard, bottomPlayerHand)}
                card={dragCard}
                name={dragCard.name}
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      <TablePrimaryAction priority={opening.active ? 50 : 0} state={orbState}
        active={opening.editable || (isBottomActive && gameState.state.phase === GamePhase.PLAYER_TURN)}
        disabled={opening.active ? !opening.canConfirm : !canAct || handPlaySelecting || legendAssemblyActive}
        label={opening.active ? '确认牌阵' : turnOrder ? isChoosingTurnOrder ? '选择先后手' : '等待先后手选择' : inSetup ? '准备对局' : handPlaySelecting ? '选择目标' : legendAssemblyActive ? '组合手牌' : '结束回合'}
        onActivate={opening.active ? opening.submit : inSetup || handPlaySelecting || legendAssemblyActive ? undefined : onPassTurn}
        onCancel={handPlaySelecting ? cancelHandPlay : legendAssemblyActive ? () => boardInteraction.cancelSelection() : undefined} cancelLabel="取消选择" />
      {showTurnOrderWait ? <div className={styles.turnOrderNotice} role="status" data-turn-order-wait>
        <strong>{turnOrderStatus}</strong>
        <span>选择完成后，继续准备开局牌阵。</span>
      </div> : <div className={styles.srOnly} role="status">{statusText}</div>}
      {dropNotice || opening.error ? <div className={styles.dropNotice} role="alert">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5m0 3v1" /></svg>
        <span>{dropNotice || opening.error}</span>
      </div> : null}
      <BoardCoinFlip game={gameState} />
    </div>
  );
}
