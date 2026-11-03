const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../public/card-game.html'), 'utf8');
new vm.Script(fs.readFileSync(path.join(__dirname, '../public/starter-decks.js'), 'utf8'));
new vm.Script(fs.readFileSync(path.join(__dirname, '../public/online-effects.js'), 'utf8'));
new vm.Script(fs.readFileSync(path.join(__dirname, 'card-manager/app.js'), 'utf8'));
let count = 0;
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
  if (!match[1].trim()) continue;
  new vm.Script(match[1], { filename: `client-script-${++count}.js` });
}
console.log(`Client syntax passed: ${count} inline scripts`);
