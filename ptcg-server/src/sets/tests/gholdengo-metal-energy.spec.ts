import { Store } from '../../game/store/store';
import { State } from '../../game/store/state/state';
import { Player } from '../../game/store/state/player';
import { PokemonCardList } from '../../game/store/state/pokemon-card-list';
import { EnergyCard } from '../../game/store/card/energy-card';
import { CardType, EnergyType } from '../../game/store/card/card-types';
import { AttackEffect } from '../../game/store/effects/game-effects';
import { CoinFlipSequenceEffect } from '../../game/store/effects/play-card-effects';
import { Effect } from '../../game/store/effects/effect';
import { Gholdengo } from '../10-scarlet-and-violet/set-paldean-fates/gholdengo-paf';
import { LuminousEnergy } from '../10-scarlet-and-violet/set-paldea-evolved/luminous-energy';

class MetalEnergy extends EnergyCard {
  public name = 'Metal Energy'; public fullName = 'Metal Energy TEST'; public set = 'TEST';
  public provides = [CardType.METAL]; public energyType = EnergyType.BASIC;
}
class OtherSpecial extends EnergyCard {
  public name = 'Other Special'; public fullName = 'Other Special TEST'; public set = 'TEST';
  public provides = [CardType.COLORLESS]; public energyType = EnergyType.SPECIAL;
}

describe('Gholdengo Scintillating Surfing', () => {
  [false, true].forEach(otherSpecial => it(`counts Luminous Energy only when it provides Metal (other special: ${otherSpecial})`, () => {
    const state = new State(); const player = new Player(); const opponent = new Player();
    player.id = 1; opponent.id = 2; state.players = [player, opponent];
    player.bench = Array.from({ length: 5 }, () => new PokemonCardList());
    opponent.bench = Array.from({ length: 5 }, () => new PokemonCardList());
    const card = new Gholdengo();
    player.active.cards = [card, new MetalEnergy(), new LuminousEnergy(), ...(otherSpecial ? [new OtherSpecial()] : [])];
    const store = new Store({ onStateChange() {} }, false); store.state = state;
    const reduce = store.reduceEffect.bind(store); let flips = -1;
    spyOn(store, 'reduceEffect').and.callFake((s: State, effect: Effect) => {
      if (effect instanceof CoinFlipSequenceEffect) {
        flips = effect.mode as number;
        effect.callback(Array.from({ length: flips }, () => true));
        return s;
      }
      return reduce(s, effect);
    });
    const attack = new AttackEffect(player, opponent, card.attacks[1]);
    card.reduceEffect(store, state, attack);
    expect(flips).toBe(otherSpecial ? 1 : 2);
    expect(attack.damage).toBe(otherSpecial ? 80 : 160);
  }));
});
