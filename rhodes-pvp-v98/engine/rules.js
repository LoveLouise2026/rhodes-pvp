'use strict';

// All continuations are data: a pending choice survives reconnect without a browser Promise.
class RuleError extends Error {}
module.exports = function createRules(mainCards, baseCards) {
  const cards = new Map([...mainCards, ...baseCards].map(c => [c.id, c]));
  const card = id => cards.get(id);
  const isOperator = id => card(id)?.type === '干员';
  const basic = id => isOperator(id) && card(id).operatorType === '基础';
  const trait = (id, text) => card(id)?.feature?.includes(text) || card(id)?.traits?.some(t => t.includes(text));
  const fail = text => { throw new RuleError(text); };
  const check = (ok, text) => { if (!ok) fail(text); };
  const player = (g, id) => g.players.find(p => p.id === id);
  const other = (g, id) => g.players.find(p => p.id !== id);
  const level = p => Number(card(p.activeBase)?.level || 0);
  const column = s => s % 4;
  const ref = (p, s) => ({ owner: p.id, slot: s, uid: p.fieldMeta[s]?.uid });
  const live = (g, r) => r && player(g, r.owner)?.fieldMeta[r.slot]?.uid === r.uid && player(g, r.owner).field[r.slot];
  function ensure(g) {
    g.queue ||= []; g.effectLog ||= []; g.effectSequence ||= 0; g.entitySequence ||= 0; g.choiceSequence ||= 0;
    g.pendingChoice ||= null;
    for (const p of g.players) {
      p.traps ||= Array(8).fill(null); p.fieldMeta ||= Array(8).fill(null); p.once ||= {};
      for (let i = 0; i < 8; i++) if (p.field[i] && !p.fieldMeta[i]) {
        p.fieldMeta[i] = { uid: ++g.entitySequence, stack: [], entered: p.fieldEnteredTurn[i], attacks: p.fieldAttackedTurn[i] === g.turnSequence ? 1 : 0, attackTurn: g.turnSequence };
      }
    }
  }
  function log(g, text, extra = {}, audience = null) {
    g.effectLog.push({ id: ++g.effectSequence, text, ...extra, audience });
    if (g.effectLog.length > 120) g.effectLog.splice(0, g.effectLog.length - 120);
  }
  function push(g, ...tasks) { g.queue.unshift(...tasks.filter(Boolean)); }
  function effect(owner, id, extra = {}) { return { type: 'effect', owner, cardId: id, stage: 0, ...extra }; }
  function option(value, label, cardId) { return { value, label, ...(cardId ? { cardId } : {}) }; }
  function handOptions(p, predicate = () => true) {
    return p.hand.flatMap((id, index) => predicate(id) ? [option(index, `手牌 ${index + 1} · ${card(id).name} Lv.${card(id).level}`, id)] : []);
  }
  function graveOptions(p, predicate) {
    return p.grave.flatMap((id, index) => predicate(id) ? [option(index, `弃牌区 · ${card(id).name} Lv.${card(id).level}`, id)] : []);
  }
  function fieldOptions(g, p, predicate = () => true) {
    return p.field.flatMap((id, s) => id && predicate(id, s) ? [option(ref(p, s), `${p.name} ${s < 4 ? '前' : '后'}排${column(s) + 1} · ${card(id).name} ATK ${power(g, p, s)}`, id)] : []);
  }
  function empty(p, predicate = () => true) {
    return p.field.flatMap((id, s) => !id && !p.traps[s] && predicate(s) ? [option(s, `${s < 4 ? '前' : '后'}排 · 第${column(s) + 1}战线`)] : []);
  }
  function ask(g, t, stage, options, config = {}) {
    if (!options.length) return false;
    const min = config.min ?? 1, max = config.max ?? 1;
    if (options.length < min) return false;
    g.pendingChoice = {
      id: `${g.id}:choice:${++g.choiceSequence}`, owner: t.owner,
      title: config.title || card(t.cardId)?.name || '效果结算',
      hint: config.hint || (config.ordered ? '依次点击，按点击顺序结算。' : '请选择；不发动时可选择跳过。'),
      min, max, ordered: Boolean(config.ordered),
      options: options.map((o, i) => ({ ...o, id: String(i) })),
      next: { ...t, stage }
    };
    return true;
  }
  function draw(g, p, count) {
    const ids = p.deck.splice(0, count); p.hand.push(...ids);
    log(g, `${p.name}抽${ids.length}张牌`);
    return ids.length;
  }
  function addHand(g, p, id, reason, publiclyKnown = true) {
    p.hand.push(id);
    if (!publiclyKnown) log(g, `${p.name}通过效果将1张卡加入手牌`);
    log(g, `${p.name}将【${card(id).name}】加入手牌`, { cardId: id, reason }, publiclyKnown ? null : p.id);
    if (id === 'SD01-0010') push(g, effect(p.id, id, { event: 'added' }));
  }
  function discard(p, indices) {
    const unique = [...new Set(indices)]; check(unique.length === indices.length, '费用不能重复选择同一张牌。');
    check(indices.every(i => Number.isInteger(i) && i >= 0 && i < p.hand.length), '费用卡已失效。');
    const removed = unique.sort((a, b) => b - a).map(i => p.hand.splice(i, 1)[0]); p.grave.push(...removed);
  }
  function upgrade(g, p) {
    const next = p.baseDeck.findIndex(id => Number(card(id)?.level) === level(p) + 1);
    if (next < 0) return false;
    const id = p.baseDeck.splice(next, 1)[0]; p.activeBase = id; p.baseStack.push(id);
    log(g, `${p.name}基地升级至 Lv.${level(p)}`, { cardId: id }); return true;
  }
  function power(g, p, s) {
    const id = p.field[s]; if (!id) return 0;
    let n = Number(card(id).attack || 0);
    p.field.forEach((source, i) => { if (i !== s && column(i) === column(s) && ['SD01-0002', 'SD02-0004'].includes(source)) n++; });
    if (g.currentPlayerId === p.id && p.baseStack.includes('SD02-0017') && trait(id, '龙门') && p.field.filter(c => c && trait(c, '龙门')).length >= 3) n++;
    const m = p.fieldMeta[s];
    if (m?.buffTurn === g.turnSequence) n += Number(m.buff || 0);
    return Math.max(0, n);
  }
  function triggers(g, tasks) {
    const owners = [g.currentPlayerId, other(g, g.currentPlayerId).id];
    push(g, ...owners.map(owner => ({ type: 'order', owner, tasks: tasks.filter(t => t.owner === owner) })).filter(t => t.tasks.length));
  }
  function deploy(g, p, index, slot, byEffect = false, defer = false) {
    check(!p.field[slot] && !p.traps[slot], '部署位置已占用。');
    const id = p.hand.splice(index, 1)[0];
    p.field[slot] = id; p.fieldEnteredTurn[slot] = g.turnSequence; p.fieldAttackedTurn[slot] = -1;
    p.fieldMeta[slot] = { uid: ++g.entitySequence, stack: [], entered: g.turnSequence, attacks: 0, attackTurn: g.turnSequence };
    log(g, `${p.name}部署【${card(id).name}】`, { cardId: id, slot });
    const own = ['SD01-0001','SD01-0003','SD01-0004','SD01-0006','SD01-0007','SD02-0001','SD02-0005','SD02-0010'].includes(id) ? [effect(p.id, id, { source: ref(p, slot), event: 'deploy' })] : [];
    if (byEffect && id === 'SD01-0009') own.push(effect(p.id, id, { source: ref(p, slot), event: 'huang' }));
    const reaction = { type: 'reaction', owner: other(g, p.id).id, event: 'deploy' };
    if (defer) return { own, reaction };
    push(g, { type: 'order', owner: p.id, tasks: own }, reaction);
    return id;
  }
  function evolve(g, p, index, r) {
    check(live(g, r), '精英化目标已失效。');
    const id = p.hand.splice(index, 1)[0], old = p.field[r.slot];
    p.fieldMeta[r.slot].stack.push(old); p.field[r.slot] = id;
    log(g, `${p.name}将【${card(id).name}】精英化`, { cardId: id, slot: r.slot });
    push(g, effect(p.id, id, { event: 'evolve', source: ref(p, r.slot) }));
  }
  function takeField(g, r, destination, battle = false) {
    if (!live(g, r)) return null;
    const p = player(g, r.owner), s = r.slot, id = p.field[s], meta = p.fieldMeta[s];
    if (battle && meta.protectedTurn === g.turnSequence) { log(g, `【${card(id).name}】本回合不会被战斗击败`); return null; }
    const stack = [...meta.stack, id];
    p.field[s] = null; p.fieldMeta[s] = null; p.fieldEnteredTurn[s] = -1; p.fieldAttackedTurn[s] = -1;
    if (destination === 'hand') {
      for (const c of stack) addHand(g, p, c, 'bounce');
    } else {
      p.grave.push(...stack); log(g, `${p.name}的【${card(id).name}】被击败`, { cardId: id, slot: s });
    }
    return { owner: p.id, cardId: id, source: r, destination };
  }
  function defeated(g, records) {
    const tasks = [];
    for (const r of records.filter(Boolean)) {
      if (r.destination !== 'grave') continue;
      const p = player(g, r.owner), op = other(g, p.id);
      if (['SD02-0002', 'SD02-0003'].includes(r.cardId)) tasks.push(effect(p.id, r.cardId, { event: 'defeat' }));
      if (p.baseStack.includes('SD01-0017') && g.currentPlayerId === p.id && trait(r.cardId, '罗德岛')) tasks.push(effect(p.id, 'SD01-0017'));
      if (op.baseStack.includes('SD02-0016')) tasks.push(effect(op.id, 'SD02-0016'));
    }
    if (tasks.length) triggers(g, tasks);
  }
  function recover(g, p, index) { const id = p.grave.splice(index, 1)[0]; if (id) addHand(g, p, id, 'recover'); }
  function used(p, key, g) { return p.once[key] === g.turnSequence; }
  function huangTasks(g, p) {
    return p.field.flatMap((id, s) => id === 'SD01-0009' && p.fieldMeta[s].huangTurn !== g.turnSequence ? [effect(p.id, id, { event: 'huang', source: ref(p, s) })] : []);
  }
  function tacticTriggers(g, p, id) { if (trait(id, '罗德岛')) triggers(g, huangTasks(g, p)); }
  function peekOptions(ids, predicate = () => true) { return ids.flatMap((id, i) => predicate(id) ? [option(i, `${i + 1} · ${card(id).name} Lv.${card(id).level}`, id)] : []); }
  function reorder(g, t, ids, title = '排列卡组顶：先选的在最上方') {
    if (ids.length <= 1) { player(g, t.owner).deck.unshift(...ids); return; }
    ask(g, { type: 'returnTop', owner: t.owner, ids }, 1, peekOptions(ids), { min: ids.length, max: ids.length, ordered: true, title });
  }
  function evolvePairs(g, p, predicate) {
    return p.hand.flatMap((id, i) => card(id).operatorType === '精英化' && predicate(id) ?
      p.field.flatMap((base, s) => base && basic(base) && card(base).name === card(id).name ? [option({ hand: i, target: ref(p, s) }, `【${card(id).name}】精英化 · 第${column(s) + 1}战线`, id)] : []) : []);
  }
  function adjacent(a, b) { return (Math.floor(a / 4) === Math.floor(b / 4) && Math.abs(a - b) === 1) || Math.abs(a - b) === 4; }
  function movable(p, s) { return empty(p, i => Math.floor(i / 4) === Math.floor(s / 4) && column(i) !== column(s)); }
  function finishDeployment(g, p, deferred, extra = []) {
    push(g, { type: 'order', owner: p.id, tasks: [...(deferred?.own || []), ...extra] }, deferred?.reaction);
  }
  function eligibleTraps(g, p, event) {
    return p.traps.flatMap((trap, s) => {
      if (!trap || trap.setTurn >= g.turnSequence) return [];
      const id = trap.cardId;
      if (event === 'deploy' && id !== 'SD01-0014') return [];
      if (event === 'attack' && !['SD01-0015', 'SD02-0013', 'SD02-0014'].includes(id)) return [];
      if (id === 'SD01-0014' && !p.field.some(c => card(c)?.name === '煌')) return [];
      if (id === 'SD02-0014' && !p.field.some(c => card(c)?.name === '陈')) return [];
      if (id === 'SD01-0015' && (!empty(p).length || !p.field.some((c, i) => c && column(i) === column(s) && p.hand.some(h => isOperator(h) && card(h).level === card(c).level)))) return [];
      return [option(s, `发动后排第${column(s) + 1}战线【${card(id).name}】`, id)];
    });
  }

  function resolveEffect(g, t) {
    const p = player(g, t.owner), op = other(g, p.id), id = t.cardId, stage = t.stage || 0, picks = t.picks || [];
    const choose = (next, opts, config) => ask(g, t, next, opts, config);
    const sourceExists = () => live(g, t.source) && p.field[t.source.slot] === id;
    switch (id) {
      case 'SD01-0001': // Yato: reveal, then draw.
        if (!stage) {
          const targets = handOptions(p, h => isOperator(h) && trait(h, '行动组A4'));
          if (!targets.length) {
            log(g, '夜刀：手牌中没有可展示的【行动组A4】干员，无法发动部署时效果。', { cardId: id, reason: 'condition_not_met' }, p.id);
            return;
          }
          return choose(1, targets, { min: 0 });
        }
        if (picks.length) { const h = p.hand[picks[0]]; log(g, `${p.name}展示【${card(h).name}】`, { cardId: h }); draw(g, p, 1); } return;
      case 'SD01-0003':
        if (!stage && empty(p).length) return choose(1, handOptions(p, h => isOperator(h) && trait(h, '行动组A4') && card(h).name !== '巡林者'), { min: 0 });
        if (stage === 1 && picks.length) return ask(g, { ...t, hand: picks[0] }, 2, empty(p));
        if (stage === 2) deploy(g, p, t.hand, picks[0], true); return;
      case 'SD01-0004':
        if (!stage) {
          const top = p.deck[0]; if (!top) return;
          log(g, `${p.name}翻开【${card(top).name}】`, { cardId: top });
          if (basic(top) && trait(top, '罗德岛') && empty(p).length) return choose(1, empty(p), { min: 0 });
        } else if (picks.length) { p.hand.push(p.deck.shift()); deploy(g, p, p.hand.length - 1, picks[0], true); } return;
      case 'SD01-0006':
        if (t.event === 'turn') { if (sourceExists()) upgrade(g, p); return; }
        if (!stage) return reorder(g, t, p.deck.splice(0, 2)); return;
      case 'SD01-0007':
      case 'SD01-0009': {
        if (id === 'SD01-0009' && t.event !== 'huang') return;
        if (!stage && id === 'SD01-0009') {
          if (!sourceExists() || p.fieldMeta[t.source.slot].huangTurn === g.turnSequence || !p.deck.length) return;
          return choose(10, [option(true, '发动：查看卡组顶2张并选择1张加入手牌')], { min: 0 });
        }
        if (!stage || stage === 10) {
          if (stage === 10 && !picks.length) return;
          if (id === 'SD01-0009') p.fieldMeta[t.source.slot].huangTurn = g.turnSequence;
          const revealed = p.deck.splice(0, id === 'SD01-0007' ? 3 : 2);
          if (id === 'SD01-0007') log(g, `${p.name}翻开卡组顶${revealed.length}张`, { cards: revealed });
          const opts = peekOptions(revealed, c => id === 'SD01-0009' || (isOperator(c) && trait(c, '罗德岛')));
          if (!opts.length) return reorder(g, t, revealed);
          return ask(g, { ...t, revealed }, 1, opts);
        }
        if (stage === 1) {
          const remaining = t.revealed.slice(), selected = remaining.splice(picks[0], 1)[0];
          // Return remaining cards before the non-draw addition can trigger special evolution.
          push(g, { type: 'addHand', owner: p.id, cardId: selected, private: id === 'SD01-0009' });
          reorder(g, t, remaining); return;
        }
        return;
      }
      case 'SD01-0008':
        if (!stage) return choose(1, graveOptions(p, c => card(c).type === '战术卡' && trait(c, '罗德岛')), { min: 0 });
        if (picks.length) recover(g, p, picks[0]); return;
      case 'SD01-0010':
        if (t.event === 'evolve') { if (sourceExists()) p.fieldMeta[t.source.slot].protectedTurn = g.turnSequence; return; }
        if (!stage) return choose(1, evolvePairs(g, p, c => c === id), { min: 0 });
        if (picks.length) evolve(g, p, picks[0].hand, picks[0].target); return;
      case 'SD01-0011':
        if (!stage) { const revealed = p.deck.splice(0, 2); log(g, `${p.name}翻开卡组顶${revealed.length}张`, { cards: revealed }); return ask(g, { ...t, revealed }, 1, peekOptions(revealed)); }
        { const ids = t.revealed.slice(), selected = ids.splice(picks[0], 1)[0]; p.deck.unshift(...ids); addHand(g, p, selected, 'tactic'); } return;
      case 'SD01-0013':
        if (!stage && empty(p).length && choose(1, handOptions(p, h => isOperator(h) && card(h).level === 2))) return;
        if (stage === 1 && picks.length && empty(p).length) return ask(g, { ...t, hand: picks[0] }, 2, empty(p));
        { const deferred = stage === 2 ? deploy(g, p, t.hand, picks[0], true, true) : null;
          if (p.field.includes('SD01-0006')) upgrade(g, p);
          finishDeployment(g, p, deferred, t.tacticHuang || []); } return;
      case 'SD01-0014':
        if (!stage) {
          const top = p.deck[0]; if (!top) return;
          log(g, `${p.name}公开卡组顶【${card(top).name}】`, { cardId: top });
          if (isOperator(top) && trait(top, '罗德岛')) return choose(1, graveOptions(p, h => isOperator(h) && trait(h, '罗德岛')), { min: 0 });
        } else if (picks.length) recover(g, p, picks[0]); return;
      case 'SD01-0015':
        if (!stage) return choose(1, fieldOptions(g, p, (_, s) => column(s) === column(t.trapSlot) && p.hand.some(h => isOperator(h) && card(h).level === card(p.field[s]).level)));
        if (stage === 1) return ask(g, { ...t, wantedLevel: card(p.field[picks[0].slot]).level }, 2, handOptions(p, h => isOperator(h) && card(h).level === card(p.field[picks[0].slot]).level));
        if (stage === 2) return ask(g, { ...t, hand: picks[0] }, 3, empty(p));
        if (stage === 3) deploy(g, p, t.hand, picks[0], true); return;
      case 'SD02-0001':
        if (t.event === 'deploy') { draw(g, p, 1); return; }
        if (!stage) return choose(1, handOptions(p), { title: '德克萨斯：选择1张手牌作为费用' });
        discard(p, picks); p.once.texas = g.turnSequence;
        recover(g, p, p.grave.indexOf(id)); return;
      case 'SD02-0002':
      case 'SD02-0003': {
        const opts = fieldOptions(g, op, (c, s) => id === 'SD02-0002' ? movable(op, s).length > 0 : card(c).level === 1);
        const cost = id === 'SD02-0002' ? 1 : 2;
        if (!stage && p.hand.length >= cost && opts.length) return choose(1, [option(true, `丢弃${cost}张手牌发动`)], { min: id === 'SD02-0003' ? 0 : 1 });
        if (stage === 1 && picks.length) return choose(2, handOptions(p), { min: cost, max: cost, title: `选择${cost}张费用牌` });
        if (stage === 2) { discard(p, picks); return choose(3, opts); }
        if (stage === 3) {
          if (id === 'SD02-0003') { takeField(g, picks[0], 'hand'); return; }
          return ask(g, { ...t, target: picks[0] }, 4, movable(op, picks[0].slot));
        }
        if (stage === 4 && live(g, t.target)) {
          const from = t.target.slot, to = picks[0]; op.field[to] = op.field[from]; op.fieldMeta[to] = op.fieldMeta[from]; op.fieldEnteredTurn[to] = op.fieldEnteredTurn[from]; op.fieldAttackedTurn[to] = op.fieldAttackedTurn[from];
          op.field[from] = null; op.fieldMeta[from] = null; op.fieldEnteredTurn[from] = -1; op.fieldAttackedTurn[from] = -1;
          log(g, `${op.name}的干员移至第${column(to) + 1}战线`);
        } return;
      }
      case 'SD02-0005':
        if (!stage && sourceExists()) return choose(1, fieldOptions(g, op, (_, s) => column(s) === column(t.source.slot) && power(g, op, s) <= power(g, p, t.source.slot)), { min: 0 });
        if (picks.length) takeField(g, picks[0], 'hand'); return;
      case 'SD02-0006': if (t.event === 'turn' && sourceExists()) upgrade(g, p); return;
      case 'SD02-0008':
        if (sourceExists()) {
          const targets = op.field.map((c, s) => c && column(s) === column(t.source.slot) && power(g, op, s) < power(g, p, t.source.slot) ? ref(op, s) : null).filter(Boolean);
          defeated(g, targets.map(r => takeField(g, r, 'grave')));
        } return;
      case 'SD02-0009':
        if (!stage) return choose(1, fieldOptions(g, p, (_, s) => p.field.some((c, i) => c && adjacent(s, i))));
        if (stage === 1) return ask(g, { ...t, target: picks[0] }, 2, fieldOptions(g, p, (_, s) => adjacent(picks[0].slot, s)));
        if (stage === 2 && live(g, t.target) && live(g, picks[0])) {
          const m = p.fieldMeta[t.target.slot]; const amount = power(g, p, picks[0].slot);
          m.buff = (m.buffTurn === g.turnSequence ? m.buff || 0 : 0) + amount; m.buffTurn = g.turnSequence;
          log(g, `【协同作战】战斗力增加${amount}，直到回合结束`);
        } return;
      case 'SD02-0010':
      case 'SD02-0011':
        if (id === 'SD02-0011' && !['evolve', 'turn'].includes(t.event)) return;
        if (!stage) return choose(1, graveOptions(p, h => trait(h, '龙门') && (id === 'SD02-0011' || isOperator(h))));
        recover(g, p, picks[0]); return;
      case 'SD02-0012': draw(g, p, 2); if (p.field.some(c => card(c)?.name === '诗怀雅')) upgrade(g, p); return;
      case 'SD02-0013':
        if (!stage) { draw(g, p, 1); if (empty(p).length && choose(1, handOptions(p, h => basic(h) && trait(h, '龙门')))) return; }
        if (stage === 1 && picks.length && empty(p).length) return ask(g, { ...t, hand: picks[0] }, 2, empty(p));
        if (stage === 2) { const deferred = deploy(g, p, t.hand, picks[0], true, true); push(g, { ...t, stage: 3, deferred }); return; }
        if (p.field.some(c => card(c)?.name === '陈') && p.field.some(c => card(c)?.name === '诗怀雅') && choose(4, evolvePairs(g, p, h => trait(h, '龙门')), { min: 0 })) return;
        finishDeployment(g, p, t.deferred); return;
      case 'SD02-0014': {
        const chen = p.field.map((c, s) => card(c)?.name === '陈' ? power(g, p, s) : -1); const highest = Math.max(...chen);
        if (!stage) {
          const opts = fieldOptions(g, op, (_, s) => power(g, op, s) > highest);
          if (highest >= 0 && opts.length) return choose(1, opts);
          if (g.attackContext) g.attackContext.cancelled = true;
        } else { const removed = takeField(g, picks[0], 'grave'); if (!removed && g.attackContext) g.attackContext.cancelled = true; defeated(g, [removed]); }
        return;
      }
      case 'SD01-0016': case 'SD02-0015':
        if (!stage && level(p) === 1 && p.hand.length >= 2) return choose(1, handOptions(p), { min: 0, max: 2, title: 'Lv1基地：选择2张手牌升级，或跳过' });
        if (stage === 1 && picks.length) { check(picks.length === 2, '必须选择2张费用牌或跳过。'); discard(p, picks); upgrade(g, p); } return;
      case 'SD01-0017': case 'SD02-0016':
        if (!used(p, id, g)) { p.once[id] = g.turnSequence; draw(g, p, 1); } return;
      case 'SD01-0018':
        if (!stage) return choose(1, graveOptions(p, h => isOperator(h) && trait(h, '罗德岛')), { min: 0 });
        if (picks.length) { p.once[id] = g.turnSequence; recover(g, p, picks[0]); } return;
      default: return; // Static keywords are interpreted by legality/power/battle code.
    }
  }

  function targets(g, p, slot) {
    const op = other(g, p.id), a = card(p.field[slot]);
    const line = op.field.flatMap((c, i) => c && column(i) === column(slot) ? [i] : []);
    const forced = line.filter(i => card(op.field[i]).forceAttackTarget || (card(op.field[i]).forceAttackTargetWhenFront && i < 4));
    const front = line.filter(i => i < 4);
    return { line, forced, legal: forced.length ? forced : a.attackRange === '远程' || a.canAttackAsRanged ? line : front.length ? front : line, front };
  }
  function battle(g, context) {
    g.attackContext = null;
    if (context.cancelled || !live(g, context.attacker)) { log(g, '攻击已无效或攻击者离场'); return; }
    const p = player(g, context.attacker.owner), op = other(g, p.id), a = context.attacker.slot, attackerId = p.field[a], legal = targets(g, p, a);
    if (context.target && (!live(g, context.target) || !legal.legal.includes(context.target.slot))) { log(g, '攻击目标已失效，本次攻击结束'); return; }
    if (!context.target && legal.line.length) { log(g, '战线出现守方干员，直接攻击结束'); return; }
    const ranged = Boolean(context.target && context.target.slot >= 4 && legal.front.length && !legal.forced.length && card(attackerId).canAttackAsRanged);
    const atk = Math.max(0, power(g, p, a) + (ranged ? Number(card(attackerId).rangedAttackModifier || 0) : 0));
    if (context.target) {
      const s = context.target.slot, targetId = op.field[s], def = power(g, op, s), records = [];
      if (atk <= def) records.push(takeField(g, context.attacker, 'grave', true));
      if (atk >= def) records.push(takeField(g, context.target, 'grave', true));
      g.resolvedAction = { type: 'attack_operator', by: p.id, attackerSlotIndex: a, targetSlotIndex: s, attackerCardId: attackerId, targetCardId: targetId, attackerAttack: atk, targetAttack: def, attackMode: ranged ? 'ranged' : 'melee', result: atk > def ? 'attacker_win' : atk < def ? 'defender_win' : 'draw' };
      log(g, `【${card(attackerId).name}】${atk} 对 【${card(targetId).name}】${def}`); defeated(g, records);
    } else if (!op.baseLife.length) {
      g.ended = true; g.phase = 'ended'; g.winnerId = p.id; g.loserId = op.id; g.endReason = `${op.name}基地生命为0后再次受到直接攻击。`;
      g.queue = []; g.pendingChoice = null;
      g.resolvedAction = { type: 'game_end', by: p.id, attackerSlotIndex: a, attackerCardId: attackerId, winnerId: p.id, loserId: op.id };
    } else {
      const id = op.baseLife.pop(), def = Number(card(id)?.attack || 0); op.grave.push(id);
      log(g, `${op.name}基地生命翻开【${card(id).name}】`, { cardId: id });
      const removed = isOperator(id) && atk <= def ? takeField(g, context.attacker, 'grave', true) : null;
      g.resolvedAction = { type: 'base_life_reveal', by: p.id, attackerSlotIndex: a, attackerCardId: attackerId, revealedBaseLife: id, remainingBaseLife: op.baseLife.length, lifeBattle: isOperator(id) ? { cardId: id, attackerAttack: atk, defenderAttack: def, result: atk > def ? 'attacker_win' : atk < def ? 'defender_win' : 'draw' } : null };
      defeated(g, [removed]); // A revealed life card was never a field operator.
    }
  }
  function run(g) {
    let steps = 0;
    while (g.queue.length && !g.pendingChoice && !g.ended) {
      check(++steps <= 1000, '效果循环超过安全上限。');
      const t = g.queue.shift(), p = player(g, t.owner);
      switch (t.type) {
        case 'effect':
          if (t.cardId === 'SD02-0013' && t.stage === 4) {
            push(g, { type: 'finishDeployment', owner: p.id, deferred: t.deferred });
            if (t.picks.length) evolve(g, p, t.picks[0].hand, t.picks[0].target);
          }
          else resolveEffect(g, t);
          break;
        case 'finishDeployment': finishDeployment(g, p, t.deferred); break;
        case 'addHand': addHand(g, p, t.cardId, 'effect', !t.private); break;
        case 'returnTop': p.deck.unshift(...t.picks.map(i => t.ids[i])); break;
        case 'order':
          if (t.tasks.length === 1) push(g, t.tasks[0]);
          else if (t.stage === 1) push(g, ...t.picks.map(i => t.tasks[i]));
          else ask(g, t, 1, t.tasks.map((task, i) => option(i, `${card(task.cardId)?.name || '效果'}${task.source ? ' · 第' + (column(task.source.slot) + 1) + '战线' : ''}`, task.cardId)), { min: t.tasks.length, max: t.tasks.length, ordered: true, title: '选择同时触发效果的结算顺序' });
          break;
        case 'startDraw': {
          const starts = Number(g.startedTurns[p.id]);
          const n = p.id === g.firstPlayerId && starts === 1 ? 0 : starts === 1 ? 1 : level(p);
          draw(g, p, n); g.phase = 'main'; break;
        }
        case 'reaction':
          if (t.event === 'attack' && (!g.attackContext || g.attackContext.cancelled || !live(g, g.attackContext.attacker))) break;
          if (t.stage === 1) {
            if (!t.picks.length) break;
            const s = t.picks[0], id = p.traps[s].cardId; p.traps[s] = null; p.grave.push(id);
            log(g, `${p.name}发动陷阱【${card(id).name}】`, { cardId: id, slot: s });
            push(g, { type: 'reaction', owner: p.id, event: t.event });
            tacticTriggers(g, p, id);
            push(g, effect(p.id, id, { trapSlot: s }));
          } else ask(g, t, 1, eligibleTraps(g, p, t.event), { min: 0, title: `${p.name}：${t.event === 'attack' ? '对方攻击' : '对方干员部署'}，是否发动陷阱？` });
          break;
        case 'battle': battle(g, g.attackContext); break;
      }
    }
  }
  function beginTurn(g, owner) {
    ensure(g); check(!g.pendingChoice && !g.queue.length, '尚有未结算效果。');
    const p = player(g, owner); g.currentPlayerId = owner; g.turnSequence = Number(g.turnSequence || 0) + 1; g.playsThisTurn = 0;
    g.startedTurns[owner] = Number(g.startedTurns[owner] || 0) + 1;
    p.fieldMeta.forEach(m => { if (m) { m.attacks = 0; m.attackTurn = g.turnSequence; } });
    if (!p.activeBase && p.baseDeck.length) { p.activeBase = p.baseDeck.shift(); p.baseStack.push(p.activeBase); }
    g.phase = 'turn_start_effects';
    const tasks = [];
    if (g.startedTurns[owner] >= 2 && level(p) === 1) tasks.push(effect(owner, p.activeBase));
    p.field.forEach((id, s) => { if (['SD01-0006', 'SD02-0006', 'SD02-0011'].includes(id)) tasks.push(effect(owner, id, { event: 'turn', source: ref(p, s) })); });
    push(g, { type: 'order', owner, tasks }, { type: 'startDraw', owner }); run(g);
    return { starts: g.startedTurns[owner], awaitingBaseDecision: false, drawCount: 0, requestedDraw: 0 };
  }
  function command(g, owner, action, msg = {}) {
    ensure(g); const p = player(g, owner); check(p && !g.ended && g.phase !== 'ended', '对局已结束或玩家不存在。');
    g.resolvedAction = null;
    if (action === 'resolve_choice') {
      const c = g.pendingChoice;
      check(c && c.owner === owner && c.id === msg.choiceId, '选择已过期或不属于你。');
      check(Array.isArray(msg.optionIds) && new Set(msg.optionIds).size === msg.optionIds.length, '选择格式错误。');
      const selected = msg.optionIds.map(id => c.options.find(o => o.id === id));
      check(selected.every(Boolean) && selected.length >= c.min && selected.length <= c.max, '选择数量或目标不合法。');
      if (c.next.cardId === 'SD01-0016' || c.next.cardId === 'SD02-0015') check(selected.length === 0 || selected.length === 2, '基地升级必须丢弃2张或跳过。');
      g.pendingChoice = null; push(g, { ...c.next, picks: selected.map(o => o.value) }); run(g); return;
    }
    check(!g.pendingChoice && !g.queue.length, '等待玩家选择或效果结算，不能进行其他操作。');
    check(g.phase === 'main' && g.currentPlayerId === owner, '现在不是你的主要阶段。');
    if (action === 'end_turn') {
      if (owner === g.secondPlayerId) g.round++;
      const turnStart = beginTurn(g, other(g, owner).id);
      g.resolvedAction = { type: 'end_turn', by: owner, nextPlayerId: g.currentPlayerId, turnStart }; return;
    }
    if (action === 'activate_base') {
      check(p.baseStack.includes('SD01-0018') && !used(p, 'SD01-0018', g) && p.field.some(id => card(id)?.name === '阿米娅') && p.grave.some(id => isOperator(id) && trait(id, '罗德岛')), '基地效果条件不满足。');
      push(g, effect(owner, 'SD01-0018')); run(g); return;
    }
    if (action === 'activate_grave') {
      check(p.grave.includes('SD02-0001') && p.hand.length && !used(p, 'texas', g), '德克萨斯效果条件不满足。');
      push(g, effect(owner, 'SD02-0001', { event: 'grave' })); run(g); return;
    }
    if (['deploy_operator', 'evolve', 'use_tactic', 'set_trap'].includes(action)) {
      const index = p.hand.indexOf(msg.cardId), c = card(msg.cardId), s = Number(msg.slotIndex);
      check(index >= 0 && c, '卡牌不在手牌中。'); check(c.level <= level(p), '基地等级不足。');
      check(c.onlineStatus !== 'pending', '这张卡的效果待接入，暂不能用于联机。');
      check(g.playsThisTurn < level(p), '本回合出牌次数已达上限。');
      if (action === 'deploy_operator') {
        check(basic(c.id), '精英化干员必须使用精英化操作。');
        check(Number.isInteger(s) && s >= 0 && s < 8, '位置不合法。');
        deploy(g, p, index, s); g.resolvedAction = { type: 'deploy_operator', by: owner, cardId: c.id, slotIndex: s };
      } else if (action === 'evolve') {
        check(c.operatorType === '精英化' && Number.isInteger(s) && basic(p.field[s]) && card(p.field[s]).name === c.name, '必须选择同名基础干员。');
        evolve(g, p, index, ref(p, s));
      } else if (action === 'set_trap') {
        check(c.tacticType === '陷阱' && Number.isInteger(s) && s >= 4 && s < 8 && !p.field[s] && !p.traps[s], '陷阱必须盖放在空的后排。');
        p.hand.splice(index, 1); p.traps[s] = { cardId: c.id, setTurn: g.turnSequence };
        log(g, `${p.name}在后排第${column(s) + 1}战线盖放1张陷阱`);
      } else {
        check(c.tacticType === '通常', '只有通常战术可以直接使用。');
        if (c.id === 'SD02-0009') check(p.field.some((id, i) => id && p.field.some((j, s) => j && adjacent(i, s))), '没有相邻干员可使用协同作战。');
        p.hand.splice(index, 1); p.grave.push(c.id); log(g, `${p.name}使用【${c.name}】`, { cardId: c.id });
        const snapshot = trait(c.id, '罗德岛') ? huangTasks(g, p) : [];
        if (c.id === 'SD01-0013') push(g, effect(owner, c.id, { tacticHuang: snapshot }));
        else { tacticTriggers(g, p, c.id); push(g, effect(owner, c.id)); }
      }
      g.playsThisTurn++; run(g); return;
    }
    if (action === 'attack_operator' || action === 'attack_player') {
      const a = Number(msg.attackerSlotIndex), s = Number(msg.targetSlotIndex);
      check(Number.isInteger(a) && a >= 0 && a < 8 && p.field[a], '攻击者不存在。');
      const m = p.fieldMeta[a], c = card(p.field[a]), op = other(g, owner);
      check(!c.cannotAttack && m.entered !== g.turnSequence, '该干员不能攻击或本回合刚部署。');
      const count = m.attackTurn === g.turnSequence ? m.attacks : 0;
      check(count < Number(c.maxAttacksPerTurn || 1), '该干员本回合攻击次数已用完。');
      const legal = targets(g, p, a);
      check(action === 'attack_player' ? legal.line.length === 0 : Number.isInteger(s) && legal.legal.includes(s), '攻击目标不合法。');
      m.attacks = count + 1; m.attackTurn = g.turnSequence; p.fieldAttackedTurn[a] = g.turnSequence;
      g.attackContext = { attacker: ref(p, a), target: action === 'attack_operator' ? ref(op, s) : null, cancelled: false };
      log(g, `${p.name}用【${c.name}】宣言攻击`);
      push(g, { type: 'reaction', owner: op.id, event: 'attack' }, { type: 'battle' }); run(g); return;
    }
    fail('未知规则操作。');
  }
  // Failed choices/actions leave the authoritative state untouched.
  function execute(g, owner, action, msg) {
    const draft = JSON.parse(JSON.stringify(g, (key, value) => key === 'ws' ? undefined : value));
    command(draft, owner, action, msg);
    const originalPlayers = g.players;
    draft.players.forEach((p, i) => Object.assign(originalPlayers[i], p));
    Object.assign(g, draft, { players: originalPlayers });
    return g.resolvedAction;
  }
  function view(g, owner) {
    ensure(g);
    const c = g.pendingChoice;
    return {
      pendingChoice: c ? c.owner === owner ? { id: c.id, owner: c.owner, title: c.title, hint: c.hint, min: c.min, max: c.max, ordered: c.ordered, options: c.options.map(({ id, label, cardId }) => ({ id, label, cardId })) } : { owner: c.owner, waiting: true } : null,
      legalActions: legalActions(g, owner),
      effectLog: g.effectLog.filter(e => !e.audience || e.audience === owner).slice(-60).map(({ audience, ...e }) => e),
      players: g.players.map(p => ({ id: p.id, powers: p.field.map((id, s) => id ? power(g, p, s) : null), meta: p.fieldMeta.map(m => m ? { uid: m.uid, stack: m.stack.slice(), entered: m.entered, attacks: m.attackTurn === g.turnSequence ? m.attacks : 0, protected: m.protectedTurn === g.turnSequence } : null), traps: p.traps.map(t => t ? p.id === owner ? { cardId: t.cardId, setTurn: t.setTurn } : { hidden: true } : null) }))
    };
  }
  function legalActions(g, owner) {
    const p = player(g, owner), result = { hand: [], attacks: [], base: false, grave: false, endTurn: false };
    if (!p || g.currentPlayerId !== owner || g.phase !== 'main' || g.pendingChoice || g.queue.length || g.ended) return result;
    result.endTurn = true;
    result.base = p.baseStack.includes('SD01-0018') && !used(p, 'SD01-0018', g) && p.field.some(id => card(id)?.name === '阿米娅') && p.grave.some(id => isOperator(id) && trait(id, '罗德岛'));
    result.grave = p.grave.includes('SD02-0001') && p.hand.length > 0 && !used(p, 'texas', g);
    if (g.playsThisTurn < level(p)) p.hand.forEach((id, index) => {
      const c = card(id); if (c.level > level(p)) return;
      if (basic(id) && empty(p).length) result.hand.push({ index, cardId: id, action: 'deploy_operator', slots: empty(p).map(o => o.value) });
      else if (c.operatorType === '精英化') {
        const slots = p.field.flatMap((c, s) => basic(c) && card(c).name === card(id).name ? [s] : []);
        if (slots.length) result.hand.push({ index, cardId: id, action: 'evolve', slots });
      } else if (c.tacticType === '陷阱' && empty(p, s => s >= 4).length) result.hand.push({ index, cardId: id, action: 'set_trap', slots: empty(p, s => s >= 4).map(o => o.value) });
      else if (c.tacticType === '通常' && (id !== 'SD02-0009' || p.field.some((c, i) => c && p.field.some((j, s) => j && adjacent(i, s))))) result.hand.push({ index, cardId: id, action: 'use_tactic' });
    });
    p.field.forEach((id, s) => {
      if (!id) return;
      const c = card(id), m = p.fieldMeta[s], n = m.attackTurn === g.turnSequence ? m.attacks : 0;
      if (!c.cannotAttack && m.entered !== g.turnSequence && n < Number(c.maxAttacksPerTurn || 1)) {
        const legal = targets(g, p, s); result.attacks.push({ slot: s, targets: legal.legal, direct: legal.line.length === 0 });
      }
    }); return result;
  }
  return { execute, beginTurn, view, power, ensure, card, RuleError };
};
