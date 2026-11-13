// Signed-out visitors (no X-Test-Actor header): the planner and published images stay readable; nothing can be changed.
import { expect, test } from '@playwright/test';
import { openApp, openCompartment } from './lib.js';

test('signed-out is read-only: no Studio, no editing, mutations refused with 401', async ({ page, request }) => {
  const session = await (await request.get('/api/session')).json();
  expect(session.email ?? null).toBeNull();
  await openApp(page);
  await openCompartment(page, 'LS2');
  await expect(page.getByRole('button', { name: 'AI Compartment Studio' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Bulk Add to Compartment/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Add photos|Generate rendering/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Sign in to add photos/ })).toBeVisible();
  const slot = page.getByRole('combobox', { name: 'Equipment for slot 1', exact: true });
  if (await slot.count()) await expect(slot).toBeDisabled();
  await expect(page.getByText('QA Alpha LS2').first()).toBeVisible(); // planner content is readable

  const planner = await (await request.get('/api/public/planner')).json();
  expect(planner.migrated).toBe(true);
  expect((await request.get('/api/public/main-images')).ok()).toBeTruthy();
  for (const [method, path] of [['post', '/api/planner/ops'], ['post', '/api/assets'], ['post', '/api/compartments/LS2/jobs'], ['post', '/api/compartments/LS2/main-image'], ['post', '/api/compartments/LS2/mounts'], ['put', '/api/compartments/LS2/design'], ['get', '/api/compartments/LS2/assets'], ['get', '/api/admin/settings'], ['get', '/api/usage']]) {
    const r = await request[method](path, method === 'get' ? {} : { data: {} });
    expect(r.status(), `${method} ${path}`).toBe(401);
  }
  expect((await request.post('/api/processor/claim')).status()).toBe(401);
});
