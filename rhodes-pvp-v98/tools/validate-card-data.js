const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const PUBLIC = path.join(ROOT, "public");

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8"));
}

const mainCards = readJson("cards.json");
const baseCards = readJson("base-cards.json");
const cards = [...mainCards, ...baseCards];
require('../public/starter-decks').validate(readJson('starter-decks.json'), mainCards, baseCards);
const ids = new Set();
const errors = [];

for (const card of cards) {
  for (const key of ["id", "name", "type", "level", "effect"]) {
    if (card[key] === undefined || card[key] === null || card[key] === "") {
      errors.push(`${card.id || "未知ID"} 缺少字段 ${key}`);
    }
  }

  if (ids.has(card.id)) {
    errors.push(`重复ID ${card.id}`);
  }
  ids.add(card.id);

  if (card.image) {
    const rel = String(card.image).replace(/^\/+/, "");
    if (!fs.existsSync(path.join(PUBLIC, rel))) {
      errors.push(`${card.id} 图片不存在 ${card.image}`);
    }
  }
}

if (errors.length) {
  console.error("卡牌数据检查失败：");
  errors.forEach((item) => console.error("-", item));
  process.exit(1);
}

console.log(`卡牌数据检查通过：主卡 ${mainCards.length} 张，基地卡 ${baseCards.length} 张。`);
