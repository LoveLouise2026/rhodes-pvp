(function () {
  'use strict';
  const effects = [];
  const activeCards = new Map();
  const revisions = new Map();
  let turnSequence = 0;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  function shouldEnterBattle() {
    try {
      const user = sessionStorage.getItem('rhodesLoggedUserV68');
      if (!user) return false;
      const pending = JSON.parse(sessionStorage.getItem('rhodesPendingBattleV77') || 'null');
      if (pending && pending.username === user && pending.createdAt <= Date.now() &&
          Date.now() - pending.createdAt < 600000 && pending.battleNonce &&
          pending.battleNonce !== sessionStorage.getItem('rhodesLastBattleNonceV78')) return true;
      const opening = JSON.parse(sessionStorage.getItem('rhodesServerOpeningV91') || 'null');
      return Boolean(opening?.gameId && opening.self?.id && opening.self?.reconnectToken);
    } catch { return false; }
  }

  function statusElement() {
    let status = document.getElementById('battleEffectStatus');
    if (!status) {
      status = document.createElement('div');
      status.id = 'battleEffectStatus';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      document.body.append(status);
    }
    return status;
  }

  function updateStatus() {
    const status = statusElement();
    status.textContent = effects.at(-1)?.text || '';
    status.hidden = effects.length === 0;
  }

  function beginEffect(card, label, source) {
    const item = { text: card ? `【${card.name}】${label}` : label };
    effects.push(item);
    if (source?.classList) {
      activeCards.set(source, (activeCards.get(source) || 0) + 1);
      source.classList.add('battle-effect-active');
    }
    updateStatus();
    let finished = false;
    return function finish() {
      if (finished) return;
      finished = true;
      effects.splice(effects.indexOf(item), 1);
      if (source?.classList) {
        const remaining = activeCards.get(source) - 1;
        if (remaining) activeCards.set(source, remaining);
        else { activeCards.delete(source); source.classList.remove('battle-effect-active'); }
      }
      updateStatus();
    };
  }

  async function turn(side, round) {
    const sequence = ++turnSequence;
    document.getElementById('battleTurnBanner')?.remove();
    const banner = document.createElement('div');
    banner.id = 'battleTurnBanner';
    banner.setAttribute('role', 'status');
    banner.textContent = `${side === 'player' ? '你的回合' : '对方回合'} · 第 ${round} 回合`;
    document.body.append(banner);
    try { await wait(950); }
    finally { if (sequence === turnSequence) banner.remove(); }
  }

  function definition(id) {
    const data = window.rhodesCardDataV87;
    return [...(data?.mainCards || []), ...(data?.baseCards || [])].find(card => card.id === id);
  }

  async function showConfirmedEffect(entry, message) {
    const card = definition(entry.cardId);
    const side = entry.by === message.self.id ? 'player' : 'enemy';
    let source = null;
    if (Number.isInteger(entry.sourceSlot)) {
      const slot = window.rhodesPvpV94?.slotFor(side, entry.sourceSlot);
      source = slot?.querySelector('.card') || slot;
    } else if (card?.type === '基地卡') {
      source = document.querySelector(side === 'player' ? '#playerBaseArea' : '.enemy-area .base');
    }
    const finish = beginEffect(card, entry.feedback === 'use_tactic' ? '使用战术' : '效果处理中', source);
    const preview = document.createElement('div');
    preview.className = 'battle-effect-preview';
    preview.textContent = card ? `【${card.name}】\n${entry.feedback === 'use_tactic' ? '使用战术' : '发动效果'}` : entry.text;
    if (card && typeof applyCardImageV88 === 'function') applyCardImageV88(preview, card);
    document.body.append(preview);
    try { await wait(500); }
    finally { preview.remove(); finish(); }
  }

  async function transition(message, previous) {
    if (!previous || previous.gameId !== message.gameId) return;
    const applied = revisions.get(message.gameId) ?? previous.revision;
    if (message.revision <= applied) return;
    revisions.set(message.gameId, message.revision);
    if (previous.currentPlayerId !== message.currentPlayerId && !message.ended) {
      await turn(message.isYourTurn ? 'player' : 'enemy', message.round);
    }
    const cursor = Math.max(0, ...(previous.rules?.effectLog || []).map(entry => entry.id));
    const shown = new Set();
    for (const entry of message.rules?.effectLog || []) {
      const key = `${entry.by}:${entry.cardId}`;
      if (entry.id > cursor && entry.feedback && !shown.has(key)) {
        shown.add(key);
        await showConfirmedEffect(entry, message);
      }
    }
  }

  window.battleFeedback = { shouldEnterBattle, beginEffect, turn, transition };
  if (shouldEnterBattle()) document.documentElement.setAttribute('data-battle-boot', '');
})();
