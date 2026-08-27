export default class EventBus {
  constructor() { this._m = new Map(); }
  on(evt, fn) {
    if (!this._m.has(evt)) this._m.set(evt, new Set());
    this._m.get(evt).add(fn);
    return () => this.off(evt, fn);
  }
  once(evt, fn) {
    const off = this.on(evt, (p) => { off(); fn(p); });
    return off;
  }
  off(evt, fn) { this._m.get(evt)?.delete(fn); }
  emit(evt, payload) {
    const s = this._m.get(evt);
    if (!s) return;
    for (const fn of Array.from(s)) {
      try { fn(payload); }
      catch (e) { console.error(`[bus] handler for "${evt}" threw:`, e); }
    }
  }
  clear() { this._m.clear(); }
}
