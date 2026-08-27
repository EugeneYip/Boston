import * as THREE from 'three';
import { RNG, canvas2d, texFromCanvas, fbm, normalFromHeight } from './StreetFurniture.js';

/**
 * Decals — oil, skid marks, cracks, patches, gutter debris, puddles, road paint,
 * wall grime, rust runs, posters and graffiti.
 *
 * The cheapest realism in the whole project. A clean, uniform road surface is a
 * dead giveaway; ten thousand two-triangle decals fix it for about 20k triangles
 * and 17 draw calls.
 *
 * Z-FIGHTING: an automatic fail, so this uses belt and braces.
 *  - every decal is offset along the receiving surface normal (12mm on the road,
 *    20mm on a wall), which is under the depth resolution of the near plane but
 *    well above the far-field depth quantisation at this scale;
 *  - every decal material sets polygonOffset with a negative factor AND units, so
 *    the rasteriser biases the fragment towards the camera by a slope-scaled
 *    amount — this is what actually kills flicker at grazing angles;
 *  - depthWrite is off and the materials are in the transparent queue, so decals
 *    can never fight each other either.
 *
 * Grime and wear use MULTIPLY blending against an unlit basic material: the decal
 * darkens whatever the surface already resolved to, so the asphalt grain and the
 * lighting still read through it. Painting a lit, opaque grey blob on top instead
 * is the thing that makes decals look like stickers.
 */

const ATLAS = 1024;
const CELL = 256;

/** Atlas cell index -> pixel rect. 4x4 grid. */
const cellRect = (i) => [(i % 4) * CELL, ((i / 4) | 0) * CELL, CELL, CELL];

/** UV rect for a cell with a half-texel inset. */
function cellUV(i) {
  const [x, y, w, h] = cellRect(i);
  const e = 1.0;
  return [(x + e) / ATLAS, 1 - (y + h - e) / ATLAS, (x + w - e) / ATLAS, 1 - (y + e) / ATLAS];
}

/** A single quad with atlas UVs. `vertical` builds it in XY facing +Z. */
function quad(w, h, cell, vertical) {
  const [u0, v0, u1, v1] = cellUV(cell);
  const x = w / 2, y = h / 2;
  const g = new THREE.BufferGeometry();
  const pos = vertical
    ? [-x, -y, 0, x, -y, 0, x, y, 0, -x, -y, 0, x, y, 0, -x, y, 0]
    : [-x, 0, y, x, 0, y, x, 0, -y, -x, 0, y, x, 0, -y, -x, 0, -y];
  const n = vertical ? [0, 0, 1] : [0, 1, 0];
  const nor = [];
  for (let i = 0; i < 6; i++) nor.push(...n);
  const uv = [u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1];
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeBoundingSphere();
  g.clearGroups();
  g.addGroup(0, 6, 0);
  return g;
}

// --- Stain atlas cells (multiply; white = no change) -----------------------
const S = {
  oil: 0, skid: 1, crack: 2, patch: 3,
  gutter: 4, grimeWall: 5, rustWall: 6, waterWall: 7,
  tarSeam: 8, ringStain: 9, gumSpots: 10, wearStrip: 11,
};
// --- Paint atlas cells (RGBA, normal blend) --------------------------------
const P = {
  crosswalk: 0, stopBar: 1, arrow: 2, poster: 3,
  graffiti: 4, stickers: 5, leaves: 6, salt: 7,
  chalk: 8, flyers: 9, paintFaded: 10, puddle: 11,
};

// ---------------------------------------------------------------------------
// Atlas painting
// ---------------------------------------------------------------------------

function softBlob(c, x, y, r, rgba, jitter, rng) {
  c.save();
  c.beginPath();
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (1 + (rng.f() - 0.5) * jitter);
    const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr * 0.86;
    i === 0 ? c.moveTo(px, py) : c.lineTo(px, py);
  }
  c.closePath();
  c.fillStyle = rgba;
  c.fill();
  c.restore();
}

function drawOil(c, ox, oy, rng) {
  // Old drips build a dark core with a wide, ragged halo. Slight blue-green
  // iridescence at the edge: motor oil on wet asphalt really does that.
  for (let i = 0; i < 5; i++) {
    softBlob(c, ox + CELL / 2 + rng.range(-24, 24), oy + CELL / 2 + rng.range(-40, 40),
      rng.range(26, 62), `rgba(46,42,38,${rng.range(0.06, 0.13)})`, 0.55, rng);
  }
  softBlob(c, ox + CELL / 2, oy + CELL / 2, rng.range(22, 34), 'rgba(24,22,20,0.42)', 0.5, rng);
  softBlob(c, ox + CELL / 2 + 6, oy + CELL / 2 - 8, 14, 'rgba(16,15,14,0.55)', 0.4, rng);
  for (let i = 0; i < 22; i++) {
    softBlob(c, ox + CELL / 2 + rng.range(-70, 70), oy + CELL / 2 + rng.range(-90, 90),
      rng.range(2, 7), `rgba(30,28,26,${rng.range(0.15, 0.45)})`, 0.6, rng);
  }
  softBlob(c, ox + CELL / 2 - 10, oy + CELL / 2 + 12, 18, 'rgba(60,74,66,0.12)', 0.5, rng);
}

function drawSkid(c, ox, oy, rng) {
  for (const lane of [-38, 38]) {
    c.save();
    c.beginPath(); c.rect(ox, oy, CELL, CELL); c.clip();
    for (let i = 0; i < 130; i++) {
      const t = i / 130;
      const w = 26 * (1 - t * 0.35);
      const a = 0.30 * (1 - t) * (0.4 + rng.f() * 0.6);
      c.fillStyle = `rgba(22,21,20,${a.toFixed(3)})`;
      c.fillRect(ox + CELL / 2 + lane + rng.range(-4, 4) - w / 2, oy + t * CELL, w, 3.4);
    }
    c.restore();
  }
}

function drawCracks(c, ox, oy, rng) {
  c.save();
  c.beginPath(); c.rect(ox, oy, CELL, CELL); c.clip();
  const walk = (x, y, depth) => {
    if (depth > 4) return;
    let a = rng.range(0, Math.PI * 2);
    let px = x, py = y;
    const steps = 8 + rng.int(14);
    for (let i = 0; i < steps; i++) {
      a += rng.range(-0.55, 0.55);
      const l = rng.range(5, 15);
      const nx = px + Math.cos(a) * l, ny = py + Math.sin(a) * l;
      c.strokeStyle = `rgba(34,32,30,${(0.55 - depth * 0.09).toFixed(3)})`;
      c.lineWidth = Math.max(0.7, 2.6 - depth * 0.5);
      c.beginPath(); c.moveTo(px, py); c.lineTo(nx, ny); c.stroke();
      // A crack has a light shoulder where the aggregate is exposed.
      c.strokeStyle = 'rgba(196,192,186,0.10)';
      c.lineWidth = 3.2;
      c.beginPath(); c.moveTo(px + 1.4, py + 1.4); c.lineTo(nx + 1.4, ny + 1.4); c.stroke();
      px = nx; py = ny;
      if (rng.chance(0.13)) walk(px, py, depth + 1);
    }
  };
  for (let i = 0; i < 3; i++) walk(ox + rng.range(20, CELL - 20), oy + rng.range(20, CELL - 20), 0);
  c.restore();
}

function drawPatch(c, ox, oy, rng) {
  // A cut-and-fill utility patch: darker fresh asphalt, tar-sealed edges.
  const m = 26;
  const x0 = ox + m + rng.range(-8, 8), y0 = oy + m + rng.range(-8, 8);
  const w = CELL - m * 2 + rng.range(-10, 10), h = CELL - m * 2 + rng.range(-10, 10);
  c.fillStyle = 'rgba(58,56,54,0.30)';
  c.fillRect(x0, y0, w, h);
  c.strokeStyle = 'rgba(28,27,26,0.62)';
  c.lineWidth = 7;
  c.beginPath();
  c.moveTo(x0, y0);
  for (let i = 0; i <= 3; i++) {
    const pts = [[x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h], [x0, y0]][i];
    c.lineTo(pts[0] + rng.range(-4, 4), pts[1] + rng.range(-4, 4));
  }
  c.stroke();
  for (let i = 0; i < 26; i++) {
    softBlob(c, x0 + rng.f() * w, y0 + rng.f() * h, rng.range(3, 10),
      `rgba(40,38,36,${rng.range(0.06, 0.2)})`, 0.6, rng);
  }
}

function drawGutter(c, ox, oy, rng) {
  // Silt, grit and leaf litter shadow banked along a kerb line.
  c.save();
  c.beginPath(); c.rect(ox, oy, CELL, CELL); c.clip();
  const grad = c.createLinearGradient(ox, 0, ox + CELL, 0);
  grad.addColorStop(0, 'rgba(52,48,42,0.42)');
  grad.addColorStop(0.45, 'rgba(74,70,62,0.16)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = grad; c.fillRect(ox, oy, CELL, CELL);
  for (let i = 0; i < 260; i++) {
    const x = ox + Math.pow(rng.f(), 2.1) * CELL;
    c.fillStyle = `rgba(${40 + rng.int(40)},${36 + rng.int(34)},${28 + rng.int(26)},${rng.range(0.1, 0.4)})`;
    c.fillRect(x, oy + rng.f() * CELL, rng.range(1, 5), rng.range(1, 4));
  }
  c.restore();
}

function drawStreak(c, ox, oy, rng, tint, spread) {
  // Vertical wash under a sill or a rust run off a fixing.
  c.save();
  c.beginPath(); c.rect(ox, oy, CELL, CELL); c.clip();
  for (let i = 0; i < 70; i++) {
    const x = ox + CELL / 2 + (rng.f() - 0.5) * CELL * spread;
    const w = rng.range(1.5, 11);
    const top = oy + rng.range(0, CELL * 0.25);
    const len = rng.range(CELL * 0.3, CELL * 0.95);
    const g = c.createLinearGradient(0, top, 0, top + len);
    g.addColorStop(0, `rgba(${tint},${rng.range(0.18, 0.42).toFixed(3)})`);
    g.addColorStop(0.7, `rgba(${tint},${rng.range(0.06, 0.18).toFixed(3)})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(x, top, w, len);
  }
  c.restore();
}

function drawWaterStain(c, ox, oy, rng) {
  c.save();
  c.beginPath(); c.rect(ox, oy, CELL, CELL); c.clip();
  for (let i = 0; i < 16; i++) {
    softBlob(c, ox + rng.f() * CELL, oy + rng.range(0, CELL * 0.7), rng.range(30, 90),
      `rgba(56,54,50,${rng.range(0.04, 0.11)})`, 0.7, rng);
  }
  drawStreak(c, ox, oy, rng, '48,46,42', 0.95);
  c.restore();
}

function drawTarSeam(c, ox, oy, rng) {
  c.save();
  c.beginPath(); c.rect(ox, oy, CELL, CELL); c.clip();
  let x = ox + CELL / 2;
  c.strokeStyle = 'rgba(26,25,24,0.66)';
  c.lineWidth = 9;
  c.lineJoin = 'round';
  c.beginPath();
  c.moveTo(x, oy);
  for (let y = 0; y <= CELL; y += 16) {
    x += rng.range(-9, 9);
    c.lineTo(x, oy + y);
  }
  c.stroke();
  c.strokeStyle = 'rgba(22,21,20,0.34)';
  c.lineWidth = 17;
  c.stroke();
  c.restore();
}

function drawRing(c, ox, oy, rng) {
  const cx = ox + CELL / 2, cy = oy + CELL / 2;
  for (let i = 0; i < 4; i++) {
    c.strokeStyle = `rgba(48,44,40,${rng.range(0.1, 0.26)})`;
    c.lineWidth = rng.range(4, 16);
    c.beginPath(); c.arc(cx, cy, 78 + rng.range(-8, 14), 0, 6.2832); c.stroke();
  }
  for (let i = 0; i < 40; i++) {
    softBlob(c, cx + rng.range(-100, 100), cy + rng.range(-100, 100), rng.range(3, 12),
      `rgba(44,41,38,${rng.range(0.05, 0.18)})`, 0.6, rng);
  }
}

function drawGum(c, ox, oy, rng) {
  for (let i = 0; i < 46; i++) {
    const x = ox + rng.f() * CELL, y = oy + rng.f() * CELL;
    softBlob(c, x, y, rng.range(3, 9), `rgba(70,66,60,${rng.range(0.16, 0.42)})`, 0.35, rng);
    softBlob(c, x, y, rng.range(1.5, 4), `rgba(120,116,110,${rng.range(0.1, 0.3)})`, 0.4, rng);
  }
}

function drawWear(c, ox, oy, rng) {
  // Polished wheel path: lighter centre, darker between the wheels.
  const g = c.createLinearGradient(ox, 0, ox + CELL, 0);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, 'rgba(66,64,60,0.22)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g; c.fillRect(ox, oy, CELL, CELL);
  for (let i = 0; i < 90; i++) {
    c.fillStyle = `rgba(52,50,47,${rng.range(0.03, 0.12)})`;
    c.fillRect(ox + rng.f() * CELL, oy + rng.f() * CELL, rng.range(6, 60), rng.range(1, 3));
  }
}

function makeStainAtlas() {
  const { canvas, ctx: c } = canvas2d(ATLAS, ATLAS);
  c.fillStyle = '#ffffff'; c.fillRect(0, 0, ATLAS, ATLAS);
  const rng = new RNG(20260826);
  const draw = { };
  draw[S.oil] = drawOil; draw[S.skid] = drawSkid; draw[S.crack] = drawCracks;
  draw[S.patch] = drawPatch; draw[S.gutter] = drawGutter;
  draw[S.grimeWall] = (cc, x, y, r) => drawStreak(cc, x, y, r, '42,40,36', 1.0);
  draw[S.rustWall] = (cc, x, y, r) => drawStreak(cc, x, y, r, '128,66,28', 0.55);
  draw[S.waterWall] = drawWaterStain;
  draw[S.tarSeam] = drawTarSeam; draw[S.ringStain] = drawRing;
  draw[S.gumSpots] = drawGum; draw[S.wearStrip] = drawWear;
  for (const k of Object.keys(draw)) {
    const [x, y] = cellRect(+k);
    draw[k](c, x, y, rng);
  }
  return canvas;
}

// --- Paint atlas ------------------------------------------------------------

function fadedEdge(c, ox, oy, rng, amount = 0.55) {
  // Chew the paint back so nothing looks freshly masked off.
  c.save();
  c.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 320; i++) {
    c.fillStyle = `rgba(0,0,0,${rng.range(0.15, amount)})`;
    const r = rng.range(1.5, 9);
    c.beginPath();
    c.arc(ox + rng.f() * CELL, oy + rng.f() * CELL, r, 0, 6.2832);
    c.fill();
  }
  c.restore();
}

function drawCrosswalk(c, ox, oy, rng) {
  // Continental ("zebra") bars, the Boston standard at signalised crossings.
  for (let i = 0; i < 6; i++) {
    c.fillStyle = 'rgba(226,223,212,0.86)';
    c.fillRect(ox + 10 + i * 40, oy + 14, 26, CELL - 28);
  }
  fadedEdge(c, ox, oy, rng, 0.5);
}

function drawStopBar(c, ox, oy, rng) {
  c.fillStyle = 'rgba(226,223,212,0.88)';
  c.fillRect(ox + 6, oy + CELL * 0.36, CELL - 12, CELL * 0.28);
  fadedEdge(c, ox, oy, rng, 0.45);
}

function drawArrow(c, ox, oy, rng) {
  c.fillStyle = 'rgba(226,223,212,0.86)';
  c.fillRect(ox + CELL / 2 - 16, oy + CELL * 0.34, 32, CELL * 0.58);
  c.beginPath();
  c.moveTo(ox + CELL / 2, oy + 18);
  c.lineTo(ox + CELL / 2 - 52, oy + CELL * 0.40);
  c.lineTo(ox + CELL / 2 + 52, oy + CELL * 0.40);
  c.closePath(); c.fill();
  fadedEdge(c, ox, oy, rng, 0.5);
}

function drawPoster(c, ox, oy, rng) {
  const cols = ['#c8412f', '#e0b23a', '#2c5f8a', '#d8d3c4', '#3d7a52', '#1d1f21'];
  for (let k = 0; k < 3; k++) {
    const w = rng.range(72, 118), h = rng.range(96, 150);
    const x = ox + rng.range(6, CELL - w - 6), y = oy + rng.range(6, CELL - h - 6);
    c.save();
    c.translate(x + w / 2, y + h / 2); c.rotate(rng.range(-0.1, 0.1));
    c.fillStyle = rng.pick(cols); c.fillRect(-w / 2, -h / 2, w, h);
    c.fillStyle = 'rgba(240,236,226,0.9)';
    c.fillRect(-w / 2 + 8, -h / 2 + 10, w - 16, h * 0.32);
    c.fillStyle = 'rgba(20,20,22,0.75)';
    for (let i = 0; i < 5; i++) c.fillRect(-w / 2 + 10, h * 0.02 + i * 11, (w - 20) * rng.range(0.4, 1), 5);
    // Torn corner + rain damage
    c.globalCompositeOperation = 'destination-out';
    c.beginPath();
    c.moveTo(w / 2, -h / 2); c.lineTo(w / 2 - rng.range(12, 40), -h / 2);
    c.lineTo(w / 2, -h / 2 + rng.range(12, 44)); c.closePath(); c.fill();
    c.restore();
  }
  fadedEdge(c, ox, oy, rng, 0.28);
}

function drawGraffiti(c, ox, oy, rng) {
  const cols = ['#d63b2f', '#2f7fd6', '#e0c02f', '#d9d5cc', '#2fd67f', '#7b3fd6'];
  c.save();
  c.beginPath(); c.rect(ox, oy, CELL, CELL); c.clip();
  c.lineCap = 'round'; c.lineJoin = 'round';
  for (let tag = 0; tag < 2; tag++) {
    const col = rng.pick(cols);
    const y0 = oy + CELL * (0.3 + tag * 0.36);
    let x = ox + rng.range(10, 40), y = y0;
    c.strokeStyle = col; c.lineWidth = rng.range(7, 14);
    c.beginPath(); c.moveTo(x, y);
    for (let i = 0; i < 9; i++) {
      const cx = x + rng.range(12, 30), cy = y + rng.range(-42, 42);
      x = cx + rng.range(10, 24); y = y0 + rng.range(-16, 16);
      c.quadraticCurveTo(cx, cy, x, y);
    }
    c.stroke();
    c.strokeStyle = 'rgba(18,18,20,0.55)'; c.lineWidth = 3;
    c.stroke();
    // Overspray
    for (let i = 0; i < 90; i++) {
      c.fillStyle = col;
      c.globalAlpha = rng.range(0.05, 0.25);
      c.beginPath();
      c.arc(ox + rng.f() * CELL, y0 + rng.range(-46, 46), rng.range(0.8, 3), 0, 6.2832);
      c.fill();
    }
    c.globalAlpha = 1;
  }
  c.restore();
  fadedEdge(c, ox, oy, rng, 0.2);
}

function drawStickers(c, ox, oy, rng) {
  const cols = ['#e8532e', '#f0d02e', '#2e8ae8', '#e8e4d6', '#2ee88a', '#151515'];
  for (let i = 0; i < 16; i++) {
    const w = rng.range(26, 60), h = rng.range(20, 44);
    c.save();
    c.translate(ox + rng.range(10, CELL - 40), oy + rng.range(10, CELL - 40));
    c.rotate(rng.range(-0.5, 0.5));
    c.fillStyle = rng.pick(cols); c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(20,20,20,0.6)';
    c.fillRect(4, h * 0.3, w * rng.range(0.4, 0.85), Math.max(3, h * 0.16));
    c.restore();
  }
  fadedEdge(c, ox, oy, rng, 0.35);
}

function drawLeaves(c, ox, oy, rng) {
  const cols = ['#8a5a22', '#a8762c', '#6d4a1f', '#b0892f', '#5d3f1c', '#93331c'];
  for (let i = 0; i < 150; i++) {
    const w = rng.range(6, 17);
    c.save();
    c.translate(ox + rng.f() * CELL, oy + rng.f() * CELL);
    c.rotate(rng.range(0, 6.28));
    c.fillStyle = rng.pick(cols);
    c.globalAlpha = rng.range(0.5, 0.95);
    c.beginPath();
    c.ellipse(0, 0, w, w * rng.range(0.4, 0.7), 0, 0, 6.2832);
    c.fill();
    c.restore();
  }
  c.globalAlpha = 1;
}

function drawSalt(c, ox, oy, rng) {
  for (let i = 0; i < 30; i++) {
    c.save();
    c.globalAlpha = rng.range(0.05, 0.2);
    c.fillStyle = '#e8e6df';
    c.beginPath();
    c.ellipse(ox + rng.f() * CELL, oy + rng.f() * CELL,
      rng.range(20, 70), rng.range(14, 48), rng.range(0, 3), 0, 6.2832);
    c.fill();
    c.restore();
  }
  for (let i = 0; i < 500; i++) {
    c.fillStyle = `rgba(238,236,228,${rng.range(0.15, 0.6)})`;
    c.fillRect(ox + rng.f() * CELL, oy + rng.f() * CELL, rng.range(0.8, 2.4), rng.range(0.8, 2.4));
  }
  fadedEdge(c, ox, oy, rng, 0.4);
}

function drawChalk(c, ox, oy, rng) {
  const cols = ['#e8a0b8', '#a8d0e8', '#e8e0a0', '#b8e8a8'];
  c.save();
  c.lineCap = 'round';
  for (let i = 0; i < 7; i++) {
    c.strokeStyle = rng.pick(cols);
    c.globalAlpha = rng.range(0.25, 0.6);
    c.lineWidth = rng.range(4, 10);
    c.beginPath();
    let x = ox + rng.f() * CELL, y = oy + rng.f() * CELL;
    c.moveTo(x, y);
    for (let k = 0; k < 5; k++) {
      x += rng.range(-60, 60); y += rng.range(-60, 60);
      c.lineTo(x, y);
    }
    c.stroke();
  }
  c.restore();
  fadedEdge(c, ox, oy, rng, 0.5);
}

function drawFlyers(c, ox, oy, rng) {
  for (let i = 0; i < 9; i++) {
    const w = rng.range(40, 74), h = rng.range(54, 88);
    c.save();
    c.translate(ox + rng.range(4, CELL - w), oy + rng.range(4, CELL - h));
    c.rotate(rng.range(-0.14, 0.14));
    c.fillStyle = `rgba(${226 + rng.int(20)},${222 + rng.int(20)},${208 + rng.int(24)},0.94)`;
    c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(30,30,34,0.7)';
    for (let k = 0; k < 6; k++) c.fillRect(5, 8 + k * 9, (w - 10) * rng.range(0.3, 1), 3.5);
    // Tear-off tabs at the bottom
    for (let k = 0; k < 6; k++) {
      c.strokeStyle = 'rgba(60,60,64,0.5)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(4 + k * (w - 8) / 6, h - 18); c.lineTo(4 + k * (w - 8) / 6, h); c.stroke();
    }
    c.restore();
  }
  fadedEdge(c, ox, oy, rng, 0.3);
}

function drawFadedPaint(c, ox, oy, rng) {
  c.fillStyle = 'rgba(214,196,96,0.62)';
  c.fillRect(ox + CELL * 0.30, oy, CELL * 0.12, CELL);
  c.fillRect(ox + CELL * 0.56, oy, CELL * 0.12, CELL);
  fadedEdge(c, ox, oy, rng, 0.75);
}

function drawPuddleMask(c, ox, oy, rng) {
  c.save();
  c.beginPath(); c.rect(ox, oy, CELL, CELL); c.clip();
  c.fillStyle = 'rgba(255,255,255,1)';
  softBlob(c, ox + CELL / 2, oy + CELL / 2, CELL * 0.36, 'rgba(255,255,255,1)', 0.5, rng);
  for (let i = 0; i < 7; i++) {
    softBlob(c, ox + CELL / 2 + rng.range(-70, 70), oy + CELL / 2 + rng.range(-80, 80),
      rng.range(16, 52), 'rgba(255,255,255,1)', 0.6, rng);
  }
  c.restore();
}

function makePaintAtlas() {
  const { canvas, ctx: c } = canvas2d(ATLAS, ATLAS);
  c.clearRect(0, 0, ATLAS, ATLAS);
  const rng = new RNG(31415926);
  const draw = {};
  draw[P.crosswalk] = drawCrosswalk; draw[P.stopBar] = drawStopBar;
  draw[P.arrow] = drawArrow; draw[P.poster] = drawPoster;
  draw[P.graffiti] = drawGraffiti; draw[P.stickers] = drawStickers;
  draw[P.leaves] = drawLeaves; draw[P.salt] = drawSalt;
  draw[P.chalk] = drawChalk; draw[P.flyers] = drawFlyers;
  draw[P.paintFaded] = drawFadedPaint; draw[P.puddle] = drawPuddleMask;
  for (const k of Object.keys(draw)) {
    const [x, y] = cellRect(+k);
    draw[k](c, x, y, rng);
  }
  return canvas;
}

// ---------------------------------------------------------------------------

/** Per-type decal spec: [atlas, cell, width, height, vertical, cullDist]. */
const TYPES = {
  oil: ['stain', S.oil, 1.30, 2.40, false, 130],
  skid: ['stain', S.skid, 1.90, 5.60, false, 150],
  crack: ['stain', S.crack, 3.20, 3.20, false, 140],
  patch: ['stain', S.patch, 2.60, 3.40, false, 170],
  gutter: ['stain', S.gutter, 1.10, 3.20, false, 120],
  tarSeam: ['stain', S.tarSeam, 1.20, 6.00, false, 150],
  ringStain: ['stain', S.ringStain, 1.60, 1.60, false, 100],
  gumSpots: ['stain', S.gumSpots, 2.20, 2.20, false, 80],
  wearStrip: ['stain', S.wearStrip, 2.60, 12.0, false, 220],
  grimeWall: ['stain', S.grimeWall, 1.00, 2.60, true, 130],
  rustWall: ['stain', S.rustWall, 0.42, 1.70, true, 90],
  waterWall: ['stain', S.waterWall, 1.80, 3.20, true, 150],
  crosswalk: ['paint', P.crosswalk, 4.20, 5.80, false, 200],
  stopBar: ['paint', P.stopBar, 7.00, 0.90, false, 180],
  arrow: ['paint', P.arrow, 1.50, 4.20, false, 170],
  paintFaded: ['paint', P.paintFaded, 1.10, 7.00, false, 190],
  leaves: ['paint', P.leaves, 1.70, 2.60, false, 110],
  salt: ['paint', P.salt, 2.20, 2.20, false, 110],
  chalk: ['paint', P.chalk, 1.60, 1.60, false, 70],
  poster: ['paint', P.poster, 0.85, 1.15, true, 110],
  flyers: ['paint', P.flyers, 0.70, 0.90, true, 90],
  graffiti: ['paint', P.graffiti, 1.80, 1.30, true, 130],
  stickers: ['paint', P.stickers, 0.34, 0.34, true, 55],
  puddle: ['puddle', P.puddle, 2.60, 3.60, false, 150],
};

export default class Decals {
  constructor() {
    this.batchNames = [];
    this.materials = null;
    this._weather = 'clear';
    this._counts = {};
  }

  _materials(ctx) {
    if (this.materials) return this.materials;
    const A = ctx.assets;
    const anis = A._anis || 8;
    const stainTex = A.texture('decal_stain', () => {
      const t = texFromCanvas(makeStainAtlas(), true, false);
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = anis; return t;
    });
    const paintTex = A.texture('decal_paint', () => {
      const t = texFromCanvas(makePaintAtlas(), true, false);
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = anis; return t;
    });
    const rippleTex = A.texture('decal_ripple', () => {
      const h = fbm(256, 1717, 4, 10, 0.55);
      const t = texFromCanvas(normalFromHeight(h, 256, 0.55), false);
      t.anisotropy = anis; return t;
    });

    const off = (m) => {
      m.polygonOffset = true;
      m.polygonOffsetFactor = -4;
      m.polygonOffsetUnits = -8;
      m.depthWrite = false;
      m.transparent = true;
      return m;
    };

    this.materials = {
      // Unlit multiply: darkens the already-shaded surface, so grain reads through.
      stain: A.material('decal_stain_mat', () => off(new THREE.MeshBasicMaterial({
        map: stainTex, blending: THREE.MultiplyBlending, opacity: 1,
        side: THREE.FrontSide, toneMapped: true,
      }))),
      // Lit: paint and paper sit on the surface and take the sun. Alpha comes
      // from the atlas' own alpha channel, so no alphaMap (that would double up).
      paint: A.material('decal_paint_mat', () => off(new THREE.MeshStandardMaterial({
        map: paintTex, roughness: 0.78, metalness: 0.0, side: THREE.FrontSide,
      }))),
      // Standing water: glossy, faintly rippled, alpha-shaped by the atlas cell.
      puddle: A.material('decal_puddle_mat', () => off(new THREE.MeshStandardMaterial({
        color: 0x1c2126, map: paintTex, normalMap: rippleTex,
        normalScale: new THREE.Vector2(0.22, 0.22),
        roughness: 0.045, metalness: 0.02, opacity: 0.92, side: THREE.FrontSide,
      }))),
    };
    return this.materials;
  }

  /**
   * Register decal batches on the shared prop batcher. Must be called before
   * `batcher.build()`.
   */
  register(ctx, L, density, batcher) {
    const M = this._materials(ctx);
    this.batcher = batcher;
    const scale = THREE.MathUtils.clamp(density, 0.3, 1.3);
    const bat = {};
    for (const [name, spec] of Object.entries(TYPES)) {
      const [matKey, cell, w, h, vertical, dist] = spec;
      const geom = quad(w, h, cell, vertical);
      const b = batcher.batch('decal_' + name, [{
        geometry: geom, materials: M[matKey], dist: dist * scale, cast: false,
      }], { receive: false });
      bat[name] = b;
      this.batchNames.push('decal_' + name);
    }
    placeDecals(bat, L, density);
    for (const n of Object.keys(bat)) this._counts[n] = bat[n].count;
  }

  /** Called after batcher.build(); decals must draw after opaque geometry. */
  afterBuild(batcher) {
    for (const n of this.batchNames) {
      const b = batcher.batches.get(n);
      if (!b) continue;
      for (const m of b.meshes) m.renderOrder = n.includes('puddle') ? 4 : 3;
    }
    this.setWeather(this._weather);
  }

  setWeather(w) {
    this._weather = w;
    if (!this.batcher) return;
    const wet = w === 'rain' || w === 'storm';
    const snow = w === 'snow';
    const set = (n, v) => this.batcher.batches.get('decal_' + n)?.setVisible(v);
    set('puddle', wet);
    set('salt', snow || w === 'overcast');
    if (this.materials) {
      this.materials.puddle.opacity = wet ? 0.95 : 0.6;
    }
  }

  /** Kept for symmetry with Props; the shared batcher does the repacking. */
  refresh() { }

  stats() { return { ...this._counts }; }

  dispose() { this.batchNames.length = 0; this.batcher = null; }
}

// ---------------------------------------------------------------------------

function placeDecals(bat, L, density) {
  const q = (n) => Math.round(n * density);
  const quota = {
    oil: q(1100), skid: q(300), crack: q(1300), patch: q(750), gutter: q(1100),
    tarSeam: q(500), ringStain: q(700), gumSpots: q(500), wearStrip: q(700),
    grimeWall: q(1000), rustWall: q(520), waterWall: q(460),
    crosswalk: q(700), stopBar: q(420), arrow: q(340), paintFaded: q(600),
    leaves: q(800), salt: q(420), chalk: q(160),
    poster: q(800), flyers: q(420), graffiti: q(300), stickers: q(500),
    puddle: q(520),
  };
  const take = (k) => (quota[k] -= 1) >= 0;
  const road = (x, z) => L.gh(x, z) + 0.012;
  const walk = (x, z) => L.gh(x, z) + L.kerb + 0.010;
  const facing = (fx, fz) => Math.atan2(fx, fz);
  // Road markings are only ours to draw while the city has no graph of its own.
  const paintOK = L.source === 'grid' || L.city?.hasRoadMarkings === false;

  let si = 0;
  for (const s of L.segments) {
    const rng = new RNG(4400021 + (si++) * 8161);
    const kerb = s.halfRoad;
    const along = facing(s.dx, s.dz);

    // Wheel-path polish down each lane.
    if (paintOK || true) {
      for (const lane of [-1, 1]) {
        for (let t = rng.range(2, 10); t < s.len - 6; t += 11.5) {
          if (!take('wearStrip')) break;
          const off = lane * kerb * 0.45;
          const x = s.ax + s.dx * t + s.nx * off, z = s.az + s.dz * t + s.nz * off;
          bat.wearStrip.add(x, road(x, z) - 0.002, z, along, 1, rng.range(0.8, 1.1));
        }
      }
    }
    // Longitudinal tar seam down the crown.
    for (let t = rng.range(0, 12); t < s.len - 6; t += 5.8) {
      if (!take('tarSeam')) break;
      const off = rng.range(-1.2, 1.2);
      const x = s.ax + s.dx * t + s.nx * off, z = s.az + s.dz * t + s.nz * off;
      bat.tarSeam.add(x, road(x, z), z, along + rng.range(-0.04, 0.04), 1, rng.range(0.85, 1.05));
    }
    // Cracks, patches, gum.
    for (let i = 0; i < 14; i++) {
      const t = rng.f() * s.len;
      const off = rng.range(-kerb, kerb);
      const x = s.ax + s.dx * t + s.nx * off, z = s.az + s.dz * t + s.nz * off;
      const r = rng.f();
      if (r < 0.42 && take('crack')) bat.crack.add(x, road(x, z), z, rng.range(0, 6.28), rng.range(0.7, 1.5), rng.range(0.8, 1.1));
      else if (r < 0.66 && take('patch')) bat.patch.add(x, road(x, z) + 0.001, z, along + (rng.chance(0.5) ? 1.5708 : 0), rng.range(0.7, 1.4), rng.range(0.85, 1.1));
      else if (r < 0.80 && take('gumSpots')) bat.gumSpots.add(x, walk(x, z), z, rng.range(0, 6.28), rng.range(0.8, 1.3), 1);
      else if (take('ringStain')) bat.ringStain.add(x, road(x, z), z, rng.range(0, 6.28), rng.range(0.7, 1.3), 1);
    }
    // Kerbside: oil where cars park, silt in the gutter, leaves, puddles.
    for (const side of [-1, 1]) {
      for (let t = rng.range(4, 12); t < s.len - 5; t += rng.range(5.5, 9)) {
        const off = kerb - rng.range(0.35, 1.1);
        const x = s.ax + s.dx * t + s.nx * off * side, z = s.az + s.dz * t + s.nz * off * side;
        if (rng.chance(0.5) && take('gutter')) {
          bat.gutter.add(x, road(x, z), z, facing(-s.nx * side, -s.nz * side), 1, rng.range(0.8, 1.15));
        }
        if (rng.chance(0.34) && take('oil')) {
          const ox = s.ax + s.dx * t + s.nx * (kerb - 1.9) * side;
          const oz = s.az + s.dz * t + s.nz * (kerb - 1.9) * side;
          bat.oil.add(ox, road(ox, oz), oz, along, rng.range(0.7, 1.4), rng.range(0.8, 1.1));
        }
        if (rng.chance(0.22) && take('leaves')) {
          bat.leaves.add(x, road(x, z) + 0.002, z, rng.range(0, 6.28), rng.range(0.7, 1.3), rng.range(0.85, 1.1));
        }
        if (rng.chance(0.14) && take('puddle')) {
          bat.puddle.add(x, road(x, z) + 0.001, z, rng.range(0, 6.28), rng.range(0.7, 1.5), 1);
        }
        if (rng.chance(0.12) && take('salt')) {
          bat.salt.add(x, walk(x, z), z, rng.range(0, 6.28), rng.range(0.8, 1.4), 1);
        }
        if (rng.chance(0.05) && take('chalk')) {
          bat.chalk.add(x, walk(x, z), z, rng.range(0, 6.28), rng.range(0.8, 1.2), 1);
        }
      }
    }
    // Centre line / edge line, only when the city has not painted its own.
    if (paintOK) {
      for (let t = rng.range(0, 7); t < s.len - 7; t += 7.2) {
        if (!take('paintFaded')) break;
        const x = s.ax + s.dx * t, z = s.az + s.dz * t;
        bat.paintFaded.add(x, road(x, z) + 0.001, z, along, 1, 1);
      }
      if (s.type === 'arterial' && rng.chance(0.5)) {
        for (let k = 0; k < 2; k++) {
          if (!take('arrow')) break;
          const t = s.len - rng.range(9, 20);
          const off = (k ? 1 : -1) * kerb * 0.45;
          const x = s.ax + s.dx * t + s.nx * off, z = s.az + s.dz * t + s.nz * off;
          bat.arrow.add(x, road(x, z) + 0.002, z, along, 1, 1);
        }
      }
    }
  }

  // Junctions: crossings, stop bars, skid marks on the approaches.
  let ji = 0;
  for (const j of L.junctions) {
    const rng = new RNG(5500033 + (ji++) * 4133);
    for (const leg of j.legs) {
      const k = leg.hw + 2.6;
      const x = j.x + leg.dx * k, z = j.z + leg.dz * k;
      if (paintOK && take('crosswalk')) {
        bat.crosswalk.add(x, road(x, z) + 0.002, z, facing(leg.dx, leg.dz), 1, rng.range(0.9, 1.0));
      }
      if (paintOK && take('stopBar')) {
        const k2 = leg.hw + 5.2;
        const bx = j.x + leg.dx * k2, bz = j.z + leg.dz * k2;
        bat.stopBar.add(bx, road(bx, bz) + 0.002, bz, facing(leg.dx, leg.dz), 1, 1);
      }
      if (rng.chance(0.3) && take('skid')) {
        const k3 = leg.hw + rng.range(5, 12);
        const sx = j.x + leg.dx * k3, sz = j.z + leg.dz * k3;
        bat.skid.add(sx, road(sx, sz) + 0.001, sz, facing(leg.dx, leg.dz), rng.range(0.8, 1.2), rng.range(0.85, 1.1));
      }
      if (rng.chance(0.5) && take('crack')) {
        const cx = j.x + leg.dx * (leg.hw * 0.5), cz = j.z + leg.dz * (leg.hw * 0.5);
        bat.crack.add(cx, road(cx, cz), cz, rng.range(0, 6.28), rng.range(1.0, 1.8), 1);
      }
    }
  }

  // Walls: grime under sills, rust runs off fixings, water staining, flyposting.
  let fi = 0;
  for (const f of L.frontage) {
    const rng = new RNG(6600041 + (fi++) * 3313);
    if (f.len < 5) continue;
    const ry = facing(f.nx, f.nz);
    const y0 = L.gh(f.ax, f.az);
    for (let t = rng.range(0.5, 3); t < f.len - 1; t += rng.range(1.6, 4.2)) {
      const x = f.ax + f.dx * t + f.nx * 0.02;
      const z = f.az + f.dz * t + f.nz * 0.02;
      const floors = Math.max(1, Math.min(7, Math.floor((f.maxHeight - 3) / 3.4)));
      // Streaks below each window band.
      const fl = 1 + rng.int(floors);
      const y = y0 + 3.4 + (fl - 1) * 3.35;
      if (rng.chance(0.55) && take('grimeWall')) {
        bat.grimeWall.add(x, y, z, ry, rng.range(0.8, 1.4), rng.range(0.85, 1.1));
      }
      if (rng.chance(0.22) && take('rustWall')) {
        bat.rustWall.add(x, y + rng.range(-0.6, 0.9), z, ry, rng.range(0.7, 1.3), 1);
      }
      if (rng.chance(0.18) && take('waterWall')) {
        bat.waterWall.add(x, y0 + rng.range(4, Math.max(5, f.maxHeight - 2)), z, ry, rng.range(0.8, 1.5), 1);
      }
      // Street level: posters, flyers, tags, stickers.
      if (rng.chance(0.30) && take('poster')) {
        bat.poster.add(x, y0 + rng.range(1.3, 2.4), z, ry, rng.range(0.85, 1.3), 1);
      }
      if (rng.chance(0.18) && take('flyers')) {
        bat.flyers.add(x, y0 + rng.range(1.2, 2.0), z, ry, rng.range(0.85, 1.2), 1);
      }
      if (rng.chance(0.10) && take('graffiti')) {
        bat.graffiti.add(x, y0 + rng.range(1.0, 2.2), z, ry, rng.range(0.8, 1.4), 1);
      }
      if (rng.chance(0.16) && take('stickers')) {
        bat.stickers.add(x, y0 + rng.range(1.1, 1.9), z, ry, rng.range(0.8, 1.3), 1);
      }
      // Grime at the base of every wall, where the pavement meets it.
      if (rng.chance(0.4) && take('grimeWall')) {
        bat.grimeWall.add(x, y0 + 0.55, z, ry, rng.range(0.9, 1.6), rng.range(0.9, 1.1));
      }
    }
  }
}
