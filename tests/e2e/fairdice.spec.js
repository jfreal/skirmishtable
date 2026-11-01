// Fair dice online: host and guest in two tabs (`?net=local`, see online.spec.js). Every
// roll is a shared commit-reveal roll; each browser checks the other's dice and wounds.
import { test, expect } from '@playwright/test';

const tray = (p, s) => p.evaluate(s => skirmishtable.diceTrays[s].dice.join(''), s);
const wounds = (p, id) => p.evaluate(id => skirmishtable.world.OPS.find(o => o.id === id).wounds, id);
const log = p => p.locator('#log');

async function table(context) {
  const errors = [];
  const host = await context.newPage(), guest = await context.newPage();
  for (const p of [host, guest]) p.on('pageerror', e => errors.push(e.message));
  await host.goto('/?net=local');
  await host.getByRole('button', { name: 'Host a game' }).click();
  await guest.goto(await host.locator('#netlink').inputValue());
  await expect(guest.locator('#netbox')).toContainText('you: Slate');
  await expect(host.locator('#netfair')).toContainText('Fair dice');
  await expect(guest.locator('#netfair')).toContainText('Fair dice');
  return { host, guest, errors };
}
async function throwDice(p, side, n) {
  await p.locator(`#dicedock${side} .diceicon`).click();
  await p.locator(`#dicemat${side} [data-n="${n}"]`).click();
  await p.locator(`#dicemat${side} .dmthrow`).click();
  await expect.poll(() => tray(p, side), { timeout: 10000 }).toHaveLength(n);
}

test('dice box rolls are shared rolls, checked by the other browser', async ({ context }) => {
  const { host, guest, errors } = await table(context);

  await throwDice(guest, 1, 4);
  const g = await tray(guest, 1);
  await expect.poll(() => tray(host, 1)).toBe(g);
  await expect(log(host)).toContainText('fair roll #1');
  await expect(host.locator('#netfair')).toContainText('1 checked');

  await throwDice(host, 0, 3);
  await expect.poll(() => tray(guest, 0)).toBe(await tray(host, 0));
  // the guest checked the host's echo of its own roll, then the host's roll
  await expect(guest.locator('#netfair')).toContainText('2 checked');

  for (const p of [host, guest]) await expect(log(p)).not.toContainText('⚠');
  expect(errors).toEqual([]);
});

test("a guest's shot: both browsers agree on the dice and the damage", async ({ context }) => {
  const { host, guest, errors } = await table(context);
  // A1 and B1 face each other 1.5" apart (clear shot, out of control range), both on Engage
  await host.evaluate(() => {
    const a = skirmishtable.world.OPS.find(o => o.id === 'A1');
    a.order = 'engage'; skirmishtable.renderAll();
  });
  const at = await host.evaluate(() => { const a = skirmishtable.world.OPS.find(o => o.id === 'A1'); return [a.x, a.y]; });
  await expect.poll(() => guest.evaluate(() => skirmishtable.world.OPS.find(o => o.id === 'A1').order)).toBe('engage');
  await guest.evaluate(([x, y]) => {
    const b = skirmishtable.world.OPS.find(o => o.id === 'B1');
    b.x = x + 2.6; b.y = y; b.order = 'engage'; skirmishtable.renderAll();
  }, at);
  await expect.poll(() => host.evaluate(() => skirmishtable.world.OPS.find(o => o.id === 'B1').order)).toBe('engage');

  const before = await wounds(host, 'A1');
  await guest.evaluate(() => {
    const S = skirmishtable.state, O = skirmishtable.world.OPS;
    S.sel = O.find(o => o.id === 'B1'); S.target = O.find(o => o.id === 'A1');
    S.sel.weapon = S.sel.weapons.find(k => /Fire|firearm|gun|rifle/i.test(k)) || S.sel.weapon;
    skirmishtable.renderAll();
  });
  await expect(guest.locator('#shootbtn')).toBeEnabled();
  await guest.locator('#shootbtn').click();
  await expect(log(guest)).toContainText('fair roll #1');
  await expect(log(host)).toContainText('fair roll #1');
  // the same dice in both browsers, and the same wounds
  await expect.poll(() => tray(host, 1)).toBe(await tray(guest, 1));
  await expect.poll(() => tray(host, 0)).toBe(await tray(guest, 0));
  expect(await wounds(host, 'A1')).toBe(await wounds(guest, 'A1'));
  expect(await wounds(host, 'A1')).toBeLessThanOrEqual(before);
  await expect(host.locator('#netfair')).toContainText('1 checked');

  // a shared roll can't be undone
  await guest.locator('#undo').click();
  await expect(guest.locator('#hint')).toContainText("can't be taken back");

  for (const p of [host, guest]) await expect(log(p)).not.toContainText('⚠');
  expect(errors).toEqual([]);
});

test('dice changed by hand are refused (guest) or flagged (host)', async ({ context }) => {
  const { host, guest, errors } = await table(context);
  await throwDice(guest, 1, 4);
  await expect.poll(() => tray(host, 1)).toBe(await tray(guest, 1));

  // a guest that writes 6s into its tray: the host refuses the update
  const real = await tray(host, 1);
  await guest.evaluate(() => { skirmishtable.diceTrays[1].dice = [6, 6, 6, 6]; skirmishtable.renderAll(); });
  await expect(log(guest)).toContainText("Slate's dice changed without a shared roll");
  expect(await tray(host, 1)).toBe(real);
  await expect.poll(() => tray(guest, 1)).toBe(real);

  // a host that does the same: the guest can't refuse, but says so
  await host.evaluate(() => { skirmishtable.diceTrays[0].dice = [6, 6, 6]; skirmishtable.renderAll(); });
  await expect(log(guest)).toContainText("⚠ the host's last update doesn't add up: Ash's dice changed without a shared roll");
  expect(errors).toEqual([]);
});
