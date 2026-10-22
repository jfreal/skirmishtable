// "Save picture": a PNG of the board as it looks now, 3D table or 2D map, downloaded.
// The pictures go to Playwright's temp folder, never into the repo.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';

// width and height from the PNG header; a blank canvas packs down to almost nothing
async function png(download) {
  const buf = fs.readFileSync(await download.path());
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), bytes: buf.length };
}

test('saves a picture of the 3D table and of the 2D map', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.locator('#mapbtns button[title="Gallowdark AO1"]').click();
  await page.locator('#endtp').click();

  // the 3D table (the default view): twice the canvas size, plus the caption strip
  await expect(page.locator('#view3d')).toHaveClass(/active/);
  const canvas = await page.evaluate(() => { const c = document.querySelector('#board3d canvas'); return [c.clientWidth, c.clientHeight]; });
  const frame = () => page.evaluate(() => skirmishtable.table3d.three.renderer.info.render.frame);
  await page.waitForTimeout(500);
  const f0 = await frame();
  let [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save picture' }).click()]);
  expect(dl.suggestedFilename()).toBe('skirmishtable-gallowdark-ao1-tp2.png');
  let p = await png(dl);
  expect(p.w).toBe(canvas[0] * 2);
  expect(p.h).toBe(canvas[1] * 2 + Math.round(canvas[0] * 2 / 40));
  expect(p.bytes).toBeGreaterThan(30000);
  await expect(page.locator('#hint')).toContainText('3D table');
  // the grab resized the canvas, which clears it: the table is drawn again afterwards
  await expect.poll(frame).toBeGreaterThanOrEqual(f0 + 2);   // the grab, then the redraw

  // the 2D map: the SVG at twice its own size, plus the strip
  await page.locator('#view2d').click();
  const vb = await page.evaluate(() => { const b = document.getElementById('board').viewBox.baseVal; return [Math.round(b.width * 2), Math.round(b.height * 2)]; });
  [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save picture' }).click()]);
  p = await png(dl);
  expect([p.w, p.h]).toEqual([vb[0], vb[1] + Math.round(vb[0] / 40)]);
  expect(p.bytes).toBeGreaterThan(30000);
  await expect(page.locator('#hint')).toContainText('2D map');
  expect(errors).toEqual([]);
});
