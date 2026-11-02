import { useMemo, type CSSProperties, type MouseEvent } from 'react';
import { SuperType, type Card, type CardList, type CardTarget, type PokemonCardList } from 'ptcg-server';
import { CardFace } from '../../components/cards/CardFace';
import { publicAssetUrl } from '../../utils/publicAssetUrl';
import { cn } from '../../utils/cn';
import { getCustomEnergyIconPath } from '../board3d/energy-icons.utils';
import {
  BoardEffect,
  SpecialCondition,
  buildBoard2dCardModel,
} from './board2dCardModel';
import styles from './Board2DCard.module.css';

const TOOL_ICONS: Record<string, string> = {
  'Vitality Band': 'assets/tools/vitality-band.png',
  'Bravery Charm': 'assets/tools/bravery-charm.png',
};

export type Board2DCardProps = {
  cardList?: CardList | PokemonCardList | null;
  owner: boolean;
  faceDown?: boolean;
  showCardCount?: boolean;
  scanUrl: (card: Card, list?: CardList | PokemonCardList | null) => string;
  sleeveUrl?: string;
  selectable?: boolean;
  selected?: boolean;
  attachTarget?: boolean;
  prepared?: boolean;
  hideDamage?: boolean;
  className?: string;
  style?: CSSProperties;
  onClick?: (card: Card | undefined, cardList: CardList | PokemonCardList | null | undefined) => void;
  onContextMenu?: (card: Card | undefined, cardList: CardList | PokemonCardList | null | undefined) => void;
  onEnergyClick?: (card: Card) => void;
  onToolClick?: (card: Card) => void;
  cardTarget?: CardTarget;
};

export function Board2DCard({
  cardList,
  owner,
  faceDown = false,
  showCardCount = false,
  scanUrl,
  sleeveUrl,
  selectable = false,
  selected = false,
  attachTarget = false,
  prepared = false,
  hideDamage = false,
  className,
  style,
  onClick,
  onContextMenu,
  onEnergyClick,
  onToolClick,
}: Board2DCardProps) {
  const model = useMemo(
    () => buildBoard2dCardModel(cardList, owner, faceDown),
    [cardList, owner, faceDown],
  );

  const cardbackStyle = useMemo((): CSSProperties | undefined => {
    if (!sleeveUrl && !model.isFaceDown) {
      return undefined;
    }
    const url = sleeveUrl || publicAssetUrl('assets/duo-cardback.svg');
    return { ['--cardback-url' as string]: `url(${url})` };
  }, [sleeveUrl, model.isFaceDown]);

  const cond = model.specialConditions;
  const showLegendStack = !!(model.legendTopCard && model.legendBottomCard);
  /* 纯视觉标记：牌面 supertype → 卡纸侧边染色（见 [data-kind] 规则）。 */
  const kind = !model.isEmpty && !model.isFaceDown
    ? model.mainCard
      ? model.mainCard.superType === SuperType.ENERGY ? 'energy'
        : model.mainCard.superType === SuperType.TRAINER ? 'trainer'
        : 'pokemon'
      : model.dualStadiumLeftCard ? 'stadium' : undefined
    : undefined;
  const hasPaperFace = !model.isEmpty && !model.isFaceDown && !!model.mainCard && !showLegendStack;
  const paperLayers = hasPaperFace && kind === 'pokemon' ? Math.min(Math.max(model.cardCount - 1, 0), 3) : 0;
  const paperLean = model.mainCard ? ((Number(model.mainCard.id) * 17 % 11) - 5) * .24 : 0;
  const classNames = cn(
    styles.card,
    model.isEmpty && styles.empty,
    model.isFaceDown && styles.faceDown,
    selectable && styles.selectable,
    selected && styles.selected,
    attachTarget && styles.attachTarget,
    prepared && styles.prepared,
    cond.includes(SpecialCondition.ASLEEP) && styles.asleep,
    cond.includes(SpecialCondition.CONFUSED) && styles.confused,
    cond.includes(SpecialCondition.PARALYZED) && styles.paralyzed,
    className,
  );

  function handleMainClick(e: MouseEvent) {
    if (!onClick) return;
    e.stopPropagation();
    onClick?.(
      model.mainCard ??
        model.legendTopCard ??
        model.legendBottomCard ??
        model.dualStadiumLeftCard,
      cardList,
    );
  }

  function handleContextMenu(e: MouseEvent) {
    if (!onContextMenu || model.isEmpty) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(model.mainCard ?? model.dualStadiumLeftCard, cardList);
  }

  function handleLegendClick(e: MouseEvent, card: Card) {
    if (!onClick) return; // Board wrappers own inspection; let the click reach them.
    e.stopPropagation();
    onClick(card, cardList);
  }

  if (model.dualStadiumLeftCard && model.dualStadiumRightCard) {
    return (
      <div
        className={classNames}
        data-kind={kind}
        style={{ ...style, ...cardbackStyle }}
        onClick={handleMainClick}
        onContextMenu={handleContextMenu}
      >
        <div className={styles.dualStadium}>
          <CardFace
            className={styles.dualHalf}
            src={scanUrl(model.dualStadiumLeftCard, cardList)}
            card={model.dualStadiumLeftCard}
            name={model.dualStadiumLeftCard.name}
          />
          <CardFace
            className={styles.dualHalf}
            src={scanUrl(model.dualStadiumRightCard, cardList)}
            card={model.dualStadiumRightCard}
            name={model.dualStadiumRightCard.name}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className={classNames}
      data-kind={kind}
      data-empty={model.isEmpty || undefined}
      data-prepared={prepared || undefined}
      data-paper-face={hasPaperFace || undefined}
      style={{ ...style, ...cardbackStyle }}
      onClick={handleMainClick}
      onContextMenu={handleContextMenu}
    >
      {Array.from({ length: paperLayers }, (_, i) => (
        <span key={`paper-${i}`} className={styles.stackLeaf} data-board2d-leaf="under" aria-hidden="true"
          style={{ transform: `translate(${i % 2 === 0 ? -3 - i : 3 + i}px,${3 + i * 2}px) rotate(${i % 2 === 0 ? -2.2 - i * .5 : 2.7 + i * .5}deg)` }} />
      ))}
      {prepared ? <span className={styles.preparedBadge} role="img" aria-label="私密预备牌阵，尚未揭面">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v3" /></svg>
      </span> : null}
      {!model.isFaceDown && model.energyCards.length > 0 ? (
        <div className={styles.energyRow}>
          {model.energyCards.map((energy, i) => {
            const custom = getCustomEnergyIconPath(energy, true);
            const src = custom ? publicAssetUrl(custom) : scanUrl(energy, cardList);
            return (
              <div
                key={`${energy.id}-${i}`}
                className={styles.energyIcon}
                onClick={(e) => {
                  e.stopPropagation();
                  onEnergyClick?.(energy);
                }}
              >
                <CardFace src={src} name={energy.name} card={energy} holoEnabled={false} />
              </div>
            );
          })}
        </div>
      ) : null}

      {model.moreEnergies > 0 ? (
        <div className={styles.energyMore}>+{model.moreEnergies}</div>
      ) : null}

      {model.breakCard ? (
        <div className={styles.breakCard}>
          <CardFace
            src={scanUrl(model.breakCard, cardList)}
            card={model.breakCard}
            name={model.breakCard.name}
          />
        </div>
      ) : null}

      {model.legendTopCard ? (
        <div
          className={styles.legendTopCard}
          onClick={(e) => handleLegendClick(e, model.legendTopCard!)}
        >
          <CardFace
            src={scanUrl(model.legendTopCard, cardList)}
            card={model.legendTopCard}
            name={model.legendTopCard.name}
          />
        </div>
      ) : null}

      {model.legendBottomCard ? (
        <div
          className={styles.legendBottomCard}
          onClick={(e) => handleLegendClick(e, model.legendBottomCard!)}
        >
          <CardFace
            src={scanUrl(model.legendBottomCard, cardList)}
            card={model.legendBottomCard}
            name={model.legendBottomCard.name}
          />
        </div>
      ) : null}

      {hasPaperFace && model.mainCard ? (
        <div className={styles.paper} data-board2d-leaf="face" style={{ transform: `rotate(${paperLean}deg)` }}>
          <CardFace
            className={styles.mainFace}
            src={scanUrl(model.mainCard, cardList)}
            card={model.mainCard}
            name={model.mainCard.name}
            draggable={false}
          />
        </div>
      ) : null}

      {!model.isFaceDown && model.tools.length > 0 ? (
        <div className={styles.toolCards}>
          {model.tools.map((tool, i) => {
            const custom = TOOL_ICONS[tool.name];
            const src = custom ? publicAssetUrl(custom) : scanUrl(tool, cardList);
            return (
              <div
                key={`${tool.id}-tool-${i}`}
                className={styles.toolIcon}
                style={{ top: `calc(20% + ${i * 15}px)` }}
                onClick={(e) => {
                  e.stopPropagation();
                  onToolClick?.(tool);
                }}
              >
                <CardFace src={src} name={tool.name} card={tool} holoEnabled={false} />
              </div>
            );
          })}
        </div>
      ) : null}

      {!hideDamage && model.damage > 0 ? <div className={styles.damage}>{model.damage}</div> : null}

      {cond.includes(SpecialCondition.POISONED) ? (
        <div className={cn(styles.marker, styles.poison)} />
      ) : null}
      {cond.includes(SpecialCondition.PARALYZED) ? (
        <div className={cn(styles.marker, styles.paralyzedMarker)} />
      ) : null}
      {cond.includes(SpecialCondition.CONFUSED) ? (
        <div className={cn(styles.marker, styles.confusedMarker)} />
      ) : null}
      {cond.includes(SpecialCondition.ASLEEP) ? (
        <div className={cn(styles.marker, styles.asleepMarker)} />
      ) : null}
      {cond.includes(SpecialCondition.BURNED) ? (
        <div className={cn(styles.marker, styles.burnedMarker)} />
      ) : null}
      {model.hasImprisonMarker ? (
        <div className={cn(styles.marker, styles.imprisonMarker)} />
      ) : null}

      {model.boardEffect.includes(BoardEffect.ABILITY_USED) ? (
        <div className={styles.abilityUsed} role="img" aria-label="本回合已使用特性">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></svg>
        </div>
      ) : null}

      {showCardCount && model.cardCount > 0 ? (
        <div className={styles.cardCounts}>{model.cardCount}</div>
      ) : null}
    </div>
  );
}
