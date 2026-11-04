import { Store } from '../../game/store/store';
import { State, GamePhase } from '../../game/store/state/state';
import { Player } from '../../game/store/state/player';
import { CardList } from '../../game/store/state/card-list';
import { PokemonCardList } from '../../game/store/state/pokemon-card-list';
import { PokemonCard } from '../../game/store/card/pokemon-card';
import { EnergyCard } from '../../game/store/card/energy-card';
import { CardType, EnergyType } from '../../game/store/card/card-types';
import { AttackAction } from '../../game/store/actions/game-actions';
import { ResolvePromptAction } from '../../game/store/actions/resolve-prompt-action';
import { WaitPrompt } from '../../game/store/prompts/wait-prompt';
import { Indeedee } from '../09-sword-and-shield/set-battle-styles/indeedee';
import { Primeape } from '../09-sword-and-shield/set-battle-styles/primeape';
import { AttackEffect } from '../../game/store/effects/game-effects';

class Target extends PokemonCard {
  public name = 'Test Target'; public fullName = 'Test Target TEST'; public set = 'TEST';
  public hp = 500; public cardType = [CardType.COLORLESS];
  public attacks = [{ name: 'Hit', cost: [], damage: 10, text: '' }];
}
class Energy extends EnergyCard {
  public name = 'Test Energy'; public fullName = 'Test Energy TEST'; public set = 'TEST';
  public provides = [CardType.COLORLESS]; public energyType = EnergyType.BASIC;
}

describe('Indeedee Hand Kinesis', () => {
  [0, 1, 5].forEach(count => it(`deals ${count * 10} damage with ${count} cards in hand`, () => {
    const state = new State(); state.phase = GamePhase.PLAYER_TURN; state.turn = 5;
    state.players = [new Player(), new Player()];
    state.players[0].id = 17; state.players[1].id = 29;
    for (const player of state.players) {
      player.active.cards = [new Target()];
      player.bench = Array.from({ length: 5 }, () => new PokemonCardList());
      player.bench[0].cards = [new Target()];
      player.prizes = Array.from({ length: 6 }, () => { const pile = new CardList(); pile.cards = [new Target()]; return pile; });
      player.deck.cards = Array.from({ length: 20 }, () => new Target());
    }
    const [player, opponent] = state.players;
    player.active.cards = [new Indeedee(), new Energy(), new Energy()];
    player.hand.cards = Array.from({ length: count }, () => new Target());
    let id = 1;
    for (const p of state.players) for (const pile of [p.active, ...p.bench, p.hand, p.deck, ...p.prizes]) {
      for (const card of pile.cards) card.id = id++;
    }
    const store = new Store({ onStateChange() {} }, false); store.state = state;
    store.dispatch(new AttackAction(player.id, 'Hand Kinesis'), player.id);
    const prompt = store.state.prompts.find(p => p instanceof WaitPrompt && p.result === undefined);
    expect(prompt).toBeDefined();
    if (!prompt) throw new Error('Missing attack animation prompt');
    store.dispatch(new ResolvePromptAction(prompt.id, prompt.decode(null, store.state)), prompt.playerId);
    expect(opponent.active.damage).toBe(count * 10);
  }));

  it('Collect draws two cards', () => {
    const state = new State(); const player = new Player(); const opponent = new Player();
    state.players = [player, opponent]; player.deck.cards = [new Target(), new Target(), new Target()];
    const card = new Indeedee(); const store = new Store({ onStateChange() {} }, false);
    card.reduceEffect(store, state, new AttackEffect(player, opponent, card.attacks[0]));
    expect(player.hand.cards.length).toBe(2);
    expect(player.deck.cards.length).toBe(1);
  });

  it('Primeape can attack for zero damage with an empty bench', () => {
    const state = new State(); const player = new Player(); const opponent = new Player();
    state.players = [player, opponent]; player.bench = Array.from({ length: 5 }, () => new PokemonCardList());
    const card = new Primeape(); player.active.cards = [card];
    const effect = new AttackEffect(player, opponent, card.attacks[1]);
    const store = new Store({ onStateChange() {} }, false);
    card.reduceEffect(store, state, effect);
    expect(effect.damage).toBe(0);
  });
});
