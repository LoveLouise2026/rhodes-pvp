const assert = require('node:assert/strict');
const api = require('../public/starter-decks');
const templates = require('../data/starter-decks.json');
const main = require('../data/cards.json'), base = require('../data/base-cards.json');
api.validate(templates, main, base);
const collection = { activeDeckId: 'custom', decks: [{ id: 'custom', name: '自定义卡组', main: [], base: [] }] };
api.ensure(collection, templates, main, base);
assert.equal(collection.decks.length, 3);
assert.equal(collection.activeDeckId, 'custom');
for (const t of templates) {
  const d = collection.decks.find(x => x.starterId === t.id);
  assert.equal(d.main.length, 50); assert.equal(d.base.length, 3);
  assert(d.main.every(key => key.startsWith(t.id + '-')));
  assert.equal(new Set(d.base).size, 3);
}
const serialized = JSON.stringify(collection);
api.ensure(collection, templates, main, base);
assert.equal(JSON.stringify(collection), serialized);
// Reload from persistence, preserve edits, active deck and separate arrays.
const saved = JSON.parse(serialized);
saved.activeDeckId = saved.decks[2].id;
saved.decks[1].main.pop();
api.ensure(saved, templates, main, base);
assert.equal(saved.decks[1].main.length, 49);
assert.equal(saved.decks[2].main.length, 50);
assert.equal(collection.decks[1].main.length, 50);
assert.equal(saved.activeDeckId, saved.decks[2].id);
assert.equal(saved.decks.length, 4);
assert.equal(saved.decks.find(d=>d.starterId==='SD01').main.length,50);
assert(!saved.decks[1].starterId);
const afterEdit=JSON.stringify(saved);api.ensure(saved,templates,main,base);assert.equal(JSON.stringify(saved),afterEdit);
const legacy = { decks: [{ id: 'old', name: '罗德岛测试卡组', main: collection.decks[1].main.slice(), base: collection.decks[1].base.slice() }], activeDeckId: 'old' };
api.ensure(legacy, templates, main, base);
assert.equal(legacy.decks.length, 2); assert.equal(legacy.activeDeckId, 'old');
assert.equal(legacy.decks[0].name, templates[0].name);
assert.throws(() => api.validate([{ ...templates[0], main: { 'SD01-0001': 50 } }], main, base));
console.log('Starter deck checks passed: both 50+3, migration, idempotency, edits and selection preserved');
