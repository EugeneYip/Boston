import * as THREE from 'three';
import EventBus from './EventBus.js';
import Settings from './Settings.js';
import Input from './Input.js';

const FIXED = 1 / 60;
const MAX_DT = 0.1;

export default class Engine {
  constructor(container) {
    this.container = container;
    this.bus = new EventBus();
    this.settings = new Settings('high');
    this.systems = new Map();
    this.order = [];
    this._acc = 0;
    this._running = false;
    this._clock = new THREE.Clock();

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.settings.fov, 1, 0.25, 12000);
    this.camera.position.set(0, 12, 40);

    this.renderer = null;   // set by RenderPipeline
    this.composer = null;   // set by RenderPipeline

    this.time = { elapsed: 0, dt: 0, frame: 0, timeOfDay: this.settings.timeOfDay, fps: 60 };
    this.perf = { fps: 60, ms: 16, drawCalls: 0, tris: 0, _acc: 0, _n: 0 };
    this.input = null;
  }

  get ctx() {
    return {
      scene: this.scene, camera: this.camera,
      get renderer() { return this._e.renderer; },
      get composer() { return this._e.composer; },
      get physics()  { return this._e.systems.get('physics'); },
      get assets()   { return this._e.systems.get('assets'); },
      settings: this.settings, bus: this.bus, time: this.time,
      input: this.input, engine: this,
      get: (id) => this.systems.get(id),
      _e: this,
    };
  }

  register(system) {
    const id = system.constructor.id;
    if (!id) throw new Error(`System ${system.constructor.name} has no static id`);
    if (this.systems.has(id)) throw new Error(`Duplicate system id "${id}"`);
    this.systems.set(id, system);
    return this;
  }

  /** Topologically sort by static deps, then init in order. */
  async init(onProgress = () => {}) {
    const all = [...this.systems.values()];
    const done = new Set(); const sorted = []; const visiting = new Set();
    const visit = (s) => {
      const id = s.constructor.id;
      if (done.has(id)) return;
      if (visiting.has(id)) throw new Error(`Circular dependency at "${id}"`);
      visiting.add(id);
      for (const d of (s.constructor.deps || [])) {
        const dep = this.systems.get(d);
        if (!dep) throw new Error(`System "${id}" depends on missing "${d}"`);
        visit(dep);
      }
      visiting.delete(id); done.add(id); sorted.push(s);
    };
    all.forEach(visit);
    this.order = sorted;

    const ctx = this.ctx;
    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i];
      const label = s.constructor.label || s.constructor.id;
      onProgress(i / sorted.length, label);
      const t0 = performance.now();
      await s.init?.(ctx);
      const ms = performance.now() - t0;
      if (ms > 400) console.info(`[engine] ${label} init took ${ms | 0}ms`);
    }
    onProgress(1, 'Ready');

    // Input needs the canvas, which RenderPipeline created.
    this.input = new Input(this.renderer.domElement, this.bus);
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.bus.emit('engine:ready', this);
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.bus.emit('resize', { w, h });
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._clock.start();
    const loop = () => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(loop);
      this.frame();
    };
    this._raf = requestAnimationFrame(loop);
  }
  stop() { this._running = false; cancelAnimationFrame(this._raf); }

  frame() {
    const t0 = performance.now();
    let dt = this._clock.getDelta();
    if (dt > MAX_DT) dt = MAX_DT;          // never let a hitch explode physics
    const ctx = this.ctx;

    this.time.dt = dt;
    this.time.elapsed += dt;
    this.time.frame++;
    // Advance world clock
    this.settings.timeOfDay = (this.settings.timeOfDay + (dt * this.settings.timeScale) / 3600) % 24;
    this.time.timeOfDay = this.settings.timeOfDay;

    this.input?.poll();

    // Draw-call/triangle accounting: the composer's internal render() calls would
    // otherwise clobber this, so pin autoReset off and zero the counters here.
    if (this.renderer) { this.renderer.info.autoReset = false; this.renderer.info.reset(); }

    // Fixed-step physics
    this._acc += dt;
    let steps = 0;
    while (this._acc >= FIXED && steps < 5) {
      for (const s of this.order) s.fixedUpdate?.(FIXED, ctx);
      this._acc -= FIXED; steps++;
    }
    if (steps === 5) this._acc = 0; // give up on catching up

    for (const s of this.order) s.update?.(dt, ctx);
    for (const s of this.order) s.lateUpdate?.(dt, ctx);

    this.composer ? this.composer.render(dt) : this.renderer.render(this.scene, this.camera);

    // Read immediately after render, before anything can reset the counters.
    const rinfo = this.renderer.info.render;
    this.perf.drawCalls = rinfo.calls;
    this.perf.tris = rinfo.triangles;

    this.input?.endFrame();

    // Perf sampling
    const ms = performance.now() - t0;
    this.perf._acc += ms; this.perf._n++;
    if (this.perf._n >= 20) {
      this.perf.ms = this.perf._acc / this.perf._n;
      this.perf.fps = 1000 / Math.max(this.perf.ms, 0.01);
      this.time.fps = this.perf.fps;
      this.perf._acc = 0; this.perf._n = 0;
    }
  }

  dispose() {
    this.stop();
    for (const s of this.order) s.dispose?.();
    this.systems.clear(); this.bus.clear();
    this.renderer?.dispose();
  }
}
