// (i) budget and concurrency caps hold under parallel createJob calls (atomic ledger reservation in one D1 batch).
import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, createStack, device, migrateUntilDone, one } from './harness.js';

describe('budget and concurrency caps under parallel createJob', () => {
  let stack; let admin; let est;
  const users = n => Array.from({ length: n }, (_, i) => device(stack, `user:person${i}@example.com`));
  const create = (dev, key, body = { kind: 'render', mode: 'plan', preset: 'preview' }) => dev.call('POST', '/api/compartments/LS1/jobs', { json: body, headers: { 'Idempotency-Key': key } });
  const setting = async (key, value) => {
    const cur = (await admin.get('/api/admin/settings')).body.settings[key].revision;
    const r = await admin.put(`/api/admin/settings/${key}`, { value, expectRevision: cur });
    expect(r.status).toBe(200);
  };
  const reset = () => { stack.sql.exec('DELETE FROM spend_ledger; DELETE FROM generation_jobs;'); };
  const counts = () => ({
    jobs: one(stack, 'SELECT COUNT(*) n FROM generation_jobs').n,
    ledger: one(stack, 'SELECT COUNT(*) n FROM spend_ledger').n,
    reserved: one(stack, "SELECT COALESCE(SUM(estimated_usd), 0) s FROM spend_ledger WHERE state = 'reserved'").s,
  });
  const codes = replies => replies.map(r => r.body?.error?.code ?? r.status).sort((a, b) => String(a).localeCompare(String(b)) * -1); // errors first, then 202s

  beforeAll(async () => {
    stack = createStack();
    admin = device(stack, ADMIN);
    await migrateUntilDone(admin);
    await setting('ai.enabled', true);
    est = (await admin.post('/api/compartments/LS1/estimate', { kind: 'render', mode: 'plan', preset: 'preview' })).body.estimate.usd;
    expect(est).toBeGreaterThan(0);
  });

  it('the daily cap admits exactly floor(cap / estimate) parallel requests; the rest get 402 BUDGET_EXCEEDED', async () => {
    reset();
    await setting('jobs.maxConcurrent', 10); await setting('jobs.userMaxConcurrent', 10);
    await setting('budget.userDailyUsd', 1000); await setting('budget.monthlyUsd', 1000);
    await setting('budget.dailyUsd', Math.round(est * 2.5 * 100) / 100); // room for exactly two
    const people = users(6);
    const replies = await Promise.all(people.map((p, i) => create(p, `parallel-day-${i}-key`)));
    expect(codes(replies)).toEqual(['BUDGET_EXCEEDED', 'BUDGET_EXCEEDED', 'BUDGET_EXCEEDED', 'BUDGET_EXCEEDED', 202, 202]);
    expect(replies.filter(r => r.status === 402)[0].body.error.details).toMatchObject({ scope: 'day', estimateUsd: est });
    const c = counts();
    expect(c).toMatchObject({ jobs: 2, ledger: 2 });
    expect(c.reserved).toBeCloseTo(est * 2, 8);
    expect(c.reserved).toBeLessThanOrEqual(est * 2.5 + 1e-9);
    const usage = (await admin.get('/api/usage')).body;
    expect(usage.today.reserved).toBeCloseTo(est * 2, 8);
  });

  it('the monthly cap holds even when the daily cap would allow more', async () => {
    reset();
    await setting('budget.dailyUsd', 1000);
    await setting('budget.monthlyUsd', Math.round(est * 1.5 * 100) / 100);
    const replies = await Promise.all(users(4).map((p, i) => create(p, `parallel-month-${i}-key`)));
    expect(codes(replies)).toEqual(['BUDGET_EXCEEDED', 'BUDGET_EXCEEDED', 'BUDGET_EXCEEDED', 202]);
    expect(replies.find(r => r.status === 402).body.error.details.scope).toBe('month');
    expect(counts().jobs).toBe(1);
  });

  it('the per-user daily cap applies per person', async () => {
    reset();
    await setting('budget.monthlyUsd', 1000);
    await setting('budget.userDailyUsd', Math.round(est * 1.5 * 100) / 100);
    const [a, b] = users(2);
    const replies = await Promise.all([0, 1, 2].map(i => create(a, `parallel-user-a-${i}`)));
    expect(codes(replies)).toEqual(['BUDGET_EXCEEDED', 'BUDGET_EXCEEDED', 202]);
    expect(replies.find(r => r.status === 402).body.error.details.scope).toBe('user');
    expect((await create(b, 'parallel-user-b-0')).status).toBe(202); // someone else still has budget
    expect(counts().jobs).toBe(2);
  });

  it('global and per-user concurrency caps hold: 429 CONCURRENCY_LIMIT', async () => {
    reset();
    await setting('budget.userDailyUsd', 1000);
    await setting('jobs.maxConcurrent', 2); await setting('jobs.userMaxConcurrent', 1);
    const people = users(5);
    const replies = await Promise.all(people.map((p, i) => create(p, `parallel-conc-${i}-key`)));
    expect(codes(replies)).toEqual(['CONCURRENCY_LIMIT', 'CONCURRENCY_LIMIT', 'CONCURRENCY_LIMIT', 202, 202]);
    expect(replies.find(r => r.status === 429).body.error.details.scope).toBe('global');
    expect(counts().jobs).toBe(2);

    reset();
    await setting('jobs.maxConcurrent', 10);
    const solo = users(1)[0];
    const same = await Promise.all([0, 1, 2, 3].map(i => create(solo, `parallel-solo-${i}-key`)));
    expect(codes(same)).toEqual(['CONCURRENCY_LIMIT', 'CONCURRENCY_LIMIT', 'CONCURRENCY_LIMIT', 202]);
    expect(same.find(r => r.status === 429).body.error.details.scope).toBe('user');
    expect(counts().jobs).toBe(1);
  });

  it('parallel retries with the SAME Idempotency-Key create one job and one reservation', async () => {
    reset();
    await setting('jobs.userMaxConcurrent', 10);
    const solo = users(1)[0];
    const replies = await Promise.all([0, 1, 2, 3, 4].map(() => create(solo, 'same-key-everywhere')));
    expect(replies.map(r => r.status)).toEqual([202, 202, 202, 202, 202]);
    expect(new Set(replies.map(r => r.body.job.id)).size).toBe(1);
    expect(counts()).toMatchObject({ jobs: 1, ledger: 1 });
    expect((await create(solo, 'same-key-everywhere', { kind: 'render', mode: 'plan', preset: 'preview', instructions: 'different' })).status).toBe(202); // replay returns the original
  });
});
