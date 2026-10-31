// Share links: one page makes a "#game=…" link of its table, another opens it and sees
// the same map, operatives, score, dice and mission, as a fresh local game (not online).
import { test, expect } from '@playwright/test';

const ops = page => page.evaluate(() => skirmishtable.world.OPS.map(o =>
  ({ id: o.id, x: o.x, y: o.y, wounds: o.wounds, alive: o.alive, order: o.order, ready: o.ready, used: o.used })));
const dice = page => page.evaluate(() => skirmishtable.diceTrays[0].dice.join(''));

test('a shared link opens the same table in another page', async ({ context }) => {
  const errors = [];
  const a = await context.newPage(), b = await context.newPage();
  for (const p of [a, b]) p.on('pageerror', e => errors.push(e.message));

  await a.goto('/');
  await a.locator('#mapbtns button[title="Gallowdark AO1"]').click();
  // play a little: move and hurt operatives, change orders, score VP, next turning point
  await a.evaluate(() => {
    const O = skirmishtable.world.OPS;
    O[0].x += 1.2345678; O[0].used.push("reposition"); O[0].order = "engage"; O[0].ready = false;
    O[7].wounds = 2; O[9].wounds = 0; O[9].alive = false;
    skirmishtable.renderAll();
  });
  await a.locator('#vpa').click();
  await a.locator('#vpa').click();
  await a.locator('#vpb').click();
  await a.locator('#endtp').click();
  await expect(a.locator('#tpv')).toHaveText('2');
  // dice in the tray, mission cards and a score on the Ops & score sheet
  await a.locator('#dicedock0 .diceicon').click();
  await a.locator('#dicemat0 [data-n="5"]').click();
  await a.locator('#dicemat0 .dmthrow').click();
  await expect.poll(() => dice(a), { timeout: 10000 }).toHaveLength(5);
  await a.locator('#opcrit').selectOption({ index: 3 });
  await a.locator('.optac[data-s="1"]').selectOption({ index: 2 });
  await a.locator('.opvp[data-s="1"][data-tp="0"][data-c="1"]').fill('3');
  await a.locator('.opvp[data-s="1"][data-tp="0"][data-c="1"]').dispatchEvent('change');

  await a.getByRole('button', { name: 'Share this game' }).click();
  const link = await a.locator('#sharelink').inputValue();
  expect(link).toMatch(/#game=1\.[A-Za-z0-9_-]+$/);
  expect(link.length).toBeLessThan(2000);
  await expect(a.locator('#sharenote')).toContainText('characters');

  await b.goto(link);
  await expect(b.locator('#log p').first()).toContainText('Opened a shared game from');
  expect(await b.evaluate(() => skirmishtable.world.MAP.name)).toBe('Gallowdark AO1');
  expect(await ops(b)).toEqual(await ops(a));
  for (const id of ['tpv', 'vpa', 'vpb', 'cpa', 'cpb'])
    await expect(b.locator('#' + id)).toHaveText(await a.locator('#' + id).textContent());
  expect(await dice(b)).toHaveLength(5);
  expect(await dice(b)).toBe(await dice(a));
  await expect(b.locator('#opcrit')).toHaveValue('2');
  await expect(b.locator('.optac[data-s="1"]')).toHaveValue('1');
  await expect(b.locator('.opvp[data-s="1"][data-tp="0"][data-c="1"]')).toHaveValue('3');
  // a local game, not online, and the address is plain again
  await expect(b.getByRole('button', { name: 'Host a game' })).toBeVisible();
  expect(new URL(b.url()).hash).toBe('');

  // the opener plays on: their own copy, the sender's table doesn't change
  const ax = await a.evaluate(() => skirmishtable.world.OPS[1].x);
  await b.evaluate(() => { skirmishtable.world.OPS[1].x += 2; skirmishtable.renderAll(); });
  expect(await a.evaluate(() => skirmishtable.world.OPS[1].x)).toBe(ax);

  // a damaged link says so and leaves the table alone
  await b.goto('/#game=1.notagame');
  await expect(b.locator('#sharenote')).toContainText("Couldn't open that shared game");
  expect(errors).toEqual([]);
});
