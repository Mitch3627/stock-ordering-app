// Every page script must at least parse: one bad character stops a whole page (and its tables) from loading.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('every script in public/ parses', () => {
  const dir = path.join(__dirname, '..', 'public');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: f }), f);
  }
});
