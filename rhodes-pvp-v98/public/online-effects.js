(function () {
  'use strict';
  let state = null, overlay = null, toolbar = null, sending = false, choiceId = null, selected = [], mode = 'actions';
  const definitions = new Map(window.rhodesCardDataV87.mainCards.map(c => [c.id, c]));
  const definition = id => definitions.get(id);
  function element(tag, text, className) { const e = document.createElement(tag); if (text) e.textContent = text; if (className) e.className = className; return e; }
  function button(text, fn, disabled = false) { const b = element('button', text); b.type = 'button'; b.disabled = disabled; b.onclick = fn; return b; }
  function close() { if (overlay) overlay.remove(); overlay = null; }
  function dialog(title, hint) {
    close(); overlay = element('div', '', 'online-overlay');
    const box = element('section', '', 'online-dialog'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', title);
    box.append(element('h2', title)); if (hint) box.append(element('p', hint));
    overlay.append(box); document.body.append(overlay); return box;
  }
  function send(action, payload = {}) {
    if (!state || sending) return;
    sending = true;
    const ok = window.rhodesPvpV94.send('game_action', { action, expectedRevision: state.revision, ...payload });
    if (!ok) { sending = false; showError('连接已断开，请等待重连。'); }
    else { close(); updateToolbar(); }
  }
  function showError(text) {
    const box = dialog('操作未完成', text); box.append(button('返回操作', () => state?.rules.pendingChoice && !state.rules.pendingChoice.waiting ? showChoice() : showActions()));
  }
  function addCardText(b, id) {
    const c = definition(id); if (!c) return;
    b.append(element('small', `${c.type} · Lv.${c.level}\n${String(c.effect).replace(/\\n/g, '\n')}`));
  }
  function place(action) {
    mode = 'place';
    const box = dialog(`${action.action === 'set_trap' ? '盖放' : action.action === 'evolve' ? '精英化' : '部署'}【${definition(action.cardId).name}】`, '选择战场位置。');
    const options = element('div', '', 'online-options');
    for (const s of action.slots) options.append(button(`${s < 4 ? '前排' : '后排'} · 第${s % 4 + 1}战线${state.self.field[s] ? '\n' + definition(state.self.field[s]).name : ''}`, () => send(action.action, { cardId: action.cardId, slotIndex: s })));
    box.append(options, button('返回', showActions));
  }
  function attack(entry) {
    mode = 'attack'; const box = dialog('选择攻击目标', '攻击宣言后，对手的陷阱可能暂停结算。');
    const options = element('div', '', 'online-options');
    for (const s of entry.targets) options.append(button(`${s < 4 ? '前排' : '后排'}第${s % 4 + 1}战线 · ${definition(state.opponent.field[s]).name}`, () => send('attack_operator', { attackerSlotIndex: entry.slot, targetSlotIndex: s })));
    if (entry.direct) options.append(button('直接攻击对方基地生命', () => send('attack_player', { attackerSlotIndex: entry.slot })));
    box.append(options, button('返回', showActions));
  }
  function showActions() {
    if (!state) return;
    if (state.rules.pendingChoice && !state.rules.pendingChoice.waiting) return showChoice();
    mode = 'actions';
    const legal = state.rules.legalActions;
    const box = dialog('联机操作', state.rules.pendingChoice ? '正在等待对手选择。' : state.isYourTurn ? `本回合出牌 ${state.playsThisTurn}/${state.playLimit}；以下操作均由服务器验证。` : '现在是对方回合。');
    const options = element('div', '', 'online-options');
    const names = { deploy_operator: '部署', evolve: '精英化', set_trap: '盖放', use_tactic: '使用' };
    for (const action of legal.hand) {
      const b = button(`${names[action.action]}【${definition(action.cardId).name}】`, () => action.slots ? place(action) : send(action.action, { cardId: action.cardId }), sending);
      addCardText(b, action.cardId); options.append(b);
    }
    for (const entry of legal.attacks) options.append(button(`攻击 · 第${entry.slot % 4 + 1}战线【${definition(state.self.field[entry.slot]).name}】`, () => attack(entry), sending));
    if (!options.childNodes.length) options.append(element('p', state.phase === 'mulligan' ? '请先在手牌区选择调度牌并确认调度。' : '当前没有可用的出牌或攻击操作。'));
    box.append(options);
    const actions = element('div', '', 'online-actions');
    if (legal.base) actions.append(button('发动罗德岛 Lv3 基地', () => send('activate_base'), sending));
    if (legal.grave) actions.append(button('发动弃牌区德克萨斯', () => send('activate_grave'), sending));
    if (legal.endTurn) actions.append(button('结束回合', () => send('end_turn'), sending));
    actions.append(button('查看战场', close)); box.append(actions);
    const history = state.rules.effectLog.slice(-14).map(e => e.text).join('\n');
    if (history) box.append(element('h3', '最近结算'), element('div', history, 'online-log'));
  }
  function showChoice() {
    const c = state?.rules.pendingChoice;
    if (!c || c.waiting) return showActions();
    mode = 'choice';
    if (choiceId !== c.id) { selected = []; choiceId = c.id; }
    const box = dialog(c.title, `${c.hint}\n选择 ${c.min === c.max ? c.min : c.min + '～' + c.max} 项${c.ordered ? '，先选的先结算/位于牌库最上方' : ''}。`);
    const options = element('div', '', 'online-options');
    for (const o of c.options) {
      const index = selected.indexOf(o.id);
      const b = button(`${index >= 0 ? '✓ ' + (index + 1) + ' · ' : ''}${o.label}`, () => {
        const i = selected.indexOf(o.id);
        if (i >= 0) selected.splice(i, 1);
        else if (c.max === 1) selected = [o.id];
        else if (selected.length < c.max) selected.push(o.id);
        showChoice();
      }, sending);
      if (index >= 0) b.classList.add('chosen');
      if (o.cardId) addCardText(b, o.cardId);
      options.append(b);
    }
    box.append(options);
    const actions = element('div', '', 'online-actions');
    const invalid = selected.length < c.min || selected.length > c.max || (c.title.startsWith('Lv1基地') && selected.length === 1);
    actions.append(button('确认选择', () => send('resolve_choice', { choiceId: c.id, optionIds: selected.slice() }), sending || invalid));
    if (c.min === 0) actions.append(button('跳过 / 不发动', () => send('resolve_choice', { choiceId: c.id, optionIds: [] }), sending));
    actions.append(button('查看战场', close)); box.append(actions);
  }
  function updateToolbar() {
    if (!toolbar) {
      toolbar = element('div'); toolbar.id = 'onlineToolbar'; document.body.append(toolbar);
    }
    toolbar.replaceChildren();
    if (!state || state.ended) { toolbar.style.display = 'none'; return; }
    toolbar.style.display = 'flex';
    const c = state.rules.pendingChoice;
    toolbar.append(element('span', sending ? '服务器确认中…' : c ? c.waiting ? '等待对手选择' : '需要你选择' : state.isYourTurn ? '你的回合' : '对方回合'));
    toolbar.append(button(c && !c.waiting ? '继续选择' : '联机操作', () => c && !c.waiting ? showChoice() : showActions(), sending));
  }
  function renderBoard(message) {
    for (const [side, p] of [['player', message.self], ['enemy', message.opponent]]) {
      const info = message.rules.players.find(x => x.id === p.id);
      if (!info) continue;
      for (let s = 0; s < 8; s++) {
        const slot = window.rhodesPvpV94.slotFor(side, s); if (!slot) continue;
        const field = slot.querySelector('.card');
        if (field && p.field[s]) {
          field.dataset.serverPower = String(info.powers[s]);
          field.stackCards = (info.meta[s]?.stack || []).map(id => definition(id));
          field.dataset.onlineUid = String(info.meta[s]?.uid || '');
          const badge = element('span', `ATK ${info.powers[s]}${info.meta[s]?.protected ? ' · 战斗保护' : ''}`, 'online-power'); field.append(badge);
        }
        if (info.traps[s]) {
          slot.dataset.hasTrap = 'true';
          const c = info.traps[s].cardId;
          const trap = element('div', c ? `盖放\n${definition(c).name}` : '盖放卡', 'card online-trap');
          trap.cardData = c ? definition(c) : { name: '盖放卡', type: '盖放卡' }; slot.append(trap);
        }
      }
    }
  }
  function notice(text) {
    document.getElementById('onlineEffectNotice')?.remove();
    const box = element('div', text); box.id = 'onlineEffectNotice'; box.setAttribute('role', 'status');
    const dismiss = button('知道了', () => box.remove()); box.append(dismiss); document.body.append(box);
    setTimeout(() => box.remove(), 10000);
  }
  window.renderOnlineEffects = function (message) {
    if (!message.rules) return;
    window.onlineEffectsEnabled = true;
    const wasOpen = Boolean(overlay); const previousChoice = state?.rules.pendingChoice?.id;
    const previousLogId = state?.gameId === message.gameId ? Math.max(0, ...state.rules.effectLog.map(e => e.id)) : null;
    state = message; sending = false;
    renderBoard(message); updateToolbar();
    if (previousLogId !== null) {
      const skipped = message.rules.effectLog.filter(e => e.id > previousLogId && e.reason === 'condition_not_met');
      if (skipped.length) notice(skipped.map(e => e.text).join('\n'));
    }
    const pending = message.rules.pendingChoice;
    if (message.ended) { close(); return; }
    if (pending && !pending.waiting && pending.id !== previousChoice) showChoice();
    else if (wasOpen) pending && !pending.waiting ? showChoice() : showActions();
    if (pending || message.phase !== 'main' || !message.isYourTurn) document.getElementById('endTurnButton').disabled = true;
  };
  window.onlineEffectsError = function (message) { sending = false; updateToolbar(); showError(message.message || '操作未完成。'); };
  // Capture battle commands before the old local DOM-based handlers can mutate anything.
  document.addEventListener('click', function (event) {
    if (!window.onlineEffectsEnabled || !state || overlay?.contains(event.target) || toolbar?.contains(event.target)) return;
    const target = event.target.closest?.('#deployButton,#useButton,#setButton,#evolveButton,#attackButton,#endTurnButton,.player-zone .player-slot,.hand .card');
    if (!target) return;
    if (state.phase === 'mulligan') return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (target.id === 'endTurnButton' && state.rules.legalActions.endTurn) send('end_turn');
    else showActions();
    const handMenu = document.getElementById('cardActionMenu'); if (handMenu) handMenu.style.display = 'none';
    const attackMenu = document.getElementById('battleActionMenu'); if (attackMenu) attackMenu.style.display = 'none';
  }, true);
  const originalPower = calculateOperatorAttack;
  calculateOperatorAttack = function (operator, context) {
    const raw = operator?.cardElement?.dataset.serverPower;
    if (!window.onlineEffectsEnabled || raw === undefined) return originalPower(operator, context);
    const base = Number(operator.cardData?.attack || 0);
    let final = Number(raw);
    if (context?.isAttacker && context.attackMode === 'ranged') final += Number(operator.cardData?.rangedAttackModifier || 0);
    final = Math.max(0, final); return { base, modifier: final - base, final, details: [] };
  };
})();
