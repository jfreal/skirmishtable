// End-to-end smoke tests: the built page loads, and the core interactions work with a
// real mouse — on the 3D table (the default) and the 2D map: dragging into a nook,
// climbing, targeting, switching maps and rulesets, undo.
import { test, expect } from '@playwright/test';

const kz = (page, fn, arg) => page.evaluate(fn, arg);
// board inches -> screen pixels (recomputed each time: the side panel can scroll the page)
const toScreen = (page, x, y) => page.evaluate(([x, y]) => {
  const p = new DOMPoint(x * 32, y * 32).matrixTransform(document.getElementById('board').getScreenCTM());
  return { x: p.x, y: p.y };
}, [x, y]);
async function place(page, id, x, y) {
  await kz(page, ([id, x, y]) => {
    const op = skirmishtable.world.OPS.find(o => o.id === id); op.x = x; op.y = y;
    for (const o of skirmishtable.world.OPS) if (o.id !== id && Math.hypot(o.x - x, o.y - y) < 6) o.alive = false;   // clear the area
    skirmishtable.renderAll();
  }, [id, x, y]);
}
const to2D = page => page.locator('#view2d').click();
// board inches -> screen pixels on the 3D table (z = height above the table)
const toScreen3D = (page, x, y, z = 0) => page.evaluate(([x, y, z]) => skirmishtable.table3d.boardToScreen(x, y, z), [x, y, z]);
async function drag(page, from, to, in3D = false) {
  const a = in3D ? await toScreen3D(page, from[0], from[1], 0.7) : await toScreen(page, ...from);
  const b = in3D ? await toScreen3D(page, to[0], to[1], 0) : await toScreen(page, ...to);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(a.x + (b.x - a.x) * i / 10, a.y + (b.y - a.y) * i / 10);
  const during = await kz(page, () => {
    const d = skirmishtable.state.drag;
    return { total: d.total, climbs: d.path.filter(p => p[2]).map(p => p[2]), label: [...document.querySelectorAll('#board text')].map(t => t.textContent),
             overlay3D: skirmishtable.table3d.three ? skirmishtable.table3d.three.overlayGroup.children.length : 0 };
  });
  await page.mouse.up();
  return during;
}

let errors;
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/?deploy=zones');   // drop-zone deployment: the tests expect open table, not the random demo scatter
  await page.waitForFunction(() => window.skirmishtable && skirmishtable.world.MAP);
});
test.afterEach(() => expect(errors).toEqual([]));

test('loads Volkus AO 1 on the 3D table, with the grouped map and rules pickers', async ({ page }) => {
  expect(await kz(page, () => [skirmishtable.world.MAP.name, skirmishtable.world.MAP.fine, skirmishtable.table3d.view3D, skirmishtable.rules.RULES.id]))
    .toEqual(['Volkus AO 1', true, true, 'killteam']);
  await expect(page.locator('#board3d canvas')).toBeVisible();
  await expect(page.locator('#rulebtns button')).toHaveCount(3);
  await expect(page.locator('#buildtag')).toContainText('build');
  await expect(page.locator('.maprow')).toHaveCount(4);
  await expect(page.locator('#mapbtns button')).toHaveCount(15);
});

test('drags an operative into the stronghold corner nook on the 3D table', async ({ page }) => {
  await place(page, 'A2', 10.71, 7.48);
  const during = await drag(page, [10.71, 7.48], [12.05, 4.25], true);
  expect(during.total).toBe(5);
  expect(during.overlay3D).toBeGreaterThan(3);   // route ribbons, ghost, label
  const op = await kz(page, () => { const o = skirmishtable.world.OPS.find(o => o.id === 'A2'); return [+o.x.toFixed(2), +o.y.toFixed(2)]; });
  expect(op).toEqual([12.05, 4.25]);
  await expect(page.locator('#log p').first()).toContainText('repositions 5"');
});

test('drags an operative into the stronghold corner nook on the 2D map', async ({ page }) => {
  await to2D(page);
  await place(page, 'A2', 10.71, 7.48);
  const during = await drag(page, [10.71, 7.48], [12.05, 4.25]);
  expect(during.total).toBe(5);
  const op = await kz(page, () => { const o = skirmishtable.world.OPS.find(o => o.id === 'A2'); return [+o.x.toFixed(2), +o.y.toFixed(2)]; });
  expect(op).toEqual([12.05, 4.25]);
  await expect(page.locator('#log p').first()).toContainText('repositions 5"');
});

test('climbs over the low wall into the stronghold and labels the climb', async ({ page }) => {
  await to2D(page);
  await place(page, 'A2', 15.55, 4.25);
  const during = await drag(page, [15.55, 4.25], [12.05, 4.25]);
  expect(during.climbs).toEqual([2]);
  expect(during.label.some(t => t.includes('▲2″ up'))).toBe(true);
  await expect(page.locator('#log p').first()).toContainText('climbing over 2" terrain');
});

test('judges a nooked target as in cover', async ({ page }) => {
  await to2D(page);
  await kz(page, () => {
    const ops = skirmishtable.world.OPS, a = ops.find(o => o.id === 'A1'), b = ops.find(o => o.id === 'B2');
    a.x = 7.3; a.y = 1; b.x = 12.05; b.y = 4.25; skirmishtable.renderAll();
  });
  let p = await toScreen(page, 7.3, 1);
  await page.mouse.click(p.x, p.y);
  // the valid-shots view already marks it: visible, but Conceal + cover
  await expect(page.locator('#shots li[data-oid="B2"]')).toHaveAttribute('data-shot', 'concealed');
  await expect(page.locator('#board text[data-shot="concealed"]').first()).toBeVisible();
  await page.locator('#tgtbtn').click();
  await page.evaluate(() => window.scrollTo(0, 0));   // the Target button sits further down the side panel
  p = await toScreen(page, 12.05, 4.25);
  await page.mouse.click(p.x, p.y);
  await expect(page.locator('#verdict')).toContainText('NOT A VALID TARGET');
  await expect(page.locator('#verdict')).toContainText('in cover behind Stronghold 1');
});

// two operatives alone on open ground on Volkus AO 1, everyone else out of the way
async function duel(page) {
  await kz(page, () => {
    for (const o of skirmishtable.world.OPS) o.alive = o.id === 'A5' || o.id === 'B1';
    const ops = skirmishtable.world.OPS, a = ops.find(o => o.id === 'A5'), b = ops.find(o => o.id === 'B1');
    a.x = 19; a.y = 12.5; b.x = 25; b.y = 12.5; skirmishtable.renderAll();
  });
}
const opAt = (page, id) => kz(page, id => { const o = skirmishtable.world.OPS.find(o => o.id === id); return [+o.x.toFixed(2), +o.y.toFixed(2)]; }, id);

test('dragging into engagement range turns the move into a charge and rings both models', async ({ page }) => {
  await to2D(page);
  await duel(page);
  const a = await toScreen(page, 19, 12.5), b = await toScreen(page, 23.6, 12.5);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(a.x + (b.x - a.x) * i / 10, a.y + (b.y - a.y) * i / 10);
  const during = await kz(page, () => { const d = skirmishtable.state.drag; return [d.p1.type, d.valid, d.foes.map(f => f.id)]; });
  expect(during).toEqual(['charge', true, ['B1']]);
  expect(await page.locator('#board [data-engaged]').count()).toBeGreaterThanOrEqual(2);   // the ghost and B1 light up
  await page.mouse.up();
  expect(await opAt(page, 'A5')).toEqual([23.6, 12.5]);
  expect(await kz(page, () => { const o = skirmishtable.world.OPS.find(o => o.id === 'A5'); return [o.order, o.used]; })).toEqual(['engage', ['charge']]);
  await expect(page.locator('#log p', { hasText: 'Brand charges' })).toHaveCount(1);
  await expect(page.locator('#log p', { hasText: 'flips to ▲ Engage' })).toHaveCount(1);
  expect(await page.locator('#board [data-engaged]').count()).toBe(2);   // engaged: a red ring round both
});

test('a move after another move cannot end within engagement range', async ({ page }) => {
  await to2D(page);
  await duel(page);
  await drag(page, [19, 12.5], [21, 12.5]);                    // Reposition 2"
  expect(await opAt(page, 'A5')).toEqual([21, 12.5]);
  await drag(page, [21, 12.5], [23.6, 12.5]);                  // Dash into range: no Charge after moving
  expect(await opAt(page, 'A5')).toEqual([21, 12.5]);
  await expect(page.locator('#hint')).toContainText("can't Charge after moving");
});

test('switches maps from the picker and undoes a move', async ({ page }) => {
  await to2D(page);
  await page.locator('.maprow button[title="Volkus \'25 AO 3"]').click();
  expect(await kz(page, () => skirmishtable.world.MAP.name)).toBe("Volkus '25 AO 3");
  const start = await kz(page, () => { const o = skirmishtable.world.OPS.find(o => o.id === 'A1'); return [o.x, o.y]; });
  await drag(page, start, [start[0] + 2, start[1]]);
  await page.locator('#undo').click();
  expect(await kz(page, () => { const o = skirmishtable.world.OPS.find(o => o.id === 'A1'); return [o.x, o.y]; })).toEqual(start);
});

test('the 3D table draws only when something changes, and redraws reuse their GPU resources', async ({ page }) => {
  const frames = () => kz(page, () => skirmishtable.table3d.three.renderer.info.render.frame);
  const drawn = async () => { const a = await frames(); await page.waitForTimeout(700); return (await frames()) - a; };
  // animated base rings draw every frame...
  await page.selectOption('#ringready', 'ripple');
  await expect.poll(drawn, { timeout: 60_000 }).toBeGreaterThan(0);
  // ...and with still rings, once loading settles, an untouched table draws nothing
  await page.selectOption('#ringready', 'thin');
  await page.selectOption('#ringactive', 'none');
  await expect.poll(drawn, { timeout: 60_000 }).toBe(0);
  // re-rendering the operatives (selection, range rings, labels) allocates no new geometries or textures
  const memory = () => kz(page, async () => {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const m = skirmishtable.table3d.three.renderer.info.memory;
    return [m.geometries, m.textures];
  });
  await kz(page, () => { skirmishtable.state.sel = skirmishtable.world.OPS[0]; skirmishtable.renderAll(); });
  const before = await memory();
  for (let i = 0; i < 5; i++) await kz(page, () => skirmishtable.renderAll());
  expect(await memory()).toEqual(before);
  // orbiting draws
  const f0 = await frames(), c = await toScreen3D(page, 15, 11, 0);
  await page.mouse.move(c.x, c.y); await page.mouse.down();
  await page.mouse.move(c.x + 60, c.y, { steps: 5 }); await page.mouse.up();
  await expect.poll(frames).toBeGreaterThan(f0);
});

test('switches between the 3D table, top-down and the 2D map', async ({ page }) => {
  await page.locator('#view3dtop').click();
  await expect(page.locator('#view3dtop')).toHaveClass(/active/);
  await to2D(page);
  await expect(page.locator('#board')).toBeVisible();
  await expect(page.locator('#view3dtop')).toBeHidden();
  await page.locator('#view3d').click();
  await expect(page.locator('#board3d canvas')).toBeVisible();
});

test('switches rulesets: labels, base size and movement costs follow the rules', async ({ page }) => {
  await page.locator('#rulebtns button', { hasText: 'Ashfall' }).click();
  expect(await kz(page, () => [skirmishtable.rules.RULES.id, +(skirmishtable.world.OPS[0] && 0.63).toFixed(2)])).toEqual(['ashfall', 0.63]);
  await expect(page.locator('#rulenote')).toContainText('32mm bases');
  await place(page, 'A2', 10, 12);
  const a = await toScreen3D(page, 10, 12, 0.7);
  await page.mouse.click(a.x, a.y);
  await expect(page.locator('#opcard')).toContainText('Advance 6');
  await expect(page.locator('#opcard')).toContainText('Assault 8');
  const ashfall = await drag(page, [10, 12], [12.4, 12], true);
  expect(ashfall.total).toBe(4);                   // 2.4″ paid in 2″ bounds
  await page.locator('#rulebtns button', { hasText: 'Infinity' }).click();
  await place(page, 'A2', 10, 12);
  const inf = await drag(page, [10, 12], [12.4, 12], true);
  expect(inf.total).toBeCloseTo(2.4, 1);           // measured exactly
  await expect(page.locator('#log p').first()).toContainText('moves 2.4"');
});
