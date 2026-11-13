/**
 * Frontend / mobile audit reproductions (docs/audit/frontend-mobile.md).
 *
 * Conventions
 *  - Every test whose title starts with "FM-nn" asserts the CORRECT behaviour.
 *  - Confirmed defects are annotated test.fail(): they PASS the suite while the defect exists and
 *    will start failing ("unexpected pass") the moment the defect is fixed, forcing the annotation
 *    to be removed and the test kept as a regression guard.
 *  - Tests marked "(not a defect)" / "(documents behaviour)" pass normally.
 *  - The production Worker is NEVER contacted: every Worker request is served by an in-memory fake.
 *  - All images are synthetic and generated inside the test.
 */
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.L1_CHROMIUM_PATH) {
  test.use({ launchOptions: { executablePath: process.env.L1_CHROMIUM_PATH } });
}

const WORKER = 'https://l1-state-sync.pdarleyjr.workers.dev';
const COMP_IDS = ['CabRearZone', 'LS1', 'LS2', 'LS3', 'LS4', 'RS1', 'RS2', 'RS3', 'RS4', 'RS5', 'RR1'];
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// ─── In-memory fake Worker ────────────────────────────────────────────────────
async function installFakeWorker(page, opts = {}) {
  const empty = {};
  for (const id of COMP_IDS) empty[id] = Array(15).fill('');
  const fake = {
    state: opts.state ?? { allocations: empty, _serverTs: 1 },
    images: opts.images ?? null, // { uploadedImages, featuredImages, _serverTs }
    aiDelayMs: opts.aiDelayMs ?? 0,
    aiStatus: opts.aiStatus ?? 200,
    freezeImagePuts: false,
    imagePuts: [],
    imageGets: [],
    aiCalls: 0,
    stray: [],
  };
  await page.route(`${WORKER}/**`, async route => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (status, body, headers = {}) =>
      route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
    if (req.method() === 'GET' && url.pathname === '/state') return json(200, fake.state);
    if (req.method() === 'GET' && url.pathname === '/images') {
      const body = fake.images ? JSON.stringify(fake.images) : 'null';
      fake.imageGets.push({ bytes: body.length, search: url.search, inm: req.headers()['if-none-match'] });
      if (opts.imageNotModifiedWhen?.(url, req) && fake.images) return route.fulfill({ status: 304 });
      return route.fulfill({ status: 200, contentType: 'application/json', body });
    }
    if (req.method() === 'PUT' && url.pathname === '/images') {
      const doc = req.postDataJSON();
      fake.imagePuts.push({ at: Date.now(), doc });
      const ts = Date.now();
      if (!fake.freezeImagePuts) fake.images = { ...doc, _serverTs: ts };
      return json(200, { ok: true, _serverTs: ts });
    }
    if (req.method() === 'PUT' && url.pathname === '/state') return json(200, { ok: true, _serverTs: Date.now() });
    if (req.method() === 'POST' && url.pathname === '/generate-image') {
      fake.aiCalls += 1;
      if (fake.aiDelayMs) await new Promise(r => setTimeout(r, fake.aiDelayMs));
      if (fake.aiStatus !== 200) return json(fake.aiStatus, { error: 'Synthetic generation failure' });
      return json(200, { dataUrl: `data:image/png;base64,${TINY_PNG}` });
    }
    fake.stray.push(`${req.method()} ${url.pathname}`);
    return json(404, { error: 'unhandled by fake' });
  });
  return fake;
}

async function boot(page, opts) {
  const fake = await installFakeWorker(page, opts);
  await page.goto('/');
  await expect(page.getByText('Loading L1 Compartment Builder')).toBeHidden();
  return fake;
}

async function nav(page, isMobile, name) {
  if (isMobile) await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', typeof name === 'string' ? { name, exact: true } : { name }).click();
}

const fileInput = page => page.locator('input[type="file"]');
const storedUploads = page =>
  page.evaluate(() => JSON.parse(localStorage.getItem('l1-compartment-builder-uploads') || '{}'));

// ─── Synthetic image helpers ──────────────────────────────────────────────────
/** Returns base64 of a synthetic image generated with canvas inside the page. */
async function makeImage(page, { w, h, type = 'image/jpeg', mode = 'photo', quality = 0.92, amp = 12 }) {
  return page.evaluate(({ w, h, type, mode, quality, amp }) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    if (mode === 'transparent') {
      g.clearRect(0, 0, w, h);
      g.fillStyle = 'rgb(255,0,0)';
      g.fillRect(w / 4, h / 4, w / 2, h / 2); // opaque red square on a fully transparent field
    } else if (mode === 'fine-detail') {
      // 1-pixel alternating vertical lines: worst case for downscaling (stand-in for tool labels, hose texture)
      const id = g.createImageData(w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = x % 2 ? 255 : 0; const i = (y * w + x) * 4;
        id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255;
      }
      g.putImageData(id, 0, 0);
    } else if (mode === 'orientation') {
      g.fillStyle = '#2255cc'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#ffee00'; g.fillRect(0, 0, w / 2, h / 2); // marker in the top-left corner
    } else {
      // "photo-like": gradient + shapes + per-pixel noise (noise is what makes real photos ~400 KB at 1400 px)
      const gr = g.createLinearGradient(0, 0, w, h);
      gr.addColorStop(0, '#445566'); gr.addColorStop(1, '#ccaa88');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 40; i++) {
        g.fillStyle = `hsl(${(i * 37) % 360} 40% 50%)`;
        g.fillRect((i * 97) % w, (i * 53) % h, w / 8, h / 10);
      }
      const id = g.getImageData(0, 0, w, h);
      let s = 12345;
      for (let i = 0; i < id.data.length; i += 4) {
        s = (s * 1664525 + 1013904223) >>> 0;
        const n = ((s >>> 24) % (2 * amp + 1)) - amp;
        id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n;
      }
      g.putImageData(id, 0, 0);
    }
    return c.toDataURL(type, quality).split(',')[1];
  }, { w, h, type, mode, quality, amp });
}

/** Insert a minimal EXIF APP1 (Orientation + GPS lat/long) right after the JPEG SOI marker. */
function withExif(jpeg, orientation) {
  const t = Buffer.alloc(140);
  t.write('II', 0); t.writeUInt16LE(0x2a, 2); t.writeUInt32LE(8, 4);
  t.writeUInt16LE(2, 8); // IFD0: 2 entries
  t.writeUInt16LE(0x0112, 10); t.writeUInt16LE(3, 12); t.writeUInt32LE(1, 14); t.writeUInt16LE(orientation, 18);
  t.writeUInt16LE(0x8825, 22); t.writeUInt16LE(4, 24); t.writeUInt32LE(1, 26); t.writeUInt32LE(38, 30); // -> GPS IFD
  t.writeUInt32LE(0, 34);
  t.writeUInt16LE(4, 38); // GPS IFD: 4 entries
  t.writeUInt16LE(1, 40); t.writeUInt16LE(2, 42); t.writeUInt32LE(2, 44); t.write('N\0', 48);
  t.writeUInt16LE(2, 52); t.writeUInt16LE(5, 54); t.writeUInt32LE(3, 56); t.writeUInt32LE(92, 60);
  t.writeUInt16LE(3, 64); t.writeUInt16LE(2, 66); t.writeUInt32LE(2, 68); t.write('W\0', 72);
  t.writeUInt16LE(4, 76); t.writeUInt16LE(5, 78); t.writeUInt32LE(3, 80); t.writeUInt32LE(116, 84);
  t.writeUInt32LE(0, 88);
  [[25, 1], [46, 1], [3000, 100]].forEach(([n, d], i) => { t.writeUInt32LE(n, 92 + i * 8); t.writeUInt32LE(d, 96 + i * 8); }); // 25°46'30" N
  [[80, 1], [7, 1], [1500, 100]].forEach(([n, d], i) => { t.writeUInt32LE(n, 116 + i * 8); t.writeUInt32LE(d, 120 + i * 8); }); // 80°7'15" W
  const body = Buffer.concat([Buffer.from('Exif\0\0'), t]);
  const seg = Buffer.alloc(4); seg.writeUInt16BE(0xffe1, 0); seg.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), seg, body, jpeg.subarray(2)]);
}

/** Decode a stored data URL in the page and report geometry/size/pixels. */
function inspect(page, dataUrl, probe) {
  return page.evaluate(async ({ dataUrl, probe }) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const out = { w: img.naturalWidth, h: img.naturalHeight, chars: dataUrl.length, mime: dataUrl.slice(5, dataUrl.indexOf(';')) };
    if (probe?.pixel) out.pixel = Array.from(g.getImageData(probe.pixel[0] * c.width, probe.pixel[1] * c.height, 1, 1).data);
    if (probe?.centerStd) {
      const n = 80, x0 = Math.floor(c.width / 2 - n / 2), y0 = Math.floor(c.height / 2 - n / 2);
      const d = g.getImageData(x0, y0, n, n).data; let sum = 0, sq = 0;
      for (let i = 0; i < d.length; i += 4) { sum += d[i]; sq += d[i] * d[i]; }
      const m = sum / (n * n); out.centerStd = Math.sqrt(sq / (n * n) - m * m);
    }
    return out;
  }, { dataUrl, probe });
}

async function uploadSynthetic(page, name = 'synthetic.png') {
  await fileInput(page).setInputFiles({ name, mimeType: 'image/png', buffer: Buffer.from(TINY_PNG, 'base64') });
}

// ─── Upload pipeline ──────────────────────────────────────────────────────────
test.describe('uploads and image handling', () => {
  test('FM-01 an undecodable file claiming image/* is rejected, not stored raw', async ({ page, isMobile }) => {
    test.fail(true, 'compressImage() resolves the ORIGINAL data URL when decoding fails (src/App.jsx:2084) and handleFile stores it');
    await boot(page);
    await nav(page, isMobile, /^LS1/);
    // ISO-BMFF "ftyp heic" header + junk: what an HEIC looks like to a browser that cannot decode it.
    const fakeHeic = Buffer.concat([
      Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(300, 7),
    ]);
    await fileInput(page).setInputFiles({ name: 'IMG_0001.HEIC', mimeType: 'image/heic', buffer: fakeHeic });
    await page.waitForTimeout(800);
    const stored = await storedUploads(page);
    const prefix = (stored.LS1?.[0]?.dataUrl ?? '').slice(0, 30);
    test.info().annotations.push({ type: 'observed', description: `stored dataUrl prefix: "${prefix}"` });
    expect(stored.LS1 ?? []).toHaveLength(0);
    await expect(page.getByRole('alert')).toBeVisible();
  });

  test('FM-02 a .heic file whose MIME type is empty gets an actionable HEIC message', async ({ page, isMobile }) => {
    test.fail(true, 'message is the generic "Choose a PNG, JPEG, or WebP image." (src/App.jsx:1880); HEIC is never mentioned');
    await boot(page);
    await nav(page, isMobile, /^LS1/);
    // Chromium on Windows/Linux/Android reports type "" for .heic files.
    await fileInput(page).setInputFiles({ name: 'IMG_0002.heic', mimeType: '', buffer: Buffer.alloc(400, 3) });
    await expect(page.getByText(/HEIC/i)).toBeVisible({ timeout: 2000 });
  });

  test('FM-03 uploads keep full resolution (long edge >= 2400 px) for reference use', async ({ page, isMobile }) => {
    test.fail(true, 'compressImage(dataUrl, 1400, 0.82) re-encodes to JPEG and the original is discarded (src/App.jsx:2070,1887)');
    await boot(page);
    await nav(page, isMobile, /^LS1/);
    const b64 = await makeImage(page, { w: 3000, h: 2000, mode: 'fine-detail', type: 'image/png' });
    await fileInput(page).setInputFiles({ name: 'detail.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
    await expect.poll(async () => (await storedUploads(page)).LS1?.length ?? 0).toBe(1);
    const dataUrl = (await storedUploads(page)).LS1[0].dataUrl;
    const info = await inspect(page, dataUrl, { centerStd: true });
    test.info().annotations.push({
      type: 'observed',
      description: `3000x2000 PNG (${Buffer.from(b64, 'base64').length} B) -> ${info.w}x${info.h} ${info.mime}, ${info.chars} chars; 1px-line contrast std ${info.centerStd.toFixed(1)} (source 127.5)`,
    });
    expect(Math.max(info.w, info.h)).toBeGreaterThanOrEqual(2400);
  });

  test('FM-04 transparent PNG uploads are not flattened onto black', async ({ page, isMobile }) => {
    test.fail(true, 'everything is re-encoded with canvas.toDataURL("image/jpeg"); JPEG has no alpha so transparent pixels become black');
    await boot(page);
    await nav(page, isMobile, /^LS1/);
    const b64 = await makeImage(page, { w: 200, h: 200, mode: 'transparent', type: 'image/png' });
    await fileInput(page).setInputFiles({ name: 'drawing.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
    await expect.poll(async () => (await storedUploads(page)).LS1?.length ?? 0).toBe(1);
    const info = await inspect(page, (await storedUploads(page)).LS1[0].dataUrl, { pixel: [0.05, 0.05] });
    test.info().annotations.push({ type: 'observed', description: `corner pixel (was transparent): rgba(${info.pixel})` });
    expect(Math.min(info.pixel[0], info.pixel[1], info.pixel[2])).toBeGreaterThan(200); // white-ish or still transparent
  });

  test('FM-05 GPS/EXIF metadata does not survive a decodable upload (not a defect)', async ({ page, isMobile }) => {
    await boot(page);
    await nav(page, isMobile, /^LS1/);
    const jpeg = withExif(Buffer.from(await makeImage(page, { w: 320, h: 240 }), 'base64'), 1);
    expect(jpeg.includes(Buffer.from('Exif\0\0'))).toBe(true); // sanity: the input really has EXIF + GPS IFD
    await fileInput(page).setInputFiles({ name: 'gps.jpg', mimeType: 'image/jpeg', buffer: jpeg });
    await expect.poll(async () => (await storedUploads(page)).LS1?.length ?? 0).toBe(1);
    const dataUrl = (await storedUploads(page)).LS1[0].dataUrl;
    const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
    expect(bytes.includes(Buffer.from('Exif\0\0'))).toBe(false);
    expect(bytes.includes(Buffer.from('II*\0'))).toBe(false);
  });

  test('FM-06 EXIF orientation is applied to pixels (not a defect)', async ({ page, isMobile }) => {
    await boot(page);
    await nav(page, isMobile, /^LS1/);
    // 200x100 landscape pixels tagged Orientation=6 (rotate 90° CW) -> must be stored as 100x200 portrait.
    const jpeg = withExif(Buffer.from(await makeImage(page, { w: 200, h: 100, mode: 'orientation' }), 'base64'), 6);
    await fileInput(page).setInputFiles({ name: 'rot.jpg', mimeType: 'image/jpeg', buffer: jpeg });
    await expect.poll(async () => (await storedUploads(page)).LS1?.length ?? 0).toBe(1);
    const info = await inspect(page, (await storedUploads(page)).LS1[0].dataUrl, { pixel: [0.95, 0.05] });
    test.info().annotations.push({ type: 'observed', description: `stored ${info.w}x${info.h}; top-right pixel rgba(${info.pixel}) (yellow marker expected there after 90° CW)` });
    expect([info.w, info.h]).toEqual([100, 200]);
    expect(info.pixel[0]).toBeGreaterThan(200); // yellow marker moved to the top-right
  });

  test('FM-07 several photos can be selected in one go', async ({ page, isMobile }) => {
    test.fail(true, '<input type=file> has no `multiple` attribute and handleFile only reads files[0] (src/App.jsx:1877,2013)');
    await boot(page);
    await nav(page, isMobile, /^LS1/);
    await expect(fileInput(page)).toHaveAttribute('multiple', '', { timeout: 1000 });
  });

  test('FM-08 a "take photo" control exists (input capture) for phones', async ({ page, isMobile }) => {
    test.fail(true, 'only <input accept="image/*"> exists; no capture="environment" control (src/App.jsx:2013)');
    await boot(page);
    await nav(page, isMobile, /^LS1/);
    await expect(page.locator('input[type="file"][capture]')).toHaveCount(1, { timeout: 1000 });
  });

  test('FM-08b Permissions-Policy camera=() blocks getUserMedia (documents behaviour)', async ({ page }) => {
    const headers = readHeadersFile();
    expect(headers).toMatch(/Permissions-Policy: .*camera=\(\)/);
    await installFakeWorker(page);
    await page.route('**/', async route => {
      if (route.request().resourceType() !== 'document') return route.fallback();
      const res = await route.fetch();
      await route.fulfill({ response: res, headers: { ...res.headers(), 'permissions-policy': 'camera=(), microphone=()' } });
    });
    await page.goto('/');
    const result = await page.evaluate(async () => {
      const pp = document.permissionsPolicy ?? document.featurePolicy;
      if (pp && !pp.allowsFeature('camera')) return 'NotAllowedError: camera disallowed by Permissions-Policy';
      try { await navigator.mediaDevices.getUserMedia({ video: true }); return 'granted'; }
      catch (e) { return `${e.name}: ${e.message}`; }
    });
    test.info().annotations.push({ type: 'observed', description: `getUserMedia under camera=(): ${result}` });
    expect(result).toMatch(/NotAllowedError/);
    // <input type=file capture> launches the OS camera app and is not governed by Permissions-Policy (INFERRED; cannot be
    // exercised in headless Chromium).
  });

  test('FM-09 upload validation errors are announced (role=alert)', async ({ page, isMobile }) => {
    test.fail(true, 'aiError <div> has no role="alert"/aria-live and sits in the AI panel below the textarea (src/App.jsx:2050)');
    await boot(page);
    await nav(page, isMobile, /^LS1/);
    await fileInput(page).setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(13 * 1024 * 1024, 1) });
    await expect(page.getByText(/larger than 12 MB/)).toBeVisible();
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 1000 });
  });

  test('FM-09b oversize and non-image files are refused with a message (not a defect)', async ({ page, isMobile }) => {
    await boot(page);
    await nav(page, isMobile, /^LS1/);
    await fileInput(page).setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(13 * 1024 * 1024, 1) });
    await expect(page.getByText(/larger than 12 MB/)).toBeVisible();
    await fileInput(page).setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await expect(page.getByText(/Choose a PNG, JPEG, or WebP/)).toBeVisible();
    expect((await storedUploads(page)).LS1 ?? []).toHaveLength(0);
  });

  test('FM-10 removing an uploaded photo asks for confirmation or offers undo', async ({ page, isMobile }) => {
    test.fail(true, '"Remove this image" deletes immediately: no dialog, no undo (src/App.jsx:1999)');
    await boot(page);
    await nav(page, isMobile, /^LS1/);
    await uploadSynthetic(page, 'mount-photo.png');
    await expect(page.getByRole('img', { name: 'mount-photo' })).toBeVisible();
    let dialogSeen = false;
    page.on('dialog', d => { dialogSeen = true; d.dismiss(); });
    await page.getByRole('button', { name: 'Remove this image' }).click();
    await page.waitForTimeout(300);
    const undo = await page.getByRole('button', { name: /undo/i }).count();
    const stillThere = await page.getByRole('img', { name: 'mount-photo' }).count();
    test.info().annotations.push({ type: 'observed', description: `dialog=${dialogSeen} undoButtons=${undo} imageStillPresent=${stillThere}` });
    expect(dialogSeen || undo > 0 || stillThere > 0).toBe(true);
  });

  test('FM-14 carousel controls remain reachable when a compartment has 20 photos', async ({ page, isMobile }) => {
    test.fail(true, 'one 44 px button per image in a flex row with shrink-0 inside overflow-hidden: the remove/star buttons are clipped');
    await boot(page);
    await nav(page, isMobile, /^LS1/);
    for (let i = 0; i < 20; i++) await uploadSynthetic(page, `p${i}.png`);
    await expect(page.getByRole('button', { name: /Show image 21 of 21/ })).toBeVisible();
    const box = await page.locator('.print-image-container').first().boundingBox();
    const remove = await page.getByRole('button', { name: 'Remove this image' }).boundingBox();
    test.info().annotations.push({ type: 'observed', description: `container right=${box.x + box.width}, remove button right=${remove.x + remove.width}` });
    expect(remove.x + remove.width).toBeLessThanOrEqual(box.x + box.width + 1);
  });

  test('FM-33 twelve detailed site photos fit in device storage', async ({ page, isMobile }) => {
    test.fail(true, 'all photos are base64 in localStorage (~5 MB origin quota) and the whole map is re-serialised on every change');
    await boot(page);
    await nav(page, isMobile, /^LS1/);
    // 1400x1050 high-entropy frame (stand-in for diamond-plate / hose / gravel texture that JPEG cannot squeeze).
    const b64 = await makeImage(page, { w: 1400, h: 1050, mode: 'photo', quality: 0.9, amp: 70 });
    const buffer = Buffer.from(b64, 'base64');
    for (let i = 0; i < 12; i++) {
      await fileInput(page).setInputFiles({ name: `site${i}.jpg`, mimeType: 'image/jpeg', buffer });
      await expect(page.getByRole('button', { name: new RegExp(`Show image ${i + 2} of`) })).toBeVisible({ timeout: 20000 });
    }
    const usage = await page.evaluate(() => {
      const v = localStorage.getItem('l1-compartment-builder-uploads') || '';
      return { chars: v.length, count: Object.values(JSON.parse(v || '{}')).flat().length };
    });
    test.info().annotations.push({ type: 'observed', description: `source JPEG ${buffer.length} B (1400x1050); stored ${usage.count}/12 photos, ${usage.chars} chars in localStorage` });
    expect(usage.count).toBe(12);
  });
});

// ─── Sync semantics for images ────────────────────────────────────────────────
test.describe('image sync', () => {
  test('FM-11 a photo deleted on this device is not resurrected by a later remote document', async ({ page, isMobile }) => {
    test.fail(true, 'remote images are merged add-only by uid with no tombstones (src/App.jsx:548-556)');
    const fake = await boot(page, {
      images: { uploadedImages: { LS1: [{ uid: 'devB-1', dataUrl: `data:image/png;base64,${TINY_PNG}`, title: 'devB-photo', fileName: 'b.png' }] }, featuredImages: {}, _serverTs: 100 },
    });
    await nav(page, isMobile, /^LS1/);
    await expect(page.getByRole('img', { name: 'devB-photo' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove this image' }).click();
    await expect.poll(() => fake.imagePuts.length, { timeout: 5000 }).toBeGreaterThan(0);
    // Device B (which still holds the photo) pushes its older copy later with a newer server timestamp.
    fake.images = { uploadedImages: { LS1: [{ uid: 'devB-1', dataUrl: `data:image/png;base64,${TINY_PNG}`, title: 'devB-photo', fileName: 'b.png' }] }, featuredImages: {}, _serverTs: Date.now() + 1000 };
    await page.waitForTimeout(6500); // one 5 s poll
    await expect(page.getByRole('img', { name: 'devB-photo' })).toHaveCount(0);
  });

  test('FM-24 an unchanged shared-image document is not re-downloaded in full every 5 s', async ({ page }) => {
    test.fail(true, 'pull() always GETs /images (the whole base64 document) every 5 s; no since/ETag/If-None-Match (src/App.jsx:481-494,626)');
    const bulk = 'A'.repeat(300_000);
    const imgs = Array.from({ length: 5 }, (_, i) => ({ uid: `u${i}`, title: `p${i}`, fileName: `p${i}.jpg`, dataUrl: `data:image/jpeg;base64,${bulk}` }));
    const fake = await installFakeWorker(page, {
      images: { uploadedImages: { LS1: imgs }, featuredImages: {}, _serverTs: 50 },
      // A well-behaved client would send a version; the fake would answer 304 to it.
      imageNotModifiedWhen: (url, req) => url.searchParams.has('since') || !!req.headers()['if-none-match'],
    });
    await page.goto('/');
    await page.waitForTimeout(11500);
    const full = fake.imageGets.filter(g => !g.search && !g.inm);
    const bytes = full.reduce((a, g) => a + g.bytes, 0);
    test.info().annotations.push({ type: 'observed', description: `${full.length} full /images downloads in 11.5 s, ${(bytes / 1e6).toFixed(1)} MB for a 1.5 MB document that never changed (=> ~${(bytes / 11.5 / 1e3).toFixed(0)} kB/s/device, forever)` });
    expect(full.length).toBeLessThanOrEqual(1);
  });
});

// ─── AI generation UX ─────────────────────────────────────────────────────────
test.describe('AI generation', () => {
  test('FM-15 the "generating" state does not leak onto a different compartment', async ({ page, isMobile }) => {
    test.fail(true, 'ImageCarousel has no key={compId}; aiLoading is component state that survives compartment switches (src/App.jsx:1500,1824)');
    await boot(page, { aiDelayMs: 5000 });
    await nav(page, isMobile, /^LS1/);
    await page.getByRole('button', { name: 'Generate AI Rendering', exact: true }).click();
    await expect(page.getByText('Generating AI rendering…')).toBeVisible();
    await nav(page, isMobile, /^LS2/);
    await expect(page.getByRole('heading', { name: 'Compartment LS2', exact: true })).toBeVisible();
    await expect(page.getByText('Generating AI rendering…')).toBeHidden({ timeout: 1000 });
  });

  test('FM-16 a generated rendering is labelled Draft and is not shared until approved', async ({ page, isMobile }) => {
    test.fail(true, 'result is appended to uploadedImages as an ordinary photo titled "AI Rendering" and synced to the team immediately (src/App.jsx:742-743,684)');
    await boot(page);
    await nav(page, isMobile, /^LS1/);
    await page.getByRole('button', { name: 'Generate AI Rendering', exact: true }).click();
    await expect(page.getByRole('img', { name: 'AI Rendering' })).toBeVisible();
    await expect(page.getByText(/draft/i)).toBeVisible({ timeout: 1000 });
  });

  test('FM-16b a generated rendering is pushed to the shared team document automatically (documents behaviour)', async ({ page, isMobile }) => {
    const fake = await boot(page);
    await nav(page, isMobile, /^LS1/);
    await page.getByRole('button', { name: 'Generate AI Rendering', exact: true }).click();
    await expect(page.getByRole('img', { name: 'AI Rendering' })).toBeVisible();
    await expect.poll(() => fake.imagePuts.length, { timeout: 4000 }).toBeGreaterThan(0);
    const last = fake.imagePuts.at(-1).doc;
    expect(last.uploadedImages.LS1.map(i => i.title)).toContain('AI Rendering');
    expect(Object.keys(last.uploadedImages.LS1[0])).toEqual(expect.not.arrayContaining(['status', 'prompt', 'sourceImages']));
  });

  test('FM-17 a failed generation shows the server message and keeps the typed instructions (not a defect)', async ({ page, isMobile }) => {
    await boot(page, { aiStatus: 502 });
    await nav(page, isMobile, /^LS1/);
    await page.getByLabel('Additional AI rendering instructions').fill('Mount tools low and centered.');
    await page.getByRole('button', { name: 'Generate AI Rendering', exact: true }).click();
    await expect(page.getByText('Synthetic generation failure')).toBeVisible();
    await expect(page.getByLabel('Additional AI rendering instructions')).toHaveValue('Mount tools low and centered.');
    await expect(page.getByRole('button', { name: 'Generate AI Rendering', exact: true })).toBeEnabled();
  });

  test('FM-18 a running generation can be cancelled', async ({ page, isMobile }) => {
    test.fail(true, 'no AbortController/timeout; the overlay says "up to 60 seconds" but offers no Cancel (src/App.jsx:1886-1902,1971)');
    await boot(page, { aiDelayMs: 4000 });
    await nav(page, isMobile, /^LS1/);
    await page.getByRole('button', { name: 'Generate AI Rendering', exact: true }).click();
    await expect(page.getByText('Generating AI rendering…')).toBeVisible();
    await expect(page.getByRole('button', { name: /cancel/i })).toBeVisible({ timeout: 1000 });
  });
});

// ─── Carousel, a11y, navigation ───────────────────────────────────────────────
test.describe('carousel and navigation accessibility', () => {
  test('FM-12 carousel responds to the ArrowRight key', async ({ page, isMobile }) => {
    test.fail(true, 'no onKeyDown/touch handlers on the carousel; only buttons (src/App.jsx:1930-1944)');
    await boot(page);
    await nav(page, isMobile, /^LS2/);
    await expect(page.getByRole('img', { name: 'Compartment Photo' })).toBeVisible();
    await page.getByRole('button', { name: 'Show image 1 of 2' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('img', { name: 'Rendering with Tools' })).toBeVisible({ timeout: 1000 });
  });

  test('FM-13 the active carousel dot is exposed to assistive technology', async ({ page, isMobile }) => {
    test.fail(true, 'dot buttons carry no aria-current/aria-pressed; the carousel has no region/roledescription (src/App.jsx:1965)');
    await boot(page);
    await nav(page, isMobile, /^LS2/);
    await expect(page.getByRole('button', { name: 'Show image 1 of 2' })).toHaveAttribute('aria-current', /true|step|location/, { timeout: 1000 });
  });

  test('FM-19 a "device storage is full" warning is visible on phones without opening the menu', async ({ page, isMobile }) => {
    test.fail(isMobile, 'the alert lives only inside the off-canvas sidebar (src/App.jsx:1111); on <1024 px it is off-screen');
    await page.addInitScript(() => {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (window.__quotaFull && k.includes('uploads')) throw new DOMException('quota', 'QuotaExceededError');
        return orig.call(this, k, v);
      };
    });
    await boot(page);
    await nav(page, isMobile, /^LS1/);
    if (isMobile) await expect(page.getByRole('button', { name: 'Open navigation menu' })).toBeVisible();
    await page.evaluate(() => { window.__quotaFull = true; });
    await uploadSynthetic(page, 'quota.png');
    await expect(page.getByRole('img', { name: 'quota' })).toBeVisible();
    const alert = page.getByRole('alert').filter({ hasText: /storage is full/i });
    await expect(alert).toHaveCount(1, { timeout: 1500 });
    await page.waitForTimeout(600); // let the 300 ms drawer close transition finish
    const bb = await alert.boundingBox();
    test.info().annotations.push({ type: 'observed', description: `storage-full alert box x=${bb.x} w=${bb.width} (viewport starts at 0)` });
    expect(bb.x + bb.width).toBeGreaterThan(1);
  });

  test('FM-20 a malformed shared document does not blank the whole app', async ({ page }) => {
    test.fail(true, 'no React error boundary (src/main.jsx); customTools:{} makes `[...customTools]` throw during render and #root unmounts');
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const empty = {}; for (const id of COMP_IDS) empty[id] = Array(15).fill('');
    await installFakeWorker(page, { state: { allocations: empty, customTools: {}, _serverTs: 5 } });
    await page.goto('/');
    await page.waitForTimeout(1500);
    const text = (await page.locator('#root').innerText()).trim();
    test.info().annotations.push({ type: 'observed', description: `pageerror: ${errors[0] ?? 'none'}; #root text length: ${text.length}` });
    expect(text.length).toBeGreaterThan(0);
  });

  test('FM-21 the closed mobile navigation drawer is not keyboard-focusable', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'drawer only exists below the lg breakpoint');
    test.fail(true, 'closed drawer is only translated off-canvas + pointer-events-none; no inert/aria-hidden/visibility:hidden (src/App.jsx:1778-1786)');
    await boot(page);
    const focused = await page.evaluate(() => {
      const b = document.querySelector('#sidebar button');
      b.focus();
      return document.activeElement === b;
    });
    expect(focused).toBe(false);
  });

  test('FM-22 the open mobile drawer takes focus and closes on Escape', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'drawer only exists below the lg breakpoint');
    test.fail(true, 'no focus move, trap, Escape handler or aria-modal on the drawer');
    await boot(page);
    await page.getByRole('button', { name: 'Open navigation menu' }).click();
    await page.waitForTimeout(400);
    const focusInside = await page.evaluate(() => !!document.activeElement?.closest('#sidebar'));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const x = (await page.locator('#sidebar').boundingBox()).x;
    test.info().annotations.push({ type: 'observed', description: `focus inside drawer after open: ${focusInside}; drawer x after Escape: ${x}` });
    expect(focusInside && x < 0).toBe(true);
  });

  test('FM-34 keyboard focus in the sidebar survives an unrelated re-render', async ({ page, isMobile }) => {
    test.skip(isMobile, 'drawer is closed on small viewports; checked on desktop where the sidebar is persistent');
    test.fail(true, '`Sidebar` is declared as a component INSIDE App (src/App.jsx:1010) and rendered as <Sidebar />: a new type every render => full remount, focus/scroll lost');
    const fake = await boot(page);
    const btn = page.getByRole('button', { name: 'Inventory Status', exact: true });
    await btn.focus();
    await expect(btn).toBeFocused();
    // A teammate changes the plan: the 5 s poll applies it via setAllocations -> App re-renders.
    const next = JSON.parse(JSON.stringify(fake.state));
    next.allocations.LS1[0] = '1 Ton Griphoist';
    next._serverTs = 999;
    fake.state = next;
    await page.waitForTimeout(6500);
    const focusedLabel = await page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 30) || document.activeElement?.tagName);
    test.info().annotations.push({ type: 'observed', description: `active element after remote update: "${focusedLabel}"` });
    await expect(btn).toBeFocused();
  });

  test('FM-23 carousel icon buttons and helper text meet WCAG contrast', async ({ page, isMobile }) => {
    test.fail(true, 'star (slate-300 on white), remove X (slate-400) and "Powered by" text (indigo-400 9-10 px on indigo-50) are below 3:1 / 4.5:1');
    await boot(page);
    await nav(page, isMobile, /^LS1/);
    await uploadSynthetic(page, 'contrast.png'); // footer with star/remove only renders when there is a title or >1 image
    await expect(page.getByRole('img', { name: 'contrast' })).toBeVisible();
    const measured = await page.evaluate(() => {
      const fgOf = el => getComputedStyle(el).color;
      const bgOf = el => { for (let n = el; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (!/rgba?\(0, 0, 0, 0\)/.test(c)) return c; } return 'rgb(255,255,255)'; };
      const star = document.querySelector('button[aria-label="Set as featured image"]');
      const del = document.querySelector('button[aria-label="Remove this image"]');
      const powered = [...document.querySelectorAll('p')].find(p => p.textContent.includes('Powered by'));
      return {
        star: [fgOf(star), bgOf(star)], del: [fgOf(del), bgOf(del)],
        powered: [fgOf(powered), 'rgb(238, 242, 255)'], // panel gradient starts at Tailwind indigo-50 (computed bg is an image)
      };
    });
    const lum = c => { const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = ([f, b]) => { const [a, z] = [lum(f), lum(b)].sort((x, y) => y - x); return (a + 0.05) / (z + 0.05); };
    const r = { star: ratio(measured.star), del: ratio(measured.del), powered: ratio(measured.powered) };
    test.info().annotations.push({ type: 'observed', description: `contrast ratios: star ${r.star.toFixed(2)} (needs 3), remove ${r.del.toFixed(2)} (needs 3), powered-by text ${r.powered.toFixed(2)} (needs 4.5)` });
    expect(r.star).toBeGreaterThanOrEqual(3);
    expect(r.del).toBeGreaterThanOrEqual(3);
    expect(r.powered).toBeGreaterThanOrEqual(4.5);
  });
});

// ─── Print, export, performance ───────────────────────────────────────────────
test.describe('print, export and performance', () => {
  test('FM-26 print media prints only the current carousel image and hides upload/AI controls (documents behaviour)', async ({ page, isMobile }) => {
    await boot(page);
    await nav(page, isMobile, /^LS2/);
    await uploadSynthetic(page, 'extra.png');
    await expect(page.getByRole('img', { name: 'extra' })).toBeVisible();
    await page.emulateMedia({ media: 'print' });
    const printed = await page.locator('main img:visible').count();
    const uploadVisible = await page.getByText('Upload rendering or photo').isVisible();
    const aiVisible = await page.getByText('Generate AI Rendering').first().isVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    test.info().annotations.push({ type: 'observed', description: `3 images on LS2 (2 preset + 1 upload); images rendered in print: ${printed}; upload visible ${uploadVisible}; AI panel visible ${aiVisible}; overflow ${overflow}px` });
    expect(printed).toBe(1);
    expect(uploadVisible || aiVisible).toBe(false);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('FM-27 Excel export contains only allocations and inventory sheets (documents behaviour)', async ({ page }, testInfo) => {
    await boot(page);
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export Excel' }).click();
    const download = await dl;
    const dir = mkdtempSync(join(tmpdir(), 'l1xlsx-'));
    const file = join(dir, 'plan.xlsx');
    await download.saveAs(file);
    const wb = execFileSync('unzip', ['-p', file, 'xl/workbook.xml']).toString();
    const sheets = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map(m => m[1]);
    const shared = execFileSync('unzip', ['-p', file, 'xl/sharedStrings.xml']).toString();
    writeFileSync(join(dir, 'sheets.txt'), sheets.join('\n'));
    testInfo.annotations.push({ type: 'observed', description: `sheets: ${sheets.join(', ')}; mentions bundles: ${/bundle/i.test(shared)}; mentions photos/renderings: ${/photo|rendering/i.test(shared)}` });
    expect(sheets).toEqual(['Compartments', 'Inventory Status']);
  });

  test('FM-25 low-end phone timings with 4x CPU throttle (documents behaviour)', async ({ page, browserName }, testInfo) => {
    test.skip(browserName !== 'chromium');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const fake = await installFakeWorker(page);
    const t0 = Date.now();
    await page.goto('/');
    await expect(page.getByText('Loading L1 Compartment Builder')).toBeHidden();
    const tLoaded = Date.now() - t0;
    const nav0 = Date.now();
    if (testInfo.project.use.isMobile) await page.getByRole('button', { name: 'Open navigation menu' }).click();
    await page.getByRole('button', { name: /^LS1/ }).click();
    await expect(page.getByRole('combobox', { name: 'Equipment for slot 1', exact: true })).toBeVisible();
    const tNav = Date.now() - nav0;
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const b64 = await makeImage(page, { w: 4000, h: 3000, mode: 'photo', quality: 0.85 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const up0 = Date.now();
    await fileInput(page).setInputFiles({ name: 'big.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64') });
    await expect(page.getByRole('img', { name: 'big' })).toBeVisible({ timeout: 60000 });
    const tUpload = Date.now() - up0;
    const tasks = await cdp.send('Performance.getMetrics').catch(() => ({ metrics: [] }));
    const taskDur = tasks.metrics?.find(m => m.name === 'TaskDuration')?.value;
    testInfo.annotations.push({
      type: 'observed',
      description: `4x throttle: app ready ${tLoaded} ms, open LS1 ${tNav} ms, 4000x3000 JPEG (${Math.round(b64.length * 0.75 / 1024)} KB) upload->visible ${tUpload} ms, main-thread TaskDuration ${taskDur ? taskDur.toFixed(2) + ' s' : 'n/a'}; /images GETs ${fake.imageGets.length}`,
    });
    expect(tUpload).toBeLessThan(30000);
  });
});

function readHeadersFile() {
  return execFileSync('cat', [join(process.cwd(), 'public/_headers')]).toString();
}
