// Online play: a host and a guest in two tabs of one browser. `?net=local` swaps the
// WebRTC transport for a BroadcastChannel, so the test needs no public relays; everything
// above the transport (hosting, joining, seats, the host's check, applying state) is real.
import { test, expect } from '@playwright/test';

const opX = (page, id) => page.evaluate(id => skirmishtable.world.OPS.find(o => o.id === id).x, id);
// what landDrag does at the end of a move: change the operative, then render
const nudge = (page, id, dx) => page.evaluate(([id, dx]) => {
  const op = skirmishtable.world.OPS.find(o => o.id === id); op.x += dx; op.used.push("reposition");
  skirmishtable.renderAll();
}, [id, dx]);

test('host and guest share one table', async ({ context }) => {
  const errors = [];
  const host = await context.newPage(), guest = await context.newPage();
  for (const p of [host, guest]) p.on('pageerror', e => errors.push(e.message));

  await host.goto('/?net=local');
  await host.getByRole('button', { name: 'Host a game' }).click();
  const link = await host.locator('#netlink').inputValue();
  expect(link).toMatch(/\?net=local#room=[A-Z0-9]{10}$/);
  await host.locator('#mapbtns button[title="Gallowdark AO1"]').click();

  await guest.goto(link);
  await expect(guest.locator('#netbox')).toContainText('you: Slate');
  await expect(host.locator('#netbox')).toContainText('Slate: ✓');
  // the guest follows the host's map
  await expect.poll(() => guest.evaluate(() => skirmishtable.world.MAP.name)).toBe('Gallowdark AO1');

  // a move on either side shows on the other
  const a1 = await opX(host, 'A1');
  await nudge(host, 'A1', 1);
  await expect.poll(() => opX(guest, 'A1')).toBeCloseTo(a1 + 1, 6);
  const b1 = await opX(guest, 'B1');
  await nudge(guest, 'B1', -1);
  await expect.poll(() => opX(host, 'B1')).toBeCloseTo(b1 - 1, 6);
  await expect(host.locator('#log p').first()).toBeVisible();

  // the guest can't move the host's operatives: the host refuses and the guest snaps back
  await nudge(guest, 'A2', 1);
  await expect(guest.locator('#log p').first()).toContainText("didn't take your last action");
  expect(await opX(guest, 'A2')).toBe(await opX(host, 'A2'));

  // End TP from the guest, then Undo from the guest (the host keeps the one undo stack)
  await guest.locator('#endtp').click();
  await expect(host.locator('#tpv')).toHaveText('2');
  await guest.locator('#undo').click();
  await expect(host.locator('#tpv')).toHaveText('1');
  await expect(guest.locator('#tpv')).toHaveText('1');

  // only the host changes the map
  await guest.locator('#mapbtns button[title="Gallowdark AO2"]').click();
  await expect(guest.locator('#hint')).toContainText('only the host');
  expect(await guest.evaluate(() => skirmishtable.world.MAP.name)).toBe('Gallowdark AO1');

  expect(errors).toEqual([]);
});

test('dice, mission cards, score and markers are shared', async ({ context }) => {
  const errors = [];
  const host = await context.newPage(), guest = await context.newPage();
  for (const p of [host, guest]) p.on('pageerror', e => errors.push(e.message));
  await host.goto('/?net=local');
  await host.getByRole('button', { name: 'Host a game' }).click();
  await guest.goto(await host.locator('#netlink').inputValue());
  await expect(guest.locator('#netbox')).toContainText('you: Slate');

  // the guest's roll shows, sorted the same, in the host's tray
  await guest.locator('#dicetray [data-n="4"]').click();
  const dice = await guest.evaluate(() => [...document.querySelectorAll('#dicetray .die')].map(d => d.textContent).join(''));
  expect(dice).toHaveLength(4);
  await expect.poll(() => host.evaluate(() => [...document.querySelectorAll('#dicetray .die')].map(d => d.textContent).join(''))).toBe(dice);
  await expect(host.locator('#dicetray .dsum')).toContainText('Slate');

  // the host sets the Crit Op; the guest can't, but picks and scores its own Tac Op
  await host.locator('#opcrit').selectOption({ index: 3 });
  await expect(guest.locator('#opcrit')).toHaveValue('2');
  await expect(guest.locator('#opcrit')).toBeDisabled();
  await expect(guest.locator('.optac[data-s="0"]')).toBeDisabled();
  await guest.locator('.optac[data-s="1"]').selectOption({ index: 2 });
  await expect(host.locator('.optac[data-s="1"]')).toHaveValue('1');
  await guest.locator('.opvp[data-s="1"][data-tp="0"][data-c="1"]').fill('2');
  await guest.locator('.opvp[data-s="1"][data-tp="0"][data-c="1"]').dispatchEvent('change');
  await expect(host.locator('#vpb')).toHaveText('2');

  // a marker placed by the guest shows on the host's table
  await guest.evaluate(() => {
    document.querySelector('#opsbox .tok').click();
    document.getElementById('view2d').click();
  });
  const box = await guest.locator('#board').boundingBox();
  await guest.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(host.locator('#opsbox summary').last()).toContainText('Markers (1)');

  expect(errors).toEqual([]);
});
