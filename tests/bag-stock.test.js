import test from 'node:test';
import assert from 'node:assert/strict';
import { bagStockWarning } from '../public/service.js';

const bag = { roaster: 'Morning roaster', name: 'House blend', archived: false };

test('low-stock reminders start at 80 g, include the bag, and remain below the threshold', () => {
  assert.equal(bagStockWarning({ ...bag, remainingGrams: 80.1 }), '');
  for (const remainingGrams of [80, 79.9, 75, 70, 20, 0.5]) {
    const message = bagStockWarning({ ...bag, remainingGrams });
    assert.match(message, /^Running low:/);
    assert.ok(message.includes('Morning roaster · House blend'));
    assert.match(message, /get a new bag/);
  }
  assert.match(bagStockWarning({ ...bag, remainingGrams: 79.9 }), /about 79.9 g/);
  assert.match(bagStockWarning({ ...bag, remainingGrams: 0.01 }), /less than 1 g/);
});

test('empty and negative inventory prompt replacement without hiding the discrepancy in bag data', () => {
  for (const remainingGrams of [0, -0.1, -20]) {
    const empty = { ...bag, remainingGrams };
    assert.match(bagStockWarning(empty), /^Bag empty:.*replacement or check the recorded weight/);
    assert.equal(empty.remainingGrams, remainingGrams);
  }
});

test('unknown, malformed, absent, and archived bags never trigger restock reminders', () => {
  assert.equal(bagStockWarning(null), '');
  assert.equal(bagStockWarning(undefined), '');
  for (const remainingGrams of [null, undefined, NaN, Infinity, -Infinity, '75']) {
    assert.equal(bagStockWarning({ ...bag, remainingGrams }), '');
  }
  for (const remainingGrams of [80, 70, 0, -20]) {
    assert.equal(bagStockWarning({ ...bag, archived: true, remainingGrams }), '');
  }
});
