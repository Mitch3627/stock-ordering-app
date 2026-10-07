const test = require('node:test');
const assert = require('node:assert');
const { todayLocal } = require('../lib/dates');

test('todayLocal is the UK date, not the UTC one', () => {
  assert.strictEqual(todayLocal(new Date('2026-09-23T23:30:00Z')), '2026-09-24'); // 00:30 BST
  assert.strictEqual(todayLocal(new Date('2026-09-23T22:59:00Z')), '2026-09-23'); // 23:59 BST
  assert.strictEqual(todayLocal(new Date('2026-12-01T23:30:00Z')), '2026-12-01'); // GMT in winter
});
