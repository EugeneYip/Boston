/**
 * Pacejka-style Magic Formula tyre model with combined slip and load sensitivity.
 *
 * Why not `grip = mu * Fz`: the *shape* of the slip curve is what a driver feels.
 * Force has to build with slip, peak, then fall away — that falloff past the peak is
 * what makes a car break away progressively instead of binary-snapping, and what makes
 * a drift holdable. The friction ellipse (combined slip) is what stops you braking and
 * cornering at 100% simultaneously. Load sensitivity (mu drops as Fz rises) is what
 * makes weight transfer actually matter: the loaded outside tyre gives back less than
 * the unloaded inside one takes away, so total axle grip falls in a corner. Without it,
 * anti-roll bars and roll stiffness would have no effect on balance at all.
 *
 * Everything here is allocation-free: `solve()` writes into a caller-owned object.
 */

const PI2 = Math.PI * 2;

/** Magic formula: D sin(C atan(Bx - E(Bx - atan Bx))). */
function magic(x, B, C, D, E) {
  const bx = B * x;
  return D * Math.sin(C * Math.atan(bx - E * (bx - Math.atan(bx))));
}

/**
 * Solve the stiffness factor B that puts the curve peak at slip `peak`.
 * The peak is where `Bx - E(Bx - atan Bx) === tan(pi / 2C)`; Newton-solve for t = B*peak.
 */
function solveB(C, E, peak) {
  const phi = Math.tan(Math.PI / (2 * C));
  let t = phi;                              // E = 0 solution is the seed
  for (let i = 0; i < 24; i++) {
    const at = Math.atan(t);
    const f = t * (1 - E) + E * at - phi;
    const df = (1 - E) + E / (1 + t * t);
    const step = f / df;
    t -= step;
    if (Math.abs(step) < 1e-9) break;
  }
  return t / peak;
}

/**
 * A tyre compound + carcass. One instance is shared by every wheel that uses it —
 * per-wheel state (slip relaxation, temperature) lives on the wheel, not here.
 */
export class Tire {
  /**
   * @param {object} p
   * @param {number} p.mu          peak friction coefficient at nominal load
   * @param {number} p.fz0         nominal vertical load, N (roughly the static corner weight)
   * @param {number} p.loadSens    fractional mu loss per unit of Fz/Fz0 above nominal
   * @param {number} p.peakSlip    slip ratio at peak longitudinal force (~0.10-0.14)
   * @param {number} p.peakAlpha   slip angle at peak lateral force, radians (~0.12-0.19)
   * @param {number} p.longMuScale longitudinal peak relative to lateral (tyres pull harder in line)
   */
  constructor(p = {}) {
    this.mu = p.mu ?? 1.05;
    this.fz0 = p.fz0 ?? 4000;
    this.loadSens = p.loadSens ?? 0.16;
    this.peakSlip = p.peakSlip ?? 0.115;
    this.peakAlpha = p.peakAlpha ?? 0.145;
    this.longMuScale = p.longMuScale ?? 1.06;

    // Shape/curvature. Higher E = flatter, longer-lasting tail past the peak.
    this.Cx = p.Cx ?? 1.62;
    this.Ex = p.Ex ?? 0.42;
    this.Cy = p.Cy ?? 1.36;
    this.Ey = p.Ey ?? -0.55;      // negative E on the lateral curve = sharper peak, softer tail

    // Slip relaxation lengths (m). The contact patch takes distance, not time, to build
    // force — this is what keeps the model stable at 60 Hz and stops low-speed jitter.
    this.relaxLong = p.relaxLong ?? 0.32;
    this.relaxLat = p.relaxLat ?? 0.55;

    // Fraction of peak grip that survives full sliding (locked / spinning).
    this.slideMu = p.slideMu ?? 0.78;

    // Rolling resistance coefficient.
    this.crr = p.crr ?? 0.014;

    this.Bx = solveB(this.Cx, this.Ex, this.peakSlip);
    this.By = solveB(this.Cy, this.Ey, this.peakAlpha);
  }

  /** Load-sensitive peak friction. Falls as the tyre is squashed harder. */
  muAt(fz) {
    const r = fz / this.fz0;
    const m = this.mu * (1 - this.loadSens * (r - 1));
    return m < this.mu * 0.5 ? this.mu * 0.5 : (m > this.mu * 1.35 ? this.mu * 1.35 : m);
  }

  /**
   * Combined-slip tyre forces in the wheel's contact frame.
   *
   * @param {{fx:number, fy:number, load:number, slide:number}} out  written in place
   * @param {number} fz        vertical load, N (>= 0)
   * @param {number} kappa     longitudinal slip ratio, (omega*r - v) / |v|
   * @param {number} alpha     slip angle, radians. Positive = contact patch sliding right.
   * @param {number} surfaceMu surface multiplier (1 = dry asphalt, ~0.65 wet, ~0.4 grass)
   * @returns {object} out — fx along wheel forward, fy along wheel right (already signed
   *   so it opposes the slide), load = mu*fz available, slide = 0..1 how far past the peak.
   */
  solve(out, fz, kappa, alpha, surfaceMu = 1) {
    if (fz <= 1) { out.fx = 0; out.fy = 0; out.load = 0; out.slide = 0; return out; }

    const mu = this.muAt(fz) * surfaceMu;
    const Dy = mu * fz;
    const Dx = Dy * this.longMuScale;

    // Normalised slip vector. Dividing each axis by its own peak makes the combined
    // limit an ellipse in force space with the right aspect ratio.
    const sx = kappa / this.peakSlip;
    const sy = Math.tan(alpha) / this.peakAlpha;
    const s = Math.sqrt(sx * sx + sy * sy);

    if (s < 1e-5) { out.fx = 0; out.fy = 0; out.load = Dy; out.slide = 0; return out; }

    // Evaluate each curve at the *combined* slip magnitude, then split by direction.
    // At s = 1 this returns exactly the peak, so the envelope is the friction ellipse.
    const fxMag = magic(s * this.peakSlip, this.Bx, this.Cx, Dx, this.Ex);
    const fyMag = magic(s * this.peakAlpha, this.By, this.Cy, Dy, this.Ey);

    const inv = 1 / s;
    out.fx = (sx * inv) * fxMag;
    out.fy = -(sy * inv) * fyMag;
    out.load = Dy;
    out.slide = s > 1 ? 1 - 1 / s : 0;      // 0 while gripping, ->1 deep in the slide
    return out;
  }

  /**
   * Steady-state peak longitudinal force, used by the traction-control and ABS
   * targets so the assists aim at the real limit rather than a magic number.
   */
  peakLong(fz, surfaceMu = 1) { return this.muAt(fz) * fz * this.longMuScale * surfaceMu; }
}

/** Stock compounds. Sports rubber peaks later and falls off harder; truck rubber is soft. */
export const TIRE_PRESETS = {
  street: () => new Tire({
    mu: 1.02, fz0: 4200, loadSens: 0.16, peakSlip: 0.118, peakAlpha: 0.150,
    Cy: 1.36, Ey: -0.5, slideMu: 0.80, crr: 0.014,
  }),
  sport: () => new Tire({
    mu: 1.32, fz0: 3800, loadSens: 0.13, peakSlip: 0.105, peakAlpha: 0.128,
    Cy: 1.42, Ey: -0.75, longMuScale: 1.1, slideMu: 0.74, crr: 0.013,
    relaxLong: 0.26, relaxLat: 0.45,
  }),
  performance: () => new Tire({
    mu: 1.16, fz0: 4200, loadSens: 0.14, peakSlip: 0.110, peakAlpha: 0.138,
    Cy: 1.40, Ey: -0.62, slideMu: 0.78, crr: 0.0135,
  }),
  utility: () => new Tire({          // vans, pickups: taller sidewall, later, softer peak
    mu: 0.96, fz0: 6500, loadSens: 0.19, peakSlip: 0.130, peakAlpha: 0.175,
    Cy: 1.30, Ey: -0.35, slideMu: 0.84, crr: 0.017,
    relaxLong: 0.40, relaxLat: 0.70,
  }),
  heavy: () => new Tire({            // bus / truck: very load sensitive, low peak
    mu: 0.88, fz0: 16000, loadSens: 0.22, peakSlip: 0.145, peakAlpha: 0.195,
    Cy: 1.26, Ey: -0.2, longMuScale: 1.0, slideMu: 0.86, crr: 0.02,
    relaxLong: 0.55, relaxLat: 0.95,
  }),
};

/** Grip multiplier by ground surface. Consumed by Vehicle via `wheel.surfaceMu`. */
export const SURFACE_MU = {
  asphalt: 1.0, asphalt_wet: 0.68, concrete: 0.98, cobblestone: 0.88,
  sidewalk: 0.94, dirt: 0.62, grass: 0.48, gravel: 0.58, snow: 0.32, ice: 0.14,
};

/**
 * Advance a first-order slip relaxation filter one step. Returns the new lagged slip.
 * The lag is a *distance* (relaxation length), so it disappears at speed and dominates
 * at a crawl — which is exactly what stops a stationary car buzzing on its tyres.
 */
export function relaxSlip(current, target, speed, relaxLength, dt) {
  const k = Math.abs(speed) * dt / Math.max(relaxLength, 1e-3);
  const a = k > 1 ? 1 : k;
  return current + (target - current) * (a < 0.06 ? 0.06 : a);
}

export default Tire;
export { PI2 };
