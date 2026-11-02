// Scoped, in-memory adapter tests: real panels, models, service and submission hooks.
// No browser/network/database, emitted files, installs or shared writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.resolve(__dirname, '..');
const server = path.dirname(fs.realpathSync(require.resolve('ptcg-server/package.json')));
const names = ['Attach', 'Move', 'Discard', 'Choose'];
const panelPaths = names.map(name => path.join(root, `src/table/prompts/${name}EnergyPromptPanel.tsx`));

function checkTypes() {
  const config = ts.readConfigFile(path.join(root, 'tsconfig.app.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(panelPaths, { ...parsed.options, noEmit: true, incremental: false });
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(d => d.file && panelPaths.includes(d.file.fileName));
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: x => x, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
  console.log('PASS targeted TypeScript diagnostics: four energy panels (no emit)');
}
function checkLegacy() {
  for (const name of ['check-energy.cjs', 'check-energy-attachment.cjs'].filter(name => !process.argv[3] || process.argv[3] === name)) {
    const filename = path.join(__dirname, name);
    // The isolated sibling intentionally has no server dependencies. Redirect only its read-only server root.
    const source = fs.readFileSync(filename, 'utf8')
      .replace("const serverRoot = path.resolve(__dirname, '../../ptcg-server');", `const serverRoot = ${JSON.stringify(server)};`)
      .replace("const server = path.join(root, 'ptcg-server');", `const server = ${JSON.stringify(server)};`);
    // Each legacy script owns its ts-node registration; sharing a process double-transpiles server helpers.
    const runner = `const Module = require('node:module'); const filename = ${JSON.stringify(filename)};
      const mod = new Module(filename, module); mod.filename = filename;
      mod.paths = Module._nodeModulePaths(require('node:path').dirname(filename));
      mod._compile(${JSON.stringify(source)}, filename);`;
    const result = spawnSync(process.execPath, ['-e', runner], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${name} exit status`);
  }
}

function makeLoader() {
  require(path.join(server, 'node_modules/ts-node')).register({ project: path.join(server, 'tsconfig.json') });
  const engine = require(path.join(server, 'src/game'));
  const cache = new Map();
  const Confirm = props => React.createElement('button', { disabled: props.disabled }, props.children);
  const Empty = () => null;
  const dnd = { ...require('@dnd-kit/core'), useSensor: () => ({}), useSensors: () => [] };
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} }; cache.set(file, mod);
    const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText;
    const localRequire = id => {
      if (id === 'ptcg-server') return engine;
      if (id === '@dnd-kit/core') return dnd;
      if (id.endsWith('.css')) return new Proxy({}, { get: (_, key) => String(key) });
      if (id.endsWith('/TablePrimaryAction')) return { TableConfirmAction: Confirm };
      if (id.endsWith('/CardFace')) return { CardFace: Empty };
      if (id.endsWith('/CardInfoPopup')) return { CardInfoPopup: Empty };
      if (id.endsWith('/EnergyTypeIcon')) return { EnergyTypeIcon: Empty };
      if (id.endsWith('/ShellButton')) return { ShellButton: 'button' };
      if (id.startsWith('.')) {
        const base = path.resolve(path.dirname(file), id);
        const resolved = ['.ts', '.tsx'].map(ext => base + ext).find(fs.existsSync);
        if (!resolved) throw new Error(`Missing local module: ${id} from ${file}`);
        return load(resolved);
      }
      return require(id);
    };
    new Function('exports', 'require', 'module', js)(mod.exports, localRequire, mod);
    return mod.exports;
  }
  return { load, engine, Confirm };
}

// Deterministic hook dispatcher, not a copy of any panel/model/hook logic. Real React hook exports
// call these primitives; all production effects/callbacks (including the async hook) run unchanged.
function mount(Component, props, Confirm) {
  const cells = [];
  let cursor = 0, dirty = true, tree;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  let effects = [];
  const dispatcher = {
    useState(initial) {
      const index = cursor++;
      if (!cells[index]) cells[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [cells[index].value, value => {
        const next = typeof value === 'function' ? value(cells[index].value) : value;
        if (!Object.is(next, cells[index].value)) { cells[index].value = next; dirty = true; }
      }];
    },
    useRef(initial) { const index = cursor++; return (cells[index] ??= { current: initial }); },
    useMemo(factory, deps) {
      const index = cursor++;
      if (!cells[index] || !same(cells[index].deps, deps)) cells[index] = { deps, value: factory() };
      return cells[index].value;
    },
    useCallback(callback, deps) { return dispatcher.useMemo(() => callback, deps); },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!cells[index] || !same(cells[index].deps, deps)) {
        const previous = cells[index];
        cells[index] = { deps, cleanup: previous?.cleanup };
        effects.push(() => { cells[index].cleanup?.(); cells[index].cleanup = callback(); });
      }
    },
  };
  dispatcher.useLayoutEffect = dispatcher.useEffect;
  function render() {
    for (let attempts = 0; attempts < 20; attempts++) {
      cursor = 0; effects = []; dirty = false;
      const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
      const previous = internals.H;
      internals.H = dispatcher;
      try { tree = Component(props); } finally { internals.H = previous; }
      for (const effect of effects) effect();
      if (!dirty) return tree;
    }
    throw new Error('Hook harness did not settle');
  }
  function find(node) {
    if (!node || typeof node !== 'object') return undefined;
    if (node.type === Confirm) return node.props;
    for (const child of React.Children.toArray(node.props?.children)) { const found = find(child); if (found) return found; }
  }
  render();
  return {
    props, render,
    update(next) { props = { ...props, ...next }; render(); },
    get action() { return find(tree); },
    get effect() { return props.boardInteraction.getBoardEffect(); },
    unmount() { for (const cell of cells) cell?.cleanup?.(); },
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

async function checkAdapters() {
  const { load, engine: e, Confirm } = makeLoader();
  const { setupGame, padDeck } = require(path.join(server, 'src/sets/tests/test-helpers'));
  const { BoardInteractionService } = load(path.join(root, 'src/table/BoardInteractionService.ts'));
  const { remapCardTargetSeat } = load(path.join(root, 'src/table/prompts/promptPerspective.ts'));
  const panels = Object.fromEntries(names.map((name, i) => [name, load(panelPaths[i])[`${name}EnergyPromptPanel`]]));
  const bottomActive = { player: e.PlayerType.BOTTOM_PLAYER, slot: e.SlotType.ACTIVE, index: 0 };
  const bottomBench = { player: e.PlayerType.BOTTOM_PLAYER, slot: e.SlotType.BENCH, index: 0 };
  const topActive = { player: e.PlayerType.TOP_PLAYER, slot: e.SlotType.ACTIVE, index: 0 };
  const topBench = { player: e.PlayerType.TOP_PLAYER, slot: e.SlotType.BENCH, index: 0 };
  let id = 4000;
  function fixture(name, options = {}, swap = true) {
    const game = setupGame({ turn: 2,
      player1: { active: { card: 'Ralts SIT', energy: ['Grass Energy SVE', 'Grass Energy SVE', 'Lightning Energy SVE'] },
        bench: [{ card: 'Ralts SIT', energy: ['Grass Energy SVE'] }], deck: padDeck(10) },
      player2: { active: { card: 'Ralts SIT', energy: ['Grass Energy SVE'] }, bench: [{ card: 'Ralts SIT' }], deck: padDeck(10) },
    });
    const player = game.state.players[0];
    const other = game.state.players[1];
    const calls = [];
    const boardInteraction = new BoardInteractionService();
    boardInteraction.registerBoardEffectSurface();
    const prompt = { id: ++id, playerId: other.id, perspectivePlayerId: player.id,
      message: 'test', playerType: e.PlayerType.ANY, slots: [e.SlotType.ACTIVE, e.SlotType.BENCH], filter: {},
      options: { allowCancel: true, min: 1, max: 3, blocked: [], blockedFrom: [], blockedTo: [], blockedMap: [], ...options },
      cardList: player.active.energies, energy: [], cost: [],
    };
    const props = { prompt, localGame: { state: game.state, deleted: false }, boardInteraction,
      clientId: swap ? other.id : player.id, catalog: [], getScanUrl: card => `/scan/${card.id}`,
      t: (key, args) => args?.defaultValue ?? key, gameMessageText: (_, message) => String(message),
      resolve: (promptId, result) => { calls.push({ promptId, result }); },
    };
    const original = game.state.players.flatMap(p => [p.active, ...p.bench]).map(list => ({ list,
      cards: [...list.cards], energies: [...list.energies.cards] }));
    const toVisual = target => swap ? remapCardTargetSeat(target) : target;
    function pristine() {
      for (const entry of original) {
        assert.deepEqual(entry.list.cards, entry.cards, 'authoritative cards unchanged');
        assert.deepEqual(entry.list.energies.cards, entry.energies, 'authoritative energy list unchanged');
      }
    }
    return { props, calls, player, other, toVisual, pristine,
      start: () => mount(panels[name], props, Confirm),
    };
  }
  function clickChip(h, card) { const chip = h.effect.chips.find(c => c.card === card); assert.ok(chip); h.effect.onChip(chip.id); h.render(); return chip; }

  // Attach: original pool indices, independent duplicates, blocked target/index, click/drop parity and clone safety.
  {
    const f = fixture('Attach', { blocked: [1], blockedTo: [topActive], max: 2 });
    const h = f.start();
    assert.equal(h.effect.kind, 'energy-attach');
    assert.equal(h.effect.chips.length, 2, 'ineligible pool entries are not listed');
    assert.deepEqual(h.effect.chips.map(c => c.id), ['attach-energy-0', 'attach-energy-2'], 'filtered chips retain original pool indices');
    assert.ok(h.effect.chips.every(c => !c.source));
    assert.ok(h.effect.targets.some(t => JSON.stringify(t.target) === JSON.stringify(f.toVisual(bottomBench))));
    assert.equal(h.effect.canDrop('attach-energy-1', f.toVisual(bottomBench)), false);
    assert.equal(h.effect.canDrop('attach-energy-0', f.toVisual(topActive)), false);
    clickChip(h, f.player.active.energies.cards[0]);
    h.effect.onTarget(f.toVisual(bottomBench)); h.render();
    h.effect.onDrop('attach-energy-2', f.toVisual(topBench)); h.render();
    assert.equal(h.effect.canDrop('attach-energy-2', f.toVisual(bottomActive)), false);
    await h.action.onClick(); h.render();
    assert.deepEqual(f.calls[0].result, [{ to: bottomBench, index: 0 }, { to: topBench, index: 2 }]);
    h.effect.onReset(); h.render();
    assert.equal(h.action.disabled, true);
    f.pristine(); h.unmount();
  }
  // Perspective identity path as well as the swapped path above.
  {
    const f = fixture('Attach', { max: 1 }, false); const h = f.start();
    h.effect.onDrop('attach-energy-0', bottomBench); h.render(); await h.action.onClick();
    assert.deepEqual(f.calls[0].result, [{ to: bottomBench, index: 0 }]); h.unmount();
  }
  // Move: blockedMap uses original cards indices even after removal; multi-source, filter, no chain/recount, unlimited max.
  {
    const f = fixture('Move', { max: undefined, blockedFrom: [topActive], blockedTo: [topBench],
      blockedMap: [{ source: bottomActive, blocked: [2] }] });
    f.props.prompt.filter = { name: 'Grass Energy' };
    const [first, blocked] = f.player.active.energies.cards;
    const benchEnergy = f.player.bench[0].energies.cards[0];
    const h = f.start();
    assert.equal(h.effect.kind, 'energy-move');
    assert.deepEqual(h.effect.chips.map(c => c.card), [first, benchEnergy]);
    const chip = h.effect.chips.find(c => c.card === first);
    assert.deepEqual(chip.source, f.toVisual(bottomActive));
    assert.equal(h.effect.canDrop(chip.id, f.toVisual(bottomActive)), false);
    assert.equal(h.effect.canDrop(chip.id, f.toVisual(topBench)), false);
    assert.equal(h.effect.canDrop(chip.id, 'discard'), false);
    h.effect.onTarget(f.toVisual(bottomActive)); h.render();
    assert.deepEqual(h.effect.focusedTarget, f.toVisual(bottomActive));
    h.effect.onTarget(f.toVisual(bottomBench)); h.render();
    assert.equal(h.effect.canDrop(chip.id, f.toVisual(topActive)), false, 'moved physical card cannot count again');
    const second = h.effect.chips.find(c => c.card === benchEnergy);
    h.effect.onDrop(second.id, f.toVisual(topActive)); h.render();
    assert.ok(!h.effect.chips.some(c => c.card === blocked));
    await h.action.onClick(); h.render();
    assert.deepEqual(f.calls[0].result, [{ from: bottomActive, to: bottomBench, index: 1 }, { from: bottomBench, to: topActive, index: 1 }]);
    f.pristine(); h.unmount();
  }
  {
    const f = fixture('Move', { max: 1 }); const h = f.start();
    const [a, b] = h.effect.chips;
    h.effect.onDrop(a.id, f.toVisual(topBench)); h.render();
    assert.equal(h.effect.canDrop(b.id, f.toVisual(topBench)), false, 'finite max respected');
    h.effect.onReset(); h.render(); assert.equal(h.action.disabled, true); f.pristine(); h.unmount();
  }
  // Discard: drop only edits the draft; toggles remain accessible at max, multiple sources and original indices.
  {
    const f = fixture('Discard', { max: 2, blockedFrom: [topActive], blockedMap: [{ source: bottomActive, blocked: [2] }] });
    f.props.prompt.filter = { name: 'Grass Energy' };
    const h = f.start(); const [first, second] = h.effect.chips;
    assert.equal(h.effect.kind, 'energy-discard'); assert.equal(h.effect.chips.length, 2);
    assert.deepEqual(first.source, f.toVisual(bottomActive));
    h.effect.onTarget(f.toVisual(bottomBench)); h.render();
    assert.deepEqual(h.effect.focusedTarget, f.toVisual(bottomBench));
    assert.equal(h.effect.canDrop(first.id, f.toVisual(bottomBench)), false);
    h.effect.onDrop(first.id, 'discard'); h.render();
    h.effect.onDrop(second.id, 'discard'); h.render();
    assert.equal(f.calls.length, 0, 'drop does not resolve');
    assert.equal(h.effect.canDrop(first.id, 'discard'), false, 'selected chip cannot be duplicated');
    h.effect.onChip(first.id); h.render(); assert.equal(h.effect.chips.find(c => c.id === first.id).selected, false);
    h.effect.onChip(first.id); h.render();
    await h.action.onClick(); h.render();
    assert.deepEqual(f.calls[0].result, [{ from: bottomBench, index: 1 }, { from: bottomActive, index: 1 }]);
    h.effect.onReset(); h.render(); assert.equal(h.action.disabled, true); f.pristine(); h.unmount();
  }
  {
    const f = fixture('Discard', { min: 0, max: undefined }); const h = f.start();
    assert.equal(h.action.disabled, false);
    for (const chip of h.effect.chips) h.effect.onDrop(chip.id, 'discard');
    h.render(); await h.action.onClick(); assert.equal(f.calls[0].result.length, 5); f.pristine(); h.unmount();
  }
  // Choose: same physical card contributes distinct exact-energy units, source lookup supports detached snapshots.
  {
    const f = fixture('Choose'); const card = f.player.active.energies.cards[0];
    const detached = Object.assign(Object.create(Object.getPrototypeOf(card)), card);
    const unknown = Object.assign(Object.create(Object.getPrototypeOf(card)), card, { id: 998877 });
    f.props.prompt.energy = [{ card: detached, provides: [e.CardType.COLORLESS] },
      { card: detached, provides: [e.CardType.COLORLESS] }, { card: unknown, provides: [e.CardType.GRASS] }];
    f.props.prompt.cost = [e.CardType.COLORLESS, e.CardType.COLORLESS];
    const h = f.start();
    assert.equal(h.effect.kind, 'energy-choose'); assert.equal(h.effect.chips.length, 3);
    assert.equal(new Set(h.effect.chips.map(c => c.id)).size, 3);
    assert.deepEqual(h.effect.chips[0].source, f.toVisual(bottomActive));
    assert.equal(h.effect.chips[2].source, undefined);
    h.effect.onChip('choose-energy-0'); h.render(); assert.equal(h.action.disabled, true);
    h.effect.onChip('choose-energy-1'); h.render(); assert.equal(h.action.disabled, false);
    await h.action.onClick(); h.render(); assert.deepEqual(f.calls[0].result, [0, 1]);
    h.effect.onReset(); h.render(); assert.equal(h.action.disabled, true);
    f.props.prompt.cost = [e.CardType.FIRE]; h.update({ prompt: { ...f.props.prompt, id: ++id } });
    h.effect.onChip('choose-energy-0'); h.render(); assert.equal(h.action.disabled, true, 'wrong energy fails exact payment');
    f.pristine(); h.unmount();
  }

  // Every panel: synchronous freeze before React renders, rejection preserves draft, cancel cannot race submit,
  // deleted/replay guards apply to callbacks (not just disabled props), and stale completion cannot unlock new request.
  for (const name of names) {
    const f = fixture(name, { min: 0, max: 3 });
    if (name === 'Choose') {
      f.props.prompt.energy = [{ card: f.player.active.energies.cards[0], provides: [e.CardType.GRASS] }];
      f.props.prompt.cost = [e.CardType.GRASS];
    }
    const firstRequest = deferred();
    f.props.resolve = (promptId, result) => { f.calls.push({ promptId, result }); return firstRequest.promise; };
    const h = f.start();
    function select() {
      const chip = h.effect.chips[0];
      if (name === 'Attach' || name === 'Move') h.effect.onDrop(chip.id, f.toVisual(topBench));
      else h.effect.onChip(chip.id);
      h.render();
    }
    select(); assert.equal(h.action.disabled, false, `${name} prepared`);
    const progress = h.effect.progress;
    const oldEffect = h.effect, oldAction = h.action;
    const submission = oldAction.onClick();
    oldEffect.onReset(); oldEffect.onChip?.(oldEffect.chips[0].id);
    oldEffect.onTarget(f.toVisual(bottomActive)); oldEffect.onDrop?.(oldEffect.chips[0].id, 'discard');
    oldAction.onCancel(); oldAction.onClick();
    h.render(); assert.equal(h.effect.progress, progress); assert.equal(f.calls.length, 1);
    assert.equal(h.action.disabled, true); assert.equal(h.action.cancelDisabled, true);
    firstRequest.reject(new Error('expected resolve rejection'));
    await assert.rejects(submission, /expected resolve rejection/); h.render();
    assert.equal(h.effect.progress, progress, `${name} failure retained draft`);
    assert.equal(h.action.disabled, false);
    for (const mode of ['deleted', 'replay']) {
      h.update({ localGame: { ...f.props.localGame, [mode]: mode === 'replay' ? {} : true } });
      const locked = h.effect.progress;
      h.effect.onReset(); h.effect.onChip?.(h.effect.chips[0].id); h.action.onCancel(); h.action.onClick(); h.render();
      assert.equal(h.effect.progress, locked); assert.equal(f.calls.length, 1); assert.equal(h.action.disabled, true);
    }
    h.update({ localGame: f.props.localGame });
    const stale = deferred(), current = deferred();
    h.update({ resolve: () => stale.promise });
    const staleSubmission = h.action.onClick(); h.render();
    h.update({ prompt: { ...f.props.prompt, id: ++id }, resolve: () => current.promise });
    select(); const newSubmission = h.action.onClick(); h.render();
    stale.resolve(); await staleSubmission; h.render();
    assert.equal(h.action.disabled, true, `${name} stale completion must not unlock new request`);
    current.resolve(); await newSubmission; h.render(); assert.equal(h.action.disabled, false);
    // Real React static rendering verifies fallback remains renderable without a registered on-card surface.
    const fallbackProps = { ...f.props, boardInteraction: new BoardInteractionService(), resolve: () => undefined };
    const markup = renderToStaticMarkup(React.createElement(panels[name], fallbackProps));
    assert.match(markup, /role="dialog"/, `${name} fallback dialog retained`);
    h.update({ boardInteraction: new BoardInteractionService() }); assert.equal(h.effect, null);
    f.pristine(); h.unmount();
  }
  console.log('PASS real energy panel/model/service/submission-hook behaviors: seats, chips, original indices, constraints, exact units, clones, pending/failure/stale/cancel/replay, fallback SSR');
}

(async () => {
  const mode = process.argv[2];
  if (!mode || mode === '--types') checkTypes();
  if (!mode || mode === '--legacy') checkLegacy();
  if (!mode || mode === '--adapters') await checkAdapters();
})().catch(error => { console.error(error); process.exitCode = 1; });
