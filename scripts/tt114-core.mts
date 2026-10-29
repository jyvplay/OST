/**
 * TT114 — the parts of this turn that are pure functions, checked numerically.
 *
 * LN-09's scenes and WM-12's zoom clamp are both the kind of thing that is usually only ever
 * "checked" by looking at the screen. Looking at the screen cannot tell you that a background is
 * deterministic across reloads, that its parallax is exactly zero at the centre, or that it really
 * does stop when the machine is under load. Those are arithmetic, so they are asserted here.
 */
import assert from 'node:assert/strict';
import { makeHarness } from './harness.mts';
import {
  blobAt, buildScene, coverFit, isScene, parallaxOffset, PARALLAX_MAX, ridgeAt, SCENE_IDS,
  sceneFps, seedFrom, seededRandom, validSceneImage,
} from '../src/lib/scene-core.ts';
import { clampZoom, ZOOM_MAX, ZOOM_MIN } from '../src/lib/windowing/state.ts';

const { test, finish } = makeHarness('tt114-core');

/* ------------------------------------------------------------------ LN-09: the generator */

await test('the same seed always builds the same scene, so a reload does not reshuffle the desktop', { 'LN-09': 'full' }, async () => {
  for (const id of ['drift', 'ridge', 'aurora', 'image'] as const) {
    const a = buildScene(id, seedFrom(`${id}:`));
    const b = buildScene(id, seedFrom(`${id}:`));
    assert.deepEqual(a, b, `${id} must be deterministic`);
    const other = buildScene(id, seedFrom(`${id}:other`));
    assert.notDeepEqual(a, other, `${id} with a different seed must differ`);
  }
  // And a seed really does spread: 2000 draws should fill the unit interval roughly evenly.
  const rnd = seededRandom(seedFrom('spread'));
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 2000; i++) buckets[Math.min(9, Math.floor(rnd() * 10))]++;
  const min = Math.min(...buckets), max = Math.max(...buckets);
  assert.ok(min > 120 && max < 290, `a usable spread, got buckets ${buckets.join(',')}`);
  console.log(`    deterministic for 4 scenes; 2000 draws per-decile min ${min} max ${max}`);
});

await test('every scene is bounded: layers are ordered by depth and nothing is empty', { 'LN-09': 'full' }, async () => {
  assert.deepEqual(buildScene('off', 1).layers, [], 'the off scene builds nothing at all');
  for (const id of ['drift', 'ridge', 'aurora', 'image'] as const) {
    const m = buildScene(id, seedFrom(id));
    assert.ok(m.layers.length >= 2 && m.layers.length <= 4, `${id} layer count ${m.layers.length}`);
    const depths = m.layers.map((l) => l.depth);
    assert.deepEqual(depths, [...depths].sort((x, y) => x - y), `${id} layers must run far → near`);
    assert.equal(depths[0], 0, 'the farthest layer is depth 0');
    assert.equal(depths[depths.length - 1], 1, 'the nearest layer is depth 1');
    const shapes = m.layers.reduce((n, l) => n + l.blobs.length + l.ridges.length, 0);
    assert.ok(shapes >= 4 && shapes <= 60, `${id} draws ${shapes} shapes — cheap enough to animate`);
    for (const l of m.layers) for (const b of l.blobs) {
      assert.ok(b.r > 0 && b.r < 0.6, `blob radius ${b.r}`);
      assert.ok(b.alpha > 0 && b.alpha <= 0.3, `blob alpha ${b.alpha} stays a background`);
    }
  }
  console.log('    4 scenes, depth-ordered, 4–60 shapes each, all translucent');
});

/* ------------------------------------------------------------------ LN-09: parallax */

await test('parallax is zero at the centre, grows with depth, and is clamped at the edges', { 'LN-09': 'full' }, async () => {
  const centre = parallaxOffset(1, { x: 0.5, y: 0.5 });
  assert.equal(centre.dx, 0, 'no horizontal shift at the centre');
  assert.equal(centre.dy, 0, 'no vertical shift at the centre');

  const far = parallaxOffset(0, { x: 1, y: 1 });
  assert.equal(far.dx, 0, 'the farthest layer does not move at all');

  const near = parallaxOffset(1, { x: 1, y: 1 });
  assert.ok(Math.abs(near.dx - -PARALLAX_MAX) < 1e-12, `the nearest layer moves by the full amplitude, got ${near.dx}`);

  const mid = parallaxOffset(0.5, { x: 1, y: 0.5 });
  assert.ok(Math.abs(mid.dx - near.dx / 2) < 1e-12, 'a half-depth layer moves half as far');

  // Off-screen pointers clamp rather than run away — a scene must not lurch when the pointer leaves.
  for (const p of [{ x: -5, y: 0.5 }, { x: 9, y: 0.5 }, { x: 0.5, y: -2 }]) {
    const o = parallaxOffset(1, p);
    assert.ok(Math.abs(o.dx) <= PARALLAX_MAX + 1e-12 && Math.abs(o.dy) <= PARALLAX_MAX + 1e-12, `clamped for ${JSON.stringify(p)}`);
  }
  console.log(`    centre 0, far 0, near ±${PARALLAX_MAX}, half-depth exactly half, off-screen clamped`);
});

await test('a drifting scene stays inside its box for a simulated hour', { 'LN-09': 'full' }, async () => {
  const m = buildScene('drift', seedFrom('hour'));
  let worst = 0;
  for (let t = 0; t < 3600; t += 7) {
    for (const l of m.layers) for (const b of l.blobs) {
      const p = blobAt(b, l.depth, t, { x: 1, y: 0 });
      worst = Math.max(worst, Math.abs(p.x - b.x), Math.abs(p.y - b.y));
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'positions stay finite');
    }
  }
  // 0.03 drift + 0.04 parallax is the whole budget; nothing may accumulate beyond it.
  assert.ok(worst <= 0.03 + PARALLAX_MAX + 1e-9, `maximum excursion ${worst.toFixed(4)} stays within the declared budget`);

  const r = buildScene('ridge', seedFrom('hour')).layers[0].ridges[0];
  for (let t = 0; t < 3600; t += 37) {
    const y = ridgeAt(r, (t % 100) / 100, t, 0.5, { x: 0.5, y: 0.5 });
    assert.ok(y > 0 && y < 1.1, `ridge height ${y} stays on screen`);
  }
  console.log(`    514 sampled seconds × every shape: worst excursion ${worst.toFixed(4)} of the viewport`);
});

/* ------------------------------------------------------------------ LN-09: the cost model */

await test('the scene yields: hidden, throttled or reduced-motion all mean a still frame', { 'LN-09': 'full' }, async () => {
  const base = { reducedMotion: false, hidden: false, throttled: false, motionSetting: 'system' as const };
  assert.equal(sceneFps(base), 30, 'a healthy idle desktop animates at 30fps');
  assert.equal(sceneFps({ ...base, hidden: true }), 0, 'a hidden tab draws nothing');
  assert.equal(sceneFps({ ...base, throttled: true }), 0, 'under shell pressure the scene stops');
  assert.equal(sceneFps({ ...base, reducedMotion: true }), 0, 'reduced motion stops it');
  assert.equal(sceneFps({ ...base, motionSetting: 'off' }), 0, 'motion off stops it');
  // "on" is an explicit override of the OS hint, which is why it is a three-value setting.
  assert.equal(sceneFps({ ...base, reducedMotion: true, motionSetting: 'on' }), 30, 'an explicit "on" overrides the OS hint');
  assert.equal(sceneFps({ ...base, hidden: true, motionSetting: 'on' }), 0, 'but nothing overrides a hidden tab');
  console.log('    30fps only when visible, unthrottled and motion is wanted; 0 in all 5 yielding cases');
});

/* ------------------------------------------------------------------ LN-09: the picture path */

await test('a scene picture must be a local picture path, not a URL', { 'LN-09': 'full', 'SC-02': 'partial' }, async () => {
  for (const good of ['/Pictures/a.png', '/Downloads/Recall/x/1-2.jpg', '/p/b.WEBP', '/x/c.avif']) {
    assert.ok(validSceneImage(good), `${good} must be accepted`);
  }
  for (const bad of [
    'https://example.com/a.png', '//evil.test/a.png', '/x/../../etc/passwd.png', '/a.png/../b.png',
    '/notapicture.txt', '/a.png\u0000', '', '/' + 'x'.repeat(600) + '.png', 'Pictures/a.png',
  ]) {
    assert.equal(validSceneImage(bad), false, `${JSON.stringify(bad.slice(0, 40))} must be refused`);
  }
  console.log('    4 local paths accepted; 9 refused including 2 remote URLs and 2 traversals');
});

await test('cover-fit fills the desk without distorting the picture', { 'LN-09': 'full' }, async () => {
  const wide = coverFit({ w: 4000, h: 1000 }, { w: 800, h: 600 });
  assert.ok(wide.h >= 600 - 1e-9 && wide.w >= 800 - 1e-9, 'the box is covered');
  assert.ok(Math.abs(wide.w / wide.h - 4) < 1e-9, 'the aspect ratio is preserved');
  assert.ok(wide.x <= 0 && wide.y <= -0 + 1e-9, 'overflow is centred, not cropped from one side');
  const tall = coverFit({ w: 100, h: 900 }, { w: 800, h: 600 });
  assert.ok(Math.abs(tall.w / tall.h - 100 / 900) < 1e-9);
  assert.deepEqual(coverFit({ w: 0, h: 0 }, { w: 800, h: 600 }), { w: 800, h: 600, x: 0, y: 0 }, 'a broken picture degrades to the box');
  console.log('    aspect preserved for 4:1 and 1:9 pictures; degenerate input handled');
});

await test('the scene id vocabulary is closed', { 'LN-09': 'full' }, async () => {
  assert.ok(isScene('off') && isScene('drift') && isScene('image'));
  for (const bad of ['', 'DRIFT', 'drift ', 'http', '__proto__']) assert.equal(isScene(bad), false, `${bad} is not a scene`);
  assert.equal(SCENE_IDS.length, 5);
  console.log(`    ${SCENE_IDS.length} scenes: ${SCENE_IDS.join(', ')}`);
});

/* ------------------------------------------------------------------ WM-12: the zoom clamp */

await test('per-window zoom is clamped to a usable range and rounded to whole percents', { 'WM-12': 'partial' }, async () => {
  assert.equal(clampZoom(1), 1);
  assert.equal(clampZoom(0.0001), ZOOM_MIN, 'a tiny zoom clamps up to the floor');
  assert.equal(clampZoom(99), ZOOM_MAX, 'a huge zoom clamps down to the ceiling');
  assert.equal(clampZoom(Number.NaN), 1, 'a broken value resets rather than blanking the window');
  assert.equal(clampZoom(Number.POSITIVE_INFINITY), 1, 'infinity is not a zoom');
  assert.equal(clampZoom(1.2345), 1.23, 'rounded, so repeated steps cannot drift');
  // Ten steps up then ten down must return exactly to 1, or the menu would never come home.
  let z = 1;
  for (let i = 0; i < 10; i++) z = clampZoom(z + 0.1);
  for (let i = 0; i < 10; i++) z = clampZoom(z - 0.1);
  assert.equal(z, 1, `ten steps up and down returned ${z}`);
  console.log(`    range [${ZOOM_MIN}, ${ZOOM_MAX}], NaN/∞ → 1, 10 steps up+down returns exactly to 1`);
});

await finish();
