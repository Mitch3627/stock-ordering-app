const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { asManager } = require('./helpers');
const http = require('node:http');
const { getDb } = require('../db/connection');
const { createItemsRouter } = require('../routes/items');
const { applyEvent } = require('../ledger/ledger');

function startServer() {
  const db = getDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use(asManager);
  app.use('/api/items', createItemsRouter(db));
  const server = app.listen(0);
  const port = server.address().port;
  return { db, server, base: `http://127.0.0.1:${port}` };
}

test('POST /api/items creates an item, GET lists it', async () => {
  const { server, base, db } = startServer();
  const res = await fetch(`${base}/api/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Fries', category: 'Freezer', unit_label: 'Box', items_per_order_unit: 1 }),
  });
  assert.strictEqual(res.status, 201);
  const created = await res.json();
  assert.strictEqual(created.name, 'Fries');

  const listRes = await fetch(`${base}/api/items`);
  const list = await listRes.json();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'Fries');

  server.close();
  db.close();
});

test('PUT /api/items/:id updates fields', async () => {
  const { server, base, db } = startServer();
  const created = await (await fetch(`${base}/api/items`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Fries', category: 'Freezer', unit_label: 'Box', items_per_order_unit: 1 }),
  })).json();

  const res = await fetch(`${base}/api/items/${created.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ buffer_value: 6, max_boxes: 12 }),
  });
  assert.strictEqual(res.status, 200);
  const updated = await res.json();
  assert.strictEqual(updated.buffer_value, 6);
  assert.strictEqual(updated.max_boxes, 12);

  server.close();
  db.close();
});

test('GET /api/items/export.csv includes a header row and the item', async () => {
  const { server, base, db } = startServer();
  await fetch(`${base}/api/items`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Fries', category: 'Freezer', unit_label: 'Box', items_per_order_unit: 1 }),
  });
  const res = await fetch(`${base}/api/items/export.csv`);
  const text = await res.text();
  assert.match(text.split('\n')[0], /name,category,unit_label/);
  assert.match(text, /Fries/);

  server.close();
  db.close();
});

test('GET /api/items includes current on_hand_qty from the ledger, defaulting to 0', async () => {
  const { server, base, db } = startServer();
  const created = await (await fetch(`${base}/api/items`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Fries', category: 'Freezer', unit_label: 'Box', items_per_order_unit: 1 }),
  })).json();
  const untouched = await (await fetch(`${base}/api/items`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bacon', category: 'Chiller', unit_label: 'Box', items_per_order_unit: 1 }),
  })).json();

  applyEvent(db, { itemId: created.id, type: 'delivery', qtyDelta: 12, occurredAt: '2026-09-18' });

  const list = await (await fetch(`${base}/api/items`)).json();
  const fries = list.find(i => i.id === created.id);
  const bacon = list.find(i => i.id === untouched.id);
  assert.strictEqual(fries.on_hand_qty, 12);
  assert.strictEqual(bacon.on_hand_qty, 0);

  server.close();
  db.close();
});

test('POST /api/items/import upserts by name', async () => {
  const { server, base, db } = startServer();
  const csv = 'name,category,unit_label,items_per_order_unit,usage_per_100_sales,buffer_value,max_boxes,case_multiple,price_per_unit,shelf_life_days\n' +
              'Fries,Freezer,Box,1,0.5,6,20,,21.5,\n';
  const res = await fetch(`${base}/api/items/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csv }),
  });
  assert.strictEqual(res.status, 200);

  const list = await (await fetch(`${base}/api/items`)).json();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].buffer_value, 6);
  assert.strictEqual(list[0].price_per_unit, 21.5);

  server.close();
  db.close();
});
