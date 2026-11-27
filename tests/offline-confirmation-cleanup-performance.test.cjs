const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('a burst shares one cleanup scan and newer receipts are cleaned after their retention period', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'service-worker.js'), 'utf8');
  const from = source.indexOf('const purgeConfirmedEntries ='), to = source.indexOf('const onlineMutationIds =', from);
  assert.ok(from >= 0 && to > from);
  let now = 0, reads = 0, next = 0;
  const entries = new Map(), timers = new Map();
  const context = vm.createContext({ CONFIRMED_RETENTION_MS: 2000,
    Date: class extends Date { static now() { return now; } },
    listEntries: async () => { reads++; return [...entries.values()]; },
    removeEntry: async id => entries.delete(id),
    setTimeout: (callback, delay) => { timers.set(++next, { callback, due: now + delay }); return next; } });
  vm.runInContext(source.slice(from, to) + ';globalThis.schedule=scheduleConfirmedCleanup;', context);
  for (let i = 0; i < 500; i++) {
    entries.set('first-' + i, { id: 'first-' + i, status: 'confirmed', confirmedAt: new Date(now).toISOString() });
    context.schedule();
  }
  entries.set('pending', { id: 'pending', status: 'pending' });
  entries.set('conflict', { id: 'conflict', status: 'conflict' });
  assert.equal(timers.size, 1);
  now = 1500;
  entries.set('new', { id: 'new', status: 'confirmed', confirmedAt: new Date(now).toISOString() });
  context.schedule();
  assert.equal(timers.size, 1);
  const tick = async time => {
    now = time;
    const [id, timer] = [...timers.entries()][0];
    assert.ok(timer.due <= now);
    timers.delete(id);
    await timer.callback();
  };
  await tick(2000);
  assert.equal(reads, 1);
  assert.equal(entries.size, 3);
  assert.ok(entries.has('new'));
  assert.equal(timers.size, 1, 'A younger receipt must arrange another cleanup without another sale.');
  await tick(4000);
  assert.equal(reads, 2);
  assert.equal(entries.size, 2);
  assert.ok(entries.has('pending'));
  assert.ok(entries.has('conflict'));
  assert.equal(timers.size, 0);
});
