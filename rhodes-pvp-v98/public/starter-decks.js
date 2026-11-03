(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RhodesStarterDecks = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  function key(card) {
    return [card.id || '', card.name || '', card.type || '', card.level ?? '', card.operatorType || '', card.tacticType || ''].join('|');
  }
  function expand(template) {
    return Object.entries(template.main).flatMap(([id, count]) => Array(count).fill(id));
  }
  function validate(templates, mainCards, baseCards) {
    const ids = new Set(), main = new Map(mainCards.map(c => [c.id, c])), base = new Map(baseCards.map(c => [c.id, c]));
    if (!Array.isArray(templates) || templates.length === 0) throw new Error('Missing starter decks');
    for (const t of templates) {
      if (!t.id || !t.name || ids.has(t.id)) throw new Error('Invalid/duplicate starter ID');
      ids.add(t.id);
      for (const [id, count] of Object.entries(t.main || {})) {
        if (!main.has(id) || !Number.isInteger(count) || count < 1 || count > 4) throw new Error('Invalid starter card: ' + id);
      }
      if (expand(t).length !== 50 || !Array.isArray(t.base) || t.base.length !== 3) throw new Error('Starter must contain 50+3 cards: ' + t.id);
      if (t.base.map(id => base.get(id)?.level).sort().join(',') !== '1,2,3') throw new Error('Invalid starter bases: ' + t.id);
    }
  }
  function sameCards(a, b) {
    return Array.isArray(a) && a.length === b.length && a.slice().sort().join('\n') === b.slice().sort().join('\n');
  }
  function ensure(collection, templates, mainCards, baseCards) {
    validate(templates, mainCards, baseCards);
    const mainMap = new Map(mainCards.map(c => [c.id, key(c)]));
    const baseMap = new Map(baseCards.map(c => [c.id, key(c)]));
    for (const t of templates) {
      const main = expand(t).map(id => mainMap.get(id));
      const base = t.base.map(id => baseMap.get(id));
      if (collection.decks.some(d => d.starterId === t.id && sameCards(d.main, main) && sameCards(d.base, base))) continue;
      // Keep player edits as a custom deck and restore the original preset alongside it.
      for (const d of collection.decks.filter(d => d.starterId === t.id)) {
        delete d.starterId;
        if (d.name === t.name) d.name += '（自定义）';
      }
      // Upgrade an unmodified legacy default without replacing saved edits or selection.
      const legacy = collection.decks.find(d => sameCards(d.main, main) && sameCards(d.base, base));
      if (legacy) {
        legacy.starterId = t.id;
        if (legacy.name === '罗德岛测试卡组' && t.id === 'SD01') legacy.name = t.name;
        continue;
      }
      const now = new Date().toISOString();
      collection.decks.push({ id: 'starter_' + t.id + '_' + Math.random().toString(36).slice(2, 10), starterId: t.id, name: t.name, main, base, createdAt: now, updatedAt: now });
    }
    return collection;
  }
  return { key, expand, validate, ensure };
});
