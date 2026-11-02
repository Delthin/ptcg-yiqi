import { GameLog, type StateLog } from 'ptcg-server';
import type { MotionCard, MotionSnapshot } from './boardMotionModel';

export type BoardHit = { key: string; card: MotionCard; damage: number; attack: boolean; knockout: boolean };

/** Match exposed card identities and authoritative logs, never infer a KO from HP or a disappearing slot. */
export function resolveBoardHits(
  before: MotionSnapshot, next: MotionSnapshot, previousDamage: Map<string, number>, damage: Map<string, number>,
  logs: StateLog[], attacking: boolean,
): BoardHit[] {
  const hits: BoardHit[] = [];
  const knockoutNames = new Map<string, number>();
  const damageLogs = logs.filter(log => log.message === GameLog.LOG_PLAYER_DEALS_DAMAGE && Number(log.params.damage) > 0)
    .map(log => ({ name: String(log.params.target), damage: Number(log.params.damage), used: false }));
  for (const log of logs) if (log.message === GameLog.LOG_POKEMON_KO) {
    const name = String(log.params.name); knockoutNames.set(name, (knockoutNames.get(name) ?? 0) + 1);
  }
  const discardedNames = new Map<string, number>();
  for (const key of previousDamage.keys()) {
    const card = before.cards.get(key);
    if (card && next.cards.get(key)?.zone === 'discard') discardedNames.set(card.card.name, (discardedNames.get(card.card.name) ?? 0) + 1);
  }
  for (const [key, oldDamage] of previousDamage) {
    const card = before.cards.get(key), current = next.cards.get(key);
    if (!card) continue;
    const knockout = current?.zone === 'discard' && (knockoutNames.get(card.card.name) ?? 0) >= (discardedNames.get(card.card.name) ?? 1);
    const increase = knockout ? 0 : Math.max(0, (damage.get(key) ?? oldDamage) - oldDamage);
    if (increase <= 0 && !knockout) continue;
    hits.push({ key, card: current && !knockout ? current : card, damage: increase, attack: false, knockout });
  }
  // Consume a log only once. A same-named Pokemon elsewhere must not reuse it for a second hit.
  for (const hit of hits.filter(hit => !hit.knockout)) {
    const name = hit.card.card.name;
    // Public logs name the species, not the target ID. Ambiguous mixed KO/live targets
    // or one log shared by equal-damage names get numeric feedback only.
    if (hits.some(other => other.knockout && other.card.card.name === name)) continue;
    const peers = hits.filter(other => !other.knockout && other.card.card.name === name && other.damage === hit.damage);
    if (peers.length > 1 && damageLogs.filter(log => log.name === name && log.damage === hit.damage).length < peers.length) continue;
    const available = damageLogs.filter(log => !log.used && log.name === name);
    const exact = available.find(log => log.damage === hit.damage);
    const matches = exact ? [exact] : available.reduce((sum, log) => sum + log.damage, 0) === hit.damage ? available : [];
    if (matches.length) { matches.forEach(log => { log.used = true; }); hit.attack = attacking; }
  }
  // KO and damage can arrive together after the slot is cleared. With multiple same-name KOs,
  // the public logs cannot identify each amount: show the KO, but do not invent damage numbers.
  for (const hit of hits.filter(hit => hit.knockout)) {
    if (hits.filter(other => other.card.card.name === hit.card.card.name).length !== 1) continue;
    const matches = damageLogs.filter(log => !log.used && log.name === hit.card.card.name);
    hit.damage = matches.reduce((sum, log) => sum + log.damage, 0);
    hit.attack = attacking && hit.damage > 0;
    matches.forEach(log => { log.used = true; });
  }
  return hits;
}
