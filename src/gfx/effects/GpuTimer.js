/**
 * Per-pass GPU timing.
 *
 * Uses EXT_disjoint_timer_query_webgl2 when the browser exposes it (Chrome hides it
 * behind a flag on most platforms for timing-attack reasons). Queries are issued one
 * at a time — the spec allows only a single active TIME_ELAPSED query — and results
 * are collected a few frames later when they become available, so nothing stalls.
 *
 * When the extension is missing, `available` is false and the pipeline falls back to
 * its A/B profiler, which brackets `composer.render()` with a real GPU sync.
 */
export default class GpuTimer {
  /** @param {WebGLRenderer} renderer */
  constructor(renderer) {
    this.gl = renderer.getContext();
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2') || null;
    this.available = !!this.ext;
    /**
     * Off by default. Timer queries are not free: on a tile-based GPU each
     * begin/end pair can act as a barrier and serialise passes that would otherwise
     * overlap, which turns a profiling tool into a performance bug. Turn it on only
     * while measuring.
     */
    this.enabled = false;
    /** name -> smoothed milliseconds */
    this.timings = new Map();
    this._pending = [];      // { name, query }
    this._active = null;
    this._cursor = 0;
    this._names = [];
    this._smoothing = 0.15;
  }

  /**
   * Round-robin: time exactly one pass per frame so a full set of timings arrives
   * every N frames without ever having two queries in flight.
   * @param {string[]} names - the passes in this frame, in order
   */
  beginFrame(names) {
    if (!this.available || !this.enabled) return;
    this._names = names;
    this._collect();
  }

  /** @param {string} name @return {boolean} whether this pass is being timed */
  begin(name) {
    if (!this.available || !this.enabled || this._active) return false;
    if (this._names.length === 0) return false;
    if (this._names[this._cursor % this._names.length] !== name) return false;
    const q = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this._active = { name, query: q };
    return true;
  }

  end() {
    if (!this._active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this._pending.push(this._active);
    this._active = null;
    this._cursor++;
  }

  _collect() {
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    for (let i = this._pending.length - 1; i >= 0; i--) {
      const p = this._pending[i];
      const done = gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE);
      if (!done) continue;
      if (!disjoint) {
        const ms = gl.getQueryParameter(p.query, gl.QUERY_RESULT) / 1e6;
        const prev = this.timings.get(p.name);
        this.timings.set(p.name, prev === undefined ? ms : prev + (ms - prev) * this._smoothing);
      }
      gl.deleteQuery(p.query);
      this._pending.splice(i, 1);
    }
  }

  /**
   * Arm or disarm profiling. Clears stale results when turning on.
   * @param {boolean} v
   */
  setEnabled(v) {
    this.enabled = !!v && this.available;
    if (!this.enabled) {
      for (const p of this._pending) this.gl.deleteQuery(p.query);
      this._pending.length = 0;
      this._active = null;
    } else {
      this.timings.clear();
      this._cursor = 0;
    }
    return this.enabled;
  }

  /** @return {Object<string, number>} milliseconds per pass */
  report() {
    const out = {};
    for (const [k, v] of this.timings) out[k] = +v.toFixed(3);
    return out;
  }

  dispose() {
    if (!this.available) return;
    for (const p of this._pending) this.gl.deleteQuery(p.query);
    this._pending.length = 0;
    this._active = null;
  }
}
