import { expect, test } from '@playwright/test';
import { openApp, openStudio, plannerOf, studioDialog } from './lib.js';

test('stack smoke: migrated planner, signed-in session, Studio opens', async ({ page, request }) => {
  const planner = await plannerOf(request);
  expect(planner.migrated).toBe(true);
  expect(planner.doc.allocations.LS2[0]).toBe('QA Alpha LS2');
  const session = await (await request.get('/api/session')).json();
  expect(session).toMatchObject({ email: 'qa.admin@miamibeachfl.gov', studioEnabled: true, aiEnabled: true });
  await openApp(page);
  await openStudio(page, 'LS2');
  await expect(studioDialog(page)).toBeVisible();
});
