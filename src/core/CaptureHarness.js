import * as THREE from 'three';

/**
 * Deterministic screenshot harness for the automated visual-critic loop.
 *
 * Browser tabs throttle requestAnimationFrame to zero when backgrounded, so an
 * automation agent cannot rely on the normal loop running. Everything here steps
 * the engine synchronously instead.
 *
 * From an automation context:
 *   await window.__boston.ready()
 *   await window.__boston.capture({ shot: 'downtown_dusk' })
 */
export default class CaptureHarness {
  static id = 'capture';
  static label = 'Capture harness';
  static deps = ['render'];

  async init(ctx) {
    this.ctx = ctx;
    const engine = ctx.engine;

    /** Named viewpoints the critic compares against GTA V reference framing. */
    this.shots = {
      street_level:   { pos: [40, 1.7, 120],   look: [0, 1.7, -400],  tod: 9.5,  fov: 55 },
      downtown_dusk:  { pos: [180, 42, 260],   look: [-100, 30, -300],tod: 19.4, fov: 48 },
      night_neon:     { pos: [-60, 6, 40],     look: [200, 14, -260], tod: 22.0, fov: 62 },
      hero_skyline:   { pos: [620, 150, 780],  look: [-200, 60, -300],tod: 17.8, fov: 40 },
      golden_hour:    { pos: [-300, 18, 420],  look: [300, 40, -200], tod: 6.6,  fov: 50 },
      overcast_wide:  { pos: [0, 320, 900],    look: [0, 30, -400],   tod: 13.0, fov: 60 },
      rain_street:    { pos: [90, 2.4, -40],   look: [-300, 6, -420], tod: 15.2, fov: 58,
                        weather: 'rain' },
      bridge:         { pos: [-40, 26, -980],  look: [120, 8, -1500], tod: 8.2,  fov: 52 },
    };

    // Any system id that may write to the camera. `setCamera` stands these down,
    // but the transform lock below is what actually guarantees the shot.
    const CAMERA_DRIVERS = new Set(['cameraRig', 'player', 'gameplay', 'missions']);
    const camLock = { active: false, pos: new THREE.Vector3(),
                      quat: new THREE.Quaternion(), fov: null };
    const _lookTmp = new THREE.Vector3();
    {
      const cam = engine.camera;
      const origUpdate = cam.updateMatrixWorld.bind(cam);
      cam.updateMatrixWorld = function (force) {
        if (camLock.active) {
          this.position.copy(camLock.pos);
          this.quaternion.copy(camLock.quat);
          if (camLock.fov && this.fov !== camLock.fov) {
            this.fov = camLock.fov; this.updateProjectionMatrix();
          }
        }
        return origUpdate(force);
      };
    }

    const api = {
      engine,
      ready: async () => {
        for (let i = 0; i < 200 && !engine._running; i++) await new Promise(r => setTimeout(r, 50));
        return true;
      },
      /** Advance n frames synchronously with a fixed dt, ignoring rAF throttling. */
      step: (n = 1, dt = 1 / 60) => {
        const wasRunning = engine._running;
        engine.stop();
        const realDelta = engine._clock.getDelta;
        engine._clock.getDelta = () => dt;
        for (let i = 0; i < n; i++) engine.frame();
        engine._clock.getDelta = realDelta;
        if (wasRunning) engine.start();
        return { frames: n, fps: engine.perf.fps, draws: engine.perf.drawCalls,
                 tris: engine.perf.tris };
      },
      /** Freeze the world clock so shots are reproducible. */
      freeze: (on = true) => { engine.settings.timeScale = on ? 0 : 40; },
      setTime: (h) => { engine.settings.timeOfDay = h % 24; engine.time.timeOfDay = h % 24; },
      setWeather: (w) => { engine.settings.weather = w; ctx.bus.emit('weather:set', w); },
      setQuality: (p) => { engine.settings.apply(p); ctx.bus.emit('quality:changed'); },
      /**
       * Park the camera for a shot.
       *
       * Politely asking camera systems to stand down does not work: any system may
       * write to the camera, new ones get added, and one that ignores `enabled`
       * silently invalidates every screenshot the visual critic takes. So we also
       * hard-lock the transform in `camera.updateMatrixWorld`, which the renderer
       * calls immediately before rasterising — whatever a system did during
       * update/lateUpdate is overwritten before it can reach the frame.
       */
      setCamera: (pos, look, fov) => {
        for (const s of engine.order) {
          if (CAMERA_DRIVERS.has(s.constructor.id) && 'enabled' in s) {
            s.userData_wasEnabled = s.enabled;
            s.enabled = false;
          }
        }
        const cam = engine.camera;
        cam.position.set(pos[0], pos[1], pos[2]);
        cam.lookAt(_lookTmp.set(look[0], look[1], look[2]));
        if (fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
        camLock.pos.copy(cam.position);
        camLock.quat.copy(cam.quaternion);
        camLock.fov = fov || cam.fov;
        camLock.active = true;
      },
      releaseCamera: () => {
        camLock.active = false;
        for (const s of engine.order) {
          if (CAMERA_DRIVERS.has(s.constructor.id) && 'userData_wasEnabled' in s) {
            s.enabled = s.userData_wasEnabled;
            delete s.userData_wasEnabled;
          }
        }
        const rig = engine.systems.get('cameraRig');
        if (rig?.pos) rig.pos.copy(engine.camera.position);
      },
      /** True if a shot is currently holding the camera. */
      cameraLocked: () => camLock.active,
      /**
       * Set up a named (or ad-hoc) shot and render it deterministically.
       * Returns the perf numbers so the critic can enforce the frame budget.
       */
      capture: async ({ shot, pos, look, tod, fov, weather, quality, warmup = 24 } = {}) => {
        const s = shot ? this.shots[shot] : null;
        if (shot && !s) throw new Error(`unknown shot "${shot}"`);
        api.freeze(true);
        if (quality) api.setQuality(quality);
        const w = weather ?? s?.weather ?? 'clear';
        api.setWeather(w);
        api.setTime(tod ?? s?.tod ?? 12);
        api.setCamera(pos ?? s.pos, look ?? s.look, fov ?? s.fov);
        // Warm up: lets IBL, streaming, LOD and temporal effects settle.
        api.step(warmup);
        await new Promise(r => setTimeout(r, 60));
        const stats = api.step(6);
        return { shot: shot || 'custom', weather: w,
                 tod: +engine.settings.timeOfDay.toFixed(2), ...stats };
      },
      /**
       * Measure REAL frame rate from the natural rAF loop.
       *
       * Read this before trusting any fps number: a backgrounded tab throttles
       * requestAnimationFrame to zero, and `step()` drives frames synchronously,
       * so neither reflects real performance. Only a fronted, visible tab does.
       * `hidden: true` in the result means the number is meaningless — front the
       * tab (mcp__Claude_Browser__tabs_select) and measure again.
       */
      measureFps: async (seconds = 2) => {
        if (document.hidden) {
          return { hidden: true, fps: null,
            warning: 'Tab is backgrounded — rAF is throttled to zero. Front the tab first; this number would be meaningless.' };
        }
        const f0 = engine.time.frame, t0 = performance.now();
        await new Promise(r => setTimeout(r, seconds * 1000));
        const frames = engine.time.frame - f0;
        const elapsed = (performance.now() - t0) / 1000;
        return {
          hidden: false,
          fps: +(frames / elapsed).toFixed(1),
          frames,
          draws: engine.perf.drawCalls,
          tris: engine.perf.tris,
          resolution: [engine.renderer.domElement.width, engine.renderer.domElement.height],
          preset: engine.settings.preset,
        };
      },
      shotNames: () => Object.keys(this.shots),
      stats: () => ({
        fps: +engine.perf.fps.toFixed(1), ms: +engine.perf.ms.toFixed(2),
        draws: engine.perf.drawCalls, tris: engine.perf.tris,
        geometries: engine.renderer.info.memory.geometries,
        textures: engine.renderer.info.memory.textures,
        programs: engine.renderer.info.programs?.length ?? 0,
      }),
      errors: [],
      glFaults: [],
    };

    window.__boston = api;
    this.api = api;

    // Collect runtime errors so the critic can fail a shot that logged one.
    const origErr = console.error;
    console.error = (...a) => { api.errors.push(a.map(String).join(' ')); origErr(...a); };

    // GL driver faults arrive as console.warn, NOT console.error. A sampler-unit
    // collision that rejected every building draw call hid behind this for an
    // entire session because nothing was watching warnings.
    const origWarn = console.warn;
    const GL_FAULT = /GL_INVALID|INVALID_OPERATION|INVALID_VALUE|INVALID_ENUM|Framebuffer is incomplete|program not valid|feedback loop|not renderable/i;
    console.warn = (...a) => {
      const msg = a.map(String).join(' ');
      if (GL_FAULT.test(msg)) api.glFaults.push(msg.slice(0, 300));
      origWarn(...a);
    };
  }
  dispose() { delete window.__boston; }
}
