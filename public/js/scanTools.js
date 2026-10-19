// Image processing for the scanner, with no external library:
//  - detectDocument: finds the sheet of paper in a photo (four corners);
//  - warpQuad: straightens it, as if the photo had been taken from right above;
//  - enhance: removes shadows and yellow light, or turns the page into crisp black & white.
// Corners are normalised (0–1) in the photo's own orientation, in the order top-left,
// top-right, bottom-right, bottom-left.

export const FULL_QUAD = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

const sizeOf = (src) => ({ w: src.videoWidth || src.width, h: src.videoHeight || src.height });

/** Draws `src` (image, bitmap, canvas or video) so that its longest side is at most `max` pixels. */
export function downscale(src, max) {
  const { w, h } = sizeOf(src);
  const s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

// ---------- detection ----------

function boxBlur(a, w, h, r) {
  const tmp = new Float32Array(a.length);
  const out = new Float32Array(a.length);
  const size = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += a[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / size;
      sum += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / size;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

function otsu(values) {
  const hist = new Float64Array(256);
  for (const v of values) hist[Math.max(0, Math.min(255, v | 0))]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/** Grows (max) or shrinks (min) a binary mask by `r` pixels, separably. */
function morph(mask, w, h, r, grow) {
  const tmp = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);
  const pick = grow ? (a, b) => a | b : (a, b) => a & b;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = grow ? 0 : 1;
      for (let k = -r; k <= r; k++) v = pick(v, mask[y * w + Math.min(w - 1, Math.max(0, x + k))]);
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = grow ? 0 : 1;
      for (let k = -r; k <= r; k++) v = pick(v, tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]);
      out[y * w + x] = v;
    }
  }
  return out;
}

function largestComponent(mask, w, h) {
  const label = new Int32Array(mask.length);
  const stack = new Int32Array(mask.length);
  let best = { id: 0, size: 0 };
  let id = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || label[i]) continue;
    id++;
    let size = 0;
    let top = 0;
    stack[top++] = i;
    label[i] = id;
    while (top) {
      const p = stack[--top];
      size++;
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0 && mask[p - 1] && !label[p - 1]) (label[p - 1] = id), (stack[top++] = p - 1);
      if (x < w - 1 && mask[p + 1] && !label[p + 1]) (label[p + 1] = id), (stack[top++] = p + 1);
      if (y > 0 && mask[p - w] && !label[p - w]) (label[p - w] = id), (stack[top++] = p - w);
      if (y < h - 1 && mask[p + w] && !label[p + w]) (label[p + w] = id), (stack[top++] = p + w);
    }
    if (size > best.size) best = { id, size };
  }
  return { label, ...best };
}

function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i];
    const n = q[(i + 1) % 4];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** True when the four corners make a plausible sheet: convex, no very sharp or very flat corner. */
export function isGoodQuad(q, aspect = 1) {
  const pts = q.map((p) => ({ x: p.x * aspect, y: p.y }));
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[(i + 3) % 4];
    const b = pts[i];
    const c = pts[(i + 1) % 4];
    const v1 = { x: a.x - b.x, y: a.y - b.y };
    const v2 = { x: c.x - b.x, y: c.y - b.y };
    const cross = v1.x * v2.y - v1.y * v2.x;
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign && s !== sign) return false;
    sign = s;
    const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y));
    const angle = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    if (angle < 40 || angle > 140) return false;
  }
  return true;
}

/**
 * Finds the sheet of paper in a photo. Paper is bright and colourless, so each pixel is scored on
 * brightness minus colourfulness; the largest bright region is the sheet, and its four extreme
 * points are its corners. Returns the corners, or null when nothing convincing is found.
 */
export function detectDocument(src) {
  const c = downscale(src, 420);
  const w = c.width;
  const h = c.height;
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const score = new Float32Array(w * h);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    score[j] = Math.max(0, lum - 0.7 * sat);
  }
  const smooth = boxBlur(boxBlur(score, w, h, 2), w, h, 2);
  const t = otsu(smooth);
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = smooth[i] > t ? 1 : 0;
  // Close the holes left by the writing, then detach the sheet from small bright spots.
  mask = morph(morph(mask, w, h, 3, true), w, h, 3, false);
  mask = morph(morph(mask, w, h, 2, false), w, h, 2, true);
  const { label, id, size } = largestComponent(mask, w, h);
  const ratio = size / (w * h);
  if (!id || ratio < 0.12) return null;
  if (ratio > 0.93) return FULL_QUAD.map((p) => ({ ...p }));

  let tl, tr, br, bl;
  let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;
  for (let i = 0; i < label.length; i++) {
    if (label[i] !== id) continue;
    const x = i % w;
    const y = (i - x) / w;
    const s = x + y;
    const df = x - y;
    if (s < minSum) (minSum = s), (tl = { x, y });
    if (s > maxSum) (maxSum = s), (br = { x, y });
    if (df > maxDiff) (maxDiff = df), (tr = { x, y });
    if (df < minDiff) (minDiff = df), (bl = { x, y });
  }
  // Pixel centres → edges, then normalise.
  const q = [tl, tr, br, bl].map((p) => ({ x: Math.min(1, Math.max(0, (p.x + 0.5) / w)), y: Math.min(1, Math.max(0, (p.y + 0.5) / h)) }));
  if (quadArea(q) < 0.1 || !isGoodQuad(q, w / h)) return null;
  return q;
}

// ---------- perspective ----------

/** Solves the 8 unknowns of the homography mapping the unit square's corners to `dst`. */
function homography(from, to) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let k = col; k < 8; k++) A[r][k] -= f * A[col][k];
      b[r] -= f * b[col];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Size (in source pixels) of the straightened sheet. */
export function quadSize(quad, srcW, srcH) {
  const p = quad.map((q) => ({ x: q.x * srcW, y: q.y * srcH }));
  return {
    w: Math.max(dist(p[0], p[1]), dist(p[3], p[2])),
    h: Math.max(dist(p[0], p[3]), dist(p[1], p[2])),
  };
}

/**
 * Straightens the region inside `quad` into a rectangle whose longest side is at most `maxDim`.
 * Every output pixel is looked up in the photo (bilinear), so the result stays sharp.
 */
export function warpQuad(src, quad, maxDim) {
  const full = sizeOf(src);
  const size = quadSize(quad, full.w, full.h);
  const scale = Math.min(1, maxDim / Math.max(size.w, size.h));
  const outW = Math.max(1, Math.round(size.w * scale));
  const outH = Math.max(1, Math.round(size.h * scale));
  // Read the photo at about the resolution needed, never more: fast for thumbnails, sharp for the PDF.
  const need = Math.max(full.w, full.h) * Math.min(1, (scale * 1.4));
  const s = downscale(src, Math.max(64, need));
  const sw = s.width;
  const sh = s.height;
  const sd = s.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
  const H = homography(
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    quad.map((q) => ({ x: q.x * (sw - 1), y: q.y * (sh - 1) }))
  );
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const octx = out.getContext('2d');
  const img = octx.createImageData(outW, outH);
  const od = img.data;
  for (let y = 0; y < outH; y++) {
    const v = outH > 1 ? y / (outH - 1) : 0;
    for (let x = 0; x < outW; x++) {
      const u = outW > 1 ? x / (outW - 1) : 0;
      const den = H[6] * u + H[7] * v + 1;
      let sx = (H[0] * u + H[1] * v + H[2]) / den;
      let sy = (H[3] * u + H[4] * v + H[5]) / den;
      sx = Math.min(sw - 1.001, Math.max(0, sx));
      sy = Math.min(sh - 1.001, Math.max(0, sy));
      const x0 = sx | 0;
      const y0 = sy | 0;
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + sw * 4;
      const i11 = i01 + 4;
      const o = (y * outW + x) * 4;
      for (let k = 0; k < 3; k++) {
        const top = sd[i00 + k] + (sd[i10 + k] - sd[i00 + k]) * fx;
        const bot = sd[i01 + k] + (sd[i11 + k] - sd[i01 + k]) * fx;
        od[o + k] = top + (bot - top) * fy;
      }
      od[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

// ---------- enhancement ----------

/**
 * Estimates the paper's brightness everywhere on the page (the light, shadows, yellow tint), by
 * keeping the brightest pixels of each small area and smoothing them. Returns a lookup function.
 */
function paperLight(lum, w, h) {
  const step = Math.max(4, Math.round(Math.max(w, h) / 90));
  const bw = Math.ceil(w / step);
  const bh = Math.ceil(h / step);
  const small = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let max = 0;
      for (let y = by * step; y < Math.min(h, (by + 1) * step); y += 2) {
        for (let x = bx * step; x < Math.min(w, (bx + 1) * step); x += 2) max = Math.max(max, lum[y * w + x]);
      }
      small[by * bw + bx] = max;
    }
  }
  // A wider maximum skips over thick writing and stamps, then the blur smooths the light out.
  let grown = new Float32Array(small.length);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let max = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const yy = Math.min(bh - 1, Math.max(0, by + dy));
          const xx = Math.min(bw - 1, Math.max(0, bx + dx));
          max = Math.max(max, small[yy * bw + xx]);
        }
      grown[by * bw + bx] = max;
    }
  }
  grown = boxBlur(boxBlur(grown, bw, bh, 2), bw, bh, 2);
  return (x, y) => {
    const fx = Math.min(bw - 1, Math.max(0, x / step - 0.5));
    const fy = Math.min(bh - 1, Math.max(0, y / step - 0.5));
    const x0 = fx | 0;
    const y0 = fy | 0;
    const x1 = Math.min(bw - 1, x0 + 1);
    const y1 = Math.min(bh - 1, y0 + 1);
    const ax = fx - x0;
    const ay = fy - y0;
    const top = grown[y0 * bw + x0] + (grown[y0 * bw + x1] - grown[y0 * bw + x0]) * ax;
    const bot = grown[y1 * bw + x0] + (grown[y1 * bw + x1] - grown[y1 * bw + x0]) * ax;
    return top + (bot - top) * ay;
  };
}

/**
 * 'clean': white paper without shadows, ink darker, colours kept (blue stamps, signatures);
 * 'bw': crisp black & white, best for text-only pages.
 */
export function enhance(canvas, mode) {
  if (mode === 'original') return canvas;
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const lum = new Float32Array(w * h);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) lum[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const light = paperLight(lum, w, h);

  if (mode === 'bw') {
    const norm = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) norm[y * w + x] = Math.min(255, (lum[y * w + x] * 255) / Math.max(30, light(x, y)));
    // Paper is now ~255 everywhere: the threshold sits between ink and paper.
    const t = Math.min(225, Math.max(150, otsu(norm) + 12));
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const v = Math.max(0, Math.min(255, ((norm[j] - (t - 18)) * 255) / 36));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  } else {
    // Paper to pure white, ink a little deeper.
    const curve = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) curve[v] = v / 255 > 0.9 ? 255 : Math.pow(v / 255 / 0.9, 1.35) * 255;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const k = 255 / Math.max(30, light(x, y));
        d[i] = curve[Math.min(255, d[i] * k) | 0];
        d[i + 1] = curve[Math.min(255, d[i + 1] * k) | 0];
        d[i + 2] = curve[Math.min(255, d[i + 2] * k) | 0];
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Rotates a canvas by 0, 90, 180 or 270 degrees clockwise. */
export function rotateCanvas(canvas, rot) {
  rot = ((rot % 360) + 360) % 360;
  if (!rot) return canvas;
  const out = document.createElement('canvas');
  out.width = rot % 180 ? canvas.height : canvas.width;
  out.height = rot % 180 ? canvas.width : canvas.height;
  const ctx = out.getContext('2d');
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

/** Display ↔ photo coordinates for a page shown rotated by `rot` degrees clockwise. */
export function toDisplay(p, rot) {
  rot = ((rot % 360) + 360) % 360;
  if (rot === 90) return { x: 1 - p.y, y: p.x };
  if (rot === 180) return { x: 1 - p.x, y: 1 - p.y };
  if (rot === 270) return { x: p.y, y: 1 - p.x };
  return { ...p };
}
export function fromDisplay(p, rot) {
  rot = ((rot % 360) + 360) % 360;
  if (rot === 90) return { x: p.y, y: 1 - p.x };
  if (rot === 180) return { x: 1 - p.x, y: 1 - p.y };
  if (rot === 270) return { x: 1 - p.y, y: p.x };
  return { ...p };
}
