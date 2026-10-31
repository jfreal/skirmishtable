// Replays: every action is recorded; one page shares the replay as a "#replay=…" link,
// another opens it at a step, steps through it turn by turn, can't change it, and leaves.
import { test, expect } from '@playwright/test';

const pos = page => page.evaluate(() => skirmishtable.world.OPS.map(o => [o.id, o.x, o.y, o.wounds]));

test('a recorded game replays step by step from a link', async ({ context }) => {
  const errors = [];
  const a = await context.newPage(), b = await context.newPage();
  for (const p of [a, b]) p.on('pageerror', e => errors.push(e.message));

  await a.goto('/');
  await expect(a.locator('#replaybox')).toContainText('Every action is recorded');
  // three moves, End TP, a wound, End TP, then Undo takes the last End TP back off
  const frames = [await pos(a)];
  for (let i = 0; i < 3; i++) {
    await a.evaluate(i => { const o = skirmishtable.world.OPS[i]; o.x += 1.25; o.used.push("reposition"); o.ready = false; skirmishtable.renderAll(); }, i);
    await expect(a.locator('#replaybox')).toContainText(`This game: ${i + 1} step`);
    frames.push(await pos(a));
  }
  await a.locator('#endtp').click();
  await expect(a.locator('#replaybox')).toContainText('This game: 4 steps');
  await a.evaluate(() => { skirmishtable.world.OPS[4].wounds = 1; skirmishtable.renderAll(); });
  await expect(a.locator('#replaybox')).toContainText('This game: 5 steps');
  await a.locator('#endtp').click();
  await expect(a.locator('#replaybox')).toContainText('This game: 6 steps');
  await a.locator('#undo').click();
  await expect(a.locator('#replaybox')).toContainText('This game: 5 steps');

  await a.getByRole('button', { name: 'Share replay' }).first().click();
  const link = await a.locator('#replaylink').inputValue();
  expect(link).toMatch(/#replay=1\.[A-Za-z0-9_-]+$/);
  await expect(a.locator('#replaynote')).toContainText('characters');

  // opened at step 2: the table is as it was after the second move, and look-only
  await b.goto(link + '&step=2');
  await expect(b.locator('#replaybar')).toBeVisible();
  await expect(b.locator('#rpwhere')).toHaveText('TP 1 · step 2 of 5');
  expect(await pos(b)).toEqual(frames[2]);
  await b.locator('#endtp').click();
  await expect(b.locator('#tpv')).toHaveText('1');
  await expect(b.locator('#hint')).toContainText('watching a replay');

  // turn by turn: jump to TP 2, the End TP's log line shows; the arrow keys step
  await b.locator('#rptps button', { hasText: 'TP 2' }).click();
  await expect(b.locator('#rpwhere')).toHaveText('TP 2 · step 4 of 5');
  await expect(b.locator('#rplog')).toContainText('Turning point 2');
  await expect(b.locator('#tpv')).toHaveText('2');
  expect(new URL(b.url()).hash).toMatch(/&step=4$/);
  await b.locator('body').press('ArrowRight');
  await expect(b.locator('#rpwhere')).toHaveText('TP 2 · step 5 of 5');
  expect(await b.evaluate(() => skirmishtable.world.OPS[4].wounds)).toBe(1);
  await b.locator('#rpfirst').click();
  expect(await pos(b)).toEqual(frames[0]);

  // leave: the bar goes, the address is plain and the table is yours again
  await b.getByRole('button', { name: 'Leave replay' }).click();
  await expect(b.locator('#replaybar')).toBeHidden();
  expect(new URL(b.url()).hash).toBe('');
  await b.locator('#endtp').click();
  await expect(b.locator('#tpv')).toHaveText('2');

  // a damaged link says so
  await b.goto('/#replay=1.notareplay');
  await expect(b.locator('#replaynote')).toContainText("Couldn't open that replay");
  expect(errors).toEqual([]);
});
