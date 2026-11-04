(function () {
  'use strict';
  // Reuse the solo input surfaces; only the server changes cards, effects and turns.
  let state = null, sending = false, selection = null, choiceId = null, selected = [], choiceHidden = false;
  let overlay = null, prompt = null, loggedGameId = null, lastEffectLogId = 0;
  const definitions = new Map([...window.rhodesCardDataV87.mainCards, ...window.rhodesCardDataV87.baseCards].map(c => [c.id, c]));
  const definition = id => definitions.get(id);
  const byId = id => document.getElementById(id);
  const ownChoice = () => state?.rules.pendingChoice && !state.rules.pendingChoice.waiting ? state.rules.pendingChoice : null;
  const legal = () => state.rules.legalActions;
  const handCards = () => Array.from(document.querySelectorAll('#handArea .card'));
  const sideFor = owner => owner === state.self.id ? 'player' : 'enemy';
  const slotFor = (owner, index) => window.rhodesPvpV94.slotFor(sideFor(owner), index);
  function element(tag, text, className) {
    const e = document.createElement(tag); if (text) e.textContent = text; if (className) e.className = className; return e;
  }
  function button(text, fn, disabled = false) {
    const b = element('button', text); b.type = 'button'; b.disabled = disabled; b.onclick = fn; return b;
  }
  function detail(card) { if (card && typeof showDetail === 'function') showDetail(card); }
  function closeDialog() { overlay?.remove(); overlay = null; }
  function hideMenus() {
    for (const id of ['cardActionMenu', 'battleActionMenu', 'baseLv3ActivateOverlay']) if (byId(id)) byId(id).style.display = 'none';
  }
  function clearHighlights() {
    document.querySelectorAll('.online-target,.online-picked,.online-source,.online-can-activate').forEach(e => {
      e.classList.remove('online-target', 'online-picked', 'online-source', 'online-can-activate'); e.removeAttribute('data-online-order');
    });
    document.querySelectorAll('.action-target,.attack-target,.attack-attacker,.dobermann-ranged-target').forEach(e => e.classList.remove('action-target', 'attack-target', 'attack-attacker', 'dobermann-ranged-target'));
  }
  function cancelSelection() {
    selection = null; hideMenus(); handCards().forEach(e => e.classList.remove('selected'));
    selectedCard = null; selectedAction = null; selectedAttacker = null; selectingAttackTarget = false;
    refreshInteraction();
  }
  function send(action, payload = {}) {
    if (!state || sending || state.ended) return;
    sending = true; selection = null; hideMenus(); closeDialog();
    const ok = window.rhodesPvpV94.send('game_action', { action, expectedRevision: state.revision, ...payload });
    if (!ok) { sending = false; notice('连接已断开，请等待重连后重试。'); }
    refreshInteraction();
  }
  function notice(text) {
    byId('onlineEffectNotice')?.remove();
    const box = element('div', text); box.id = 'onlineEffectNotice'; box.setAttribute('role', 'status');
    box.append(button('知道了', () => box.remove())); document.body.append(box); setTimeout(() => box.remove(), 10000);
  }
  function targetElement(target) {
    if (!target) return null;
    if (target.zone === 'hand' && target.owner === state.self.id) return handCards()[target.index] || null;
    if (['field', 'slot', 'trap'].includes(target.zone)) return slotFor(target.owner, target.index);
    return null;
  }
  function onBoard(c) { return c.options.length > 0 && c.options.every(o => targetElement(o.target)); }
  function pick(id) {
    const c = ownChoice(); if (!c || sending || window.onlineFeedbackBusy) return;
    const o = c.options.find(o => o.id === id); if (!o) return;
    detail(definition(o.cardId));
    if (c.max === 1 && !c.ordered) return send('resolve_choice', { choiceId: c.id, optionIds: [id] });
    const i = selected.indexOf(id);
    if (i >= 0) selected.splice(i, 1); else if (selected.length < c.max) selected.push(id);
    refreshInteraction(); if (!onBoard(c) && !choiceHidden) showChoiceDialog();
  }
  function validSelection(c) {
    return selected.length > 0 && selected.length >= c.min && selected.length <= c.max && (!c.allowedCounts || c.allowedCounts.includes(selected.length));
  }
  function choiceButtons(c, host) {
    if (c.max > 1 || c.ordered) host.append(button(c.ordered ? `确认顺序（${selected.length}/${c.max}）` : `确认选择（${selected.length}/${c.max}）`, () => send('resolve_choice', { choiceId: c.id, optionIds: selected.slice() }), sending || !validSelection(c)));
    if (c.min === 0) host.append(button('不发动', () => send('resolve_choice', { choiceId: c.id, optionIds: [] }), sending));
  }
  function dialog(title, hint) {
    closeDialog(); overlay = element('div', '', 'online-overlay'); overlay.id = 'onlineChoiceOverlay';
    const box = element('section', '', 'online-dialog'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', title);
    box.append(element('h2', title)); if (hint) box.append(element('p', hint));
    overlay.append(box); document.body.append(overlay); return box;
  }
  function showChoiceDialog() {
    const c = ownChoice(); if (!c || onBoard(c)) return;
    choiceHidden = false;
    const hint = c.ordered ? (c.title.includes('卡组顶') ? '依次点击卡牌排列顺序，先选的放在牌库最上方；再次点击可取消。' : '依次点击效果，按点击顺序结算；再次点击可取消。') : '点击卡牌选择目标，悬停可查看详细效果。';
    const box = dialog(c.title, hint), options = element('div', '', 'online-choice-cards');
    for (const o of c.options) {
      const card = definition(o.cardId), b = button('', () => pick(o.id), sending);
      b.className = 'online-choice-option'; b.setAttribute('aria-label', o.label);
      if (card) {
        const face = element('div', '', 'v59-order-card effect-popup-previewable'); face.cardData = card;
        face.append(element('strong', card.name, 'v59-order-card-name'), element('div', `Lv.${card.level} · ${card.type}`, 'v59-order-card-meta'), element('div', String(card.effect || '').replace(/\\n/g, '\n'), 'v59-order-card-effect'));
        if (card.attack !== undefined) face.append(element('div', `ATK ${card.attack}`, 'v59-order-card-attack'));
        if (typeof applyCardImageV88 === 'function') applyCardImageV88(face, card);
        b.append(face); b.onmouseenter = () => detail(card);
      }
      b.append(element('span', o.label, 'online-choice-label'));
      const order = selected.indexOf(o.id);
      if (order >= 0) { b.classList.add('chosen'); b.append(element('b', String(order + 1), 'online-choice-number')); }
      options.append(b);
    }
    const actions = element('div', '', 'online-actions'); choiceButtons(c, actions);
    actions.append(button('查看战场', () => { choiceHidden = true; closeDialog(); refreshInteraction(); }));
    box.append(options, actions);
  }
  function promptText() {
    const c = ownChoice(); if (sending) return '正在处理…';
    if (c) {
      if (!onBoard(c)) return `${c.title}：请选择卡牌。`;
      const zone = c.options[0].target.zone;
      const text = zone === 'hand' ? c.max > 1 ? `点击发光的手牌选择费用（${selected.length}/${c.max}）。` : '点击发光的手牌。' : zone === 'slot' ? '点击发光的空位。' : zone === 'trap' ? '点击发光的盖牌发动，或选择不发动。' : '点击战场上发光的干员。';
      return `${c.title}：${text}`;
    }
    if (selection?.kind === 'place') return `【${definition(selection.action.cardId).name}】：${selection.action.action === 'evolve' ? '点击发光的同名基础干员精英化。' : '点击发光的位置。'}`;
    if (selection?.kind === 'attack') return selection.entry.direct ? '点击发光的对方基地生命进行直接攻击。' : '点击发光的敌方干员。';
    return state.rules.pendingChoice?.waiting ? '对方正在处理效果…' : '';
  }
  function refreshInteraction() {
    if (!state) return; clearHighlights();
    if (!prompt) { prompt = element('div'); prompt.id = 'onlineInteractionHint'; prompt.setAttribute('role', 'status'); document.body.append(prompt); }
    prompt.replaceChildren(); const text = !state.ended ? promptText() : ''; prompt.hidden = !text;
    if (text) prompt.append(element('span', text));
    const end = byId('endTurnButton');
    if (end) { end.disabled = sending || window.onlineFeedbackBusy || !legal().endTurn || Boolean(state.ended); end.classList.toggle('v50-action-locked', end.disabled); }
    if (state.ended || sending || window.onlineFeedbackBusy) return;
    const c = ownChoice();
    if (c) {
      if (onBoard(c)) {
        for (const o of c.options) {
          const e = targetElement(o.target); e.classList.add('online-target'); const order = selected.indexOf(o.id);
          if (order >= 0) { e.classList.add('online-picked'); e.setAttribute('data-online-order', String(order + 1)); }
        }
        choiceButtons(c, prompt);
      } else if (choiceHidden) prompt.append(button('继续选择', showChoiceDialog));
      return;
    }
    if (state.rules.pendingChoice) return;
    if (legal().base) byId('playerBaseArea')?.classList.add('online-can-activate');
    if (legal().grave) document.querySelector('.player-area .grave')?.classList.add('online-can-activate');
    if (selection?.kind === 'place') for (const s of selection.action.slots) slotFor(state.self.id, s)?.classList.add('action-target', 'online-target');
    if (selection?.kind === 'attack') {
      slotFor(state.self.id, selection.entry.slot)?.classList.add('attack-attacker', 'online-source');
      for (const s of selection.entry.targets) slotFor(state.opponent.id, s)?.classList.add('attack-target', 'online-target');
      if (selection.entry.direct) document.querySelector('.enemy-area .base-life')?.classList.add('attack-target', 'online-target');
    }
    if (selection?.kind === 'place' || selection?.kind === 'attack') prompt.append(button('取消', cancelSelection));
  }
  function menuAt(id, event) {
    hideMenus(); const menu = byId(id); menu.style.display = 'flex'; placeFixedUiNearPointer(menu, event, 12);
  }
  function selectHand(cardElement, event) {
    cancelSelection(); const index = handCards().indexOf(cardElement), card = definition(state.self.hand[index]); detail(card);
    if (sending || !card || state.rules.pendingChoice) return;
    const actions = legal().hand.filter(a => a.index === index);
    if (!actions.length) {
      if (state.isYourTurn && state.phase === 'main') notice(card.onlineStatus === 'pending' ? '这张卡的效果尚未接入联机。' : state.playsThisTurn >= state.playLimit ? '本回合的出牌次数已用完。' : '当前不能使用这张卡，请检查基地等级或场上目标。');
      return;
    }
    selection = { kind: 'hand', actions, index }; cardElement.classList.add('selected');
    const names = { deployButton: 'deploy_operator', evolveButton: 'evolve', useButton: 'use_tactic', setButton: 'set_trap' };
    for (const [id, action] of Object.entries(names)) { const b = byId(id); b.style.display = actions.some(a => a.action === action) ? 'block' : 'none'; b.disabled = false; }
    byId('cancelActionButton').style.display = 'block'; menuAt('cardActionMenu', event);
  }
  function selectOperator(slot, event) {
    cancelSelection(); const index = Array.from({ length: 8 }, (_, i) => slotFor(state.self.id, i)).indexOf(slot);
    detail(definition(state.self.field[index])); if (sending || state.rules.pendingChoice) return;
    const entry = legal().attacks.find(e => e.slot === index); if (!entry) return;
    selection = { kind: 'operator', entry }; byId('attackButton').disabled = false; menuAt('battleActionMenu', event);
  }
  function openOwnGrave() {
    openGraveViewer(playerGrave, '我方弃牌区');
    const area = byId('graveCards'); area.querySelectorAll('.v82-grave-activate').forEach(b => b.remove());
    if (!legal().grave || sending || state.rules.pendingChoice) return;
    const index = state.self.grave.indexOf('SD02-0001'), card = area.querySelectorAll('.card')[index];
    if (card) card.append(button('发动【弃牌区】效果', () => { byId('graveOverlay').style.display = 'none'; send('activate_grave'); }));
  }
  function renderBoard(message) {
    for (const [side, p] of [['player', message.self], ['enemy', message.opponent]]) {
      const info = message.rules.players.find(x => x.id === p.id); if (!info) continue;
      for (let s = 0; s < 8; s++) {
        const slot = window.rhodesPvpV94.slotFor(side, s); if (!slot) continue;
        slot.querySelectorAll('.online-power,.online-trap').forEach(e => e.remove());
        const field = slot.querySelector('.card');
        if (field && p.field[s]) {
          field.dataset.serverPower = String(info.powers[s]); field.stackCards = (info.meta[s]?.stack || []).map(definition);
          field.dataset.onlineUid = String(info.meta[s]?.uid || '');
          field.append(element('span', `ATK ${info.powers[s]}${info.meta[s]?.protected ? ' · 战斗保护' : ''}`, 'online-power'));
        }
        if (info.traps[s]) {
          slot.dataset.hasTrap = 'true'; const c = info.traps[s].cardId;
          const trap = element('div', c ? `盖放\n${definition(c).name}` : '盖放卡', 'card online-trap');
          trap.cardData = c ? definition(c) : { name: '盖放卡', type: '盖放卡' }; slot.append(trap);
        }
      }
    }
  }
  window.renderOnlineEffects = function (message) {
    if (!message.rules) return; window.onlineEffectsEnabled = true;
    const old = state, previousLogId = old?.gameId === message.gameId ? Math.max(0, ...old.rules.effectLog.map(e => e.id)) : null;
    const changed = !old || old.gameId !== message.gameId || old.revision !== message.revision;
    state = message; sending = false;
    if (changed) { selection = null; hideMenus(); handCards().forEach(e => e.classList.remove('selected')); }
    renderBoard(message); const c = ownChoice();
    if (loggedGameId !== message.gameId) { loggedGameId = message.gameId; lastEffectLogId = 0; }
    for (const entry of message.rules.effectLog) {
      if (entry.id > lastEffectLogId && typeof window.recordPlayActionV60 === 'function') window.recordPlayActionV60(entry.text);
      lastEffectLogId = Math.max(lastEffectLogId, entry.id);
    }
    if (!c || c.id !== choiceId) { selected = []; choiceHidden = false; closeDialog(); }
    choiceId = c?.id || null;
    if (message.ended) { closeDialog(); hideMenus(); }
    else if (c && !onBoard(c) && !choiceHidden) showChoiceDialog();
    if (changed && old && byId('graveOverlay')) byId('graveOverlay').style.display = 'none';
    refreshInteraction();
    if (previousLogId !== null) {
      const skipped = message.rules.effectLog.filter(e => e.id > previousLogId && e.reason === 'condition_not_met');
      if (skipped.length) notice(skipped.map(e => e.text).join('\n'));
    }
  };
  window.onlineEffectsError = function (message) {
    sending = false; cancelSelection(); notice(message.message || '操作未完成。');
    const c = ownChoice(); if (c && !onBoard(c) && !choiceHidden) showChoiceDialog();
  };
  window.setOnlineFeedbackBusy = function (busy) {
    window.onlineFeedbackBusy = busy;
    if (busy) { selection = null; hideMenus(); closeDialog(); }
    refreshInteraction();
    const c = ownChoice();
    if (!busy && c && !onBoard(c) && !choiceHidden) showChoiceDialog();
  };
  document.addEventListener('mouseover', function (event) {
    if (!window.onlineEffectsEnabled || !state) return;
    const trap = event.target.closest?.('.player-zone .online-trap');
    if (trap && !trap.contains(event.relatedTarget)) detail(trap.cardData);
  });
  document.addEventListener('click', function (event) {
    if (!window.onlineEffectsEnabled || !state || overlay?.contains(event.target) || prompt?.contains(event.target)) return;
    const target = event.target.closest?.('#cardActionMenu button,#battleActionMenu button,#endTurnButton,#handArea .card,.player-zone .player-slot,.enemy-area .slot-group .slot,.enemy-area .base-life,#playerBaseArea,.player-area .grave,#baseLv3ActivateConfirmButton,#baseLv3ActivateCancelButton');
    if (!target || state.phase === 'mulligan') return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (target.id === 'cancelActionButton' || target.id === 'cancelBattleActionButton') return cancelSelection();
    if (sending || state.ended || window.onlineFeedbackBusy) return;
    const c = ownChoice();
    if (c) {
      const o = c.options.find(o => { const e = targetElement(o.target); return e && (e === target || e.contains(event.target)); });
      if (o) return pick(o.id);
      detail(target.cardData || target.querySelector('.card')?.cardData); return;
    }
    if (target.id === 'baseLv3ActivateCancelButton') return hideMenus();
    if (target.id === 'baseLv3ActivateConfirmButton') { if (legal().base) send('activate_base'); return; }
    if (target.id === 'endTurnButton') { if (legal().endTurn) send('end_turn'); return; }
    if (target.closest('#handArea')) return selectHand(target, event);
    const actionNames = { deployButton: 'deploy_operator', evolveButton: 'evolve', setButton: 'set_trap', useButton: 'use_tactic' };
    if (actionNames[target.id]) {
      const action = selection?.actions?.find(a => a.action === actionNames[target.id]); if (!action) return;
      hideMenus(); if (!action.slots) return send(action.action, { cardId: action.cardId });
      selection = { kind: 'place', action }; refreshInteraction(); return;
    }
    if (target.id === 'attackButton') {
      if (selection?.kind !== 'operator') return;
      selection = { kind: 'attack', entry: selection.entry }; hideMenus(); refreshInteraction(); return;
    }
    if (selection?.kind === 'place') {
      const { action } = selection, index = action.slots.find(s => slotFor(state.self.id, s) === target);
      if (index !== undefined) send(action.action, { cardId: action.cardId, slotIndex: index }); return;
    }
    if (selection?.kind === 'attack') {
      const { entry } = selection, index = entry.targets.find(s => slotFor(state.opponent.id, s) === target);
      if (index !== undefined) send('attack_operator', { attackerSlotIndex: entry.slot, targetSlotIndex: index });
      else if (entry.direct && target.matches('.enemy-area .base-life')) send('attack_player', { attackerSlotIndex: entry.slot });
      return;
    }
    if (target.matches('.player-zone .player-slot')) return selectOperator(target, event);
    if (target.id === 'playerBaseArea') {
      cancelSelection(); detail(definition(state.self.activeBase));
      if (legal().base) byId('baseLv3ActivateOverlay').style.display = 'flex'; return;
    }
    if (target.matches('.player-area .grave')) return openOwnGrave();
    detail(target.cardData || target.querySelector('.card')?.cardData);
  }, true);
  document.addEventListener('keydown', event => {
    if (!window.onlineEffectsEnabled || !state || event.key !== 'Escape') return;
    if (ownChoice()) { choiceHidden = true; closeDialog(); refreshInteraction(); } else cancelSelection();
  });
  const originalPower = calculateOperatorAttack;
  calculateOperatorAttack = function (operator, context) {
    const raw = operator?.cardElement?.dataset.serverPower;
    if (!window.onlineEffectsEnabled || raw === undefined) return originalPower(operator, context);
    const base = Number(operator.cardData?.attack || 0); let final = Number(raw);
    if (context?.isAttacker && context.attackMode === 'ranged') final += Number(operator.cardData?.rangedAttackModifier || 0);
    final = Math.max(0, final); return { base, modifier: final - base, final, details: [] };
  };
})();
