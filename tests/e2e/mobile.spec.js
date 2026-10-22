// Touch on a phone: a finger drag on a token moves it on the 3D table (and on the 2D map),
// with real touch input (CDP touch events, which the browser turns into pointer events
// and touch events, exactly as on a phone, including pan/scroll handling).
import { test, expect, devices } from '@playwright/test';

const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
test.use(pixel);

const kz = (page, fn, arg) => page.evaluate(fn, arg);
async function place(page, id, x, y) {
  await kz(page, ([id, x, y]) => {
    const op = skirmishtable.world.OPS.find(o => o.id === id); op.x = x; op.y = y;
    for (const o of skirmishtable.world.OPS) if (o.id !== id && Math.hypot(o.x - x, o.y - y) < 6) o.alive = false;
    skirmishtable.renderAll();
  }, [id, x, y]);
}
// a one-finger drag from a to b (client pixels), in steps, like a real finger
async function fingerDrag(page, a, b) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, p) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y, id: 1 }] : [] });
  await touch('touchStart', a);
  for (let i = 1; i <= 12; i++) await touch('touchMove', { x: a.x + (b.x - a.x) * i / 12, y: a.y + (b.y - a.y) * i / 12 });
  const during = await kz(page, () => {
    const d = skirmishtable.state.drag;
    return d ? { active: d.active, total: d.total } : null;
  });
  await touch('touchEnd');
  return during;
}
const opAt = (page, id) => kz(page, id => { const o = skirmishtable.world.OPS.find(o => o.id === id); return [+o.x.toFixed(1), +o.y.toFixed(1)]; }, id);

// the operative landed where the finger let go (or the nearest spot its base fits)
async function expectNear(page, id, x, y) {
  const [ox, oy] = await opAt(page, id);
  expect(Math.hypot(ox - x, oy - y)).toBeLessThan(1);
}

let errors;
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/?deploy=zones');   // drop-zone deployment: the tests expect open table, not the random demo scatter
  await page.waitForFunction(() => window.skirmishtable && skirmishtable.world.MAP && skirmishtable.table3d.three);
});
test.afterEach(() => expect(errors).toEqual([]));

test('a finger drags an operative on the 3D table', async ({ page }) => {
  await place(page, 'A2', 10, 12);
  await page.locator('#board3d canvas').scrollIntoViewIfNeeded();
  const a = await kz(page, () => skirmishtable.table3d.boardToScreen(10, 12, 0.7));
  const b = await kz(page, () => skirmishtable.table3d.boardToScreen(13, 12, 0));
  const scrollBefore = await kz(page, () => scrollY);
  const during = await fingerDrag(page, a, b);
  expect(during && during.active).toBe(true);
  expect(during.total).toBeGreaterThanOrEqual(3);
  await expectNear(page, 'A2', 13, 12);
  expect(await kz(page, () => scrollY)).toBe(scrollBefore);   // the page didn't scroll instead
});

test('a fingertip slightly off the token still grabs it', async ({ page }) => {
  await place(page, 'A2', 10, 12);
  await page.locator('#board3d canvas').scrollIntoViewIfNeeded();
  const a = await kz(page, () => skirmishtable.table3d.boardToScreen(10, 12, 0.35));
  const b = await kz(page, () => skirmishtable.table3d.boardToScreen(13, 12, 0));
  const during = await fingerDrag(page, { x: a.x + 14, y: a.y + 10 }, b);
  expect(during && during.active).toBe(true);
  await expectNear(page, 'A2', 13, 12);
});

test('a finger on empty table orbits instead of moving anything', async ({ page }) => {
  await place(page, 'A2', 10, 12);
  await page.locator('#board3d canvas').scrollIntoViewIfNeeded();
  const cam0 = await kz(page, () => skirmishtable.table3d.three.camera.position.toArray());
  const a = await kz(page, () => skirmishtable.table3d.boardToScreen(20, 16, 0));
  await fingerDrag(page, a, { x: a.x + 80, y: a.y });
  const cam1 = await kz(page, () => skirmishtable.table3d.three.camera.position.toArray());
  expect(cam1).not.toEqual(cam0);
  expect(await opAt(page, 'A2')).toEqual([10, 12]);
});

test('a finger drags an operative on the 2D map', async ({ page }) => {
  await page.locator('#view2d').tap();
  await place(page, 'A2', 10, 12);
  await page.locator('#board').scrollIntoViewIfNeeded();
  const pt = (x, y) => kz(page, ([x, y]) => {
    const p = new DOMPoint(x * 32, y * 32).matrixTransform(document.getElementById('board').getScreenCTM());
    return { x: p.x, y: p.y };
  }, [x, y]);
  const during = await fingerDrag(page, await pt(10, 12), await pt(13, 12));
  expect(during && during.active).toBe(true);
  await expectNear(page, 'A2', 13, 12);
});
