import { PokemonCard } from '../../../game/store/card/pokemon-card';
import { Stage, CardType } from '../../../game/store/card/card-types';
import { State, StoreLike } from '../../../game';
import { Effect } from '../../../game/store/effects/effect';
import { CheckProvidedEnergyEffect } from '../../../game/store/effects/check-effects';
import {
  AS_OFTEN_AS_YOU_LIKE_ATTACH_BASIC_TYPE_ENERGY_FROM_HAND,
  MULTIPLE_COIN_FLIPS_PROMPT,
  WAS_ATTACK_USED
} from '../../../game/store/prefabs/prefabs';

export class Gholdengo extends PokemonCard {
  public stage: Stage = Stage.STAGE_1;
  public evolvesFrom = 'Gimmighoul';
  public cardType: CardType[] = [M];
  public hp: number = 130;
  public weakness = [{ type: R }];
  public resistance = [{ type: G, value: -30 }];
  public retreat = [C, C];

  public attacks = [
    {
      name: 'Lavish Hospitality',
      cost: [C],
      damage: 0,
      text: 'You may attach any number of Basic Metal Energy cards from your hand to your Pokémon in any way you like.'
    },
    {
      name: 'Scintillating Surfing',
      cost: [M, C, C],
      damage: 80,
      damageCalculation: 'x',
      text: 'Flip a coin for each Metal Energy attached to this Pokémon. This attack does 80 damage for each heads.'
    }
  ];

  public regulationMark = 'G';
  public set: string = 'PAF';
  public setNumber: string = '67';
  public cardImage: string = 'assets/cardback.png';
  public name: string = 'Gholdengo';
  public fullName: string = 'Gholdengo PAF';

  public reduceEffect(store: StoreLike, state: State, effect: Effect): State {

    if (WAS_ATTACK_USED(effect, 0, this)) {
      const player = effect.player;

      // You may attach any number of Basic Metal Energy cards from your hand
      // to your Pokémon in any way you like.
      state = AS_OFTEN_AS_YOU_LIKE_ATTACH_BASIC_TYPE_ENERGY_FROM_HAND(
        store, state, player, CardType.METAL,
        { promptOptions: { min: 0, max: player.hand.cards.length } }
      );
    }

    if (WAS_ATTACK_USED(effect, 1, this)) {
      const player = effect.player;

      const checkProvidedEnergy = new CheckProvidedEnergyEffect(player, player.active);
      state = store.reduceEffect(state, checkProvidedEnergy);

      let metalEnergyCount = 0;
      checkProvidedEnergy.energyMap.forEach(energy => {
        if (energy.provides.includes(CardType.METAL) || energy.provides.includes(CardType.ANY)) {
          metalEnergyCount++;
        }
      });

      effect.damage = 0;

      if (metalEnergyCount > 0) {
        state = MULTIPLE_COIN_FLIPS_PROMPT(store, state, player, metalEnergyCount, results => {
          const heads = results.filter(result => result).length;
          effect.damage = 80 * heads;
        });
      }
    }

    return state;
  }
}
