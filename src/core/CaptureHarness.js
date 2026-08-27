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
      street_level:   { pos: [40, 1.7, 120],   look: [0, 1.7, -400],  tod: 9.5,  fov: 55, eye: 1.7 },
      // Re-authored: the original [180,42,260] ended up pressed against a facade
      // once building heights were fixed, so the shot was a wall of windows.
      downtown_dusk:  { pos: [700, 120, 900],  look: [-100, 40, -200], tod: 19.4, fov: 48 },
      // Parked ON A LIT STREET. The previous position sat in Boston Common with no
      // street lamp within 186 m of it -- geographically correct (the Common has no
      // roads through it) but useless for judging night lighting.
      night_neon:     { pos: [-1453.4, 4.85, 401.4], look: [-1200, 11, 470],
                        tod: 22.0, fov: 62, eye: 1.7 },
      hero_skyline:   { pos: [620, 150, 780],  look: [-200, 60, -300],tod: 17.8, fov: 40 },
      golden_hour:    { pos: [-300, 18, 420],  look: [300, 40, -200], tod: 6.6,  fov: 50 },
      overcast_wide:  { pos: [0, 320, 900],    look: [0, 30, -400],   tod: 13.0, fov: 60 },
      rain_street:    { pos: [90, 2.4, -40],   look: [-300, 6, -420], tod: 15.2, fov: 58,
                        weather: 'rain', eye: 2.4 },
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
      /**
       * Resolve a shot's Y against the terrain.
       *
       * Shot positions were authored as absolute heights before the city had real
       * elevation, which parked `street_level` (y=1.7) and `rain_street` (y=2.4)
       * *underneath* the road -- ground there is 3.10 m and 7.99 m. That produced a
       * mostly-black frame which was misread for a long time as a post-processing
       * feedback loop. Eye heights are now relative to the ground beneath the shot.
       */
      groundedY: (x, y, z, eye) => {
        const city = engine.systems.get('city');
        if (!city || typeof city.groundHeight !== 'function') return y;
        const g = city.groundHeight(x, z);
        if (!Number.isFinite(g)) return y;
        // `eye` is the intended height above ground; absolute shots keep their
        // height but are never allowed below the surface.
        return eye != null ? g + eye : Math.max(y, g + 1.6);
      },

      /**
       * Push a shot position out of solid geometry.
       *
       * Shot positions are authored against the city as it was that day. When
       * buildings change height or a new block lands, a shot that was in open air
       * ends up buried inside a tower and the capture is a wall of facade.
       *
       * Buildings have no physics colliders -- only terrain and roads do -- so this
       * tests the render geometry directly: fire rays along the six axes and treat
       * the point as enclosed if nearly all of them hit something close by.
       *
       * @returns {{moved:number, pos:number[]}} how far it had to retreat
       */
      unstick: (pos, look, maxBack = 500) => {
        const targets = [];
        engine.scene.traverse((o) => {
          if (!(o.isMesh || o.isInstancedMesh) || !o.visible) return;
          const nm = (o.name || '') + '|' + (o.parent?.name || '');
          if (/build|facade|shell|landmark/i.test(nm)) targets.push(o);
        });
        if (!targets.length) return { moved: 0, pos };

        const ray = new THREE.Raycaster();
        ray.far = 70;
        const dirs = [
          new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
          new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
          new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
        ];
        const origin = new THREE.Vector3();
        const enclosed = (p) => {
          origin.set(p[0], p[1], p[2]);
          let hits = 0;
          for (const d of dirs) {
            ray.set(origin, d);
            if (ray.intersectObjects(targets, false).length) hits++;
          }
          return hits >= 5;   // boxed in on nearly every side
        };

        // Being pressed against a facade is as useless as being inside one, and it
        // does not read as "enclosed" -- only one ray hits. Check view clearance too.
        const viewClear = (p) => {
          origin.set(p[0], p[1], p[2]);
          const d = new THREE.Vector3(look[0] - p[0], look[1] - p[1], look[2] - p[2]).normalize();
          ray.set(origin, d);
          ray.far = 25;
          const hit = ray.intersectObjects(targets, false)[0];
          ray.far = 70;
          return !hit;
        };
        if (!enclosed(pos) && viewClear(pos)) return { moved: 0, pos };

        // Retreat along the view axis, which preserves the framing intent.
        const dx = pos[0] - look[0], dy = pos[1] - look[1], dz = pos[2] - look[2];
        const len = Math.hypot(dx, dy, dz) || 1;
        const ux = dx / len, uy = dy / len, uz = dz / len;
        for (let d = 10; d <= maxBack; d += 10) {
          const p = [pos[0] + ux * d, pos[1] + uy * d, pos[2] + uz * d];
          if (!enclosed(p) && viewClear(p)) {
            console.warn(`[capture] shot was inside or against geometry; backed off ${d}m`);
            return { moved: d, pos: p };
          }
        }
        for (let up = 20; up <= 400; up += 20) {
          const p = [pos[0], pos[1] + up, pos[2]];
          if (!enclosed(p) && viewClear(p)) {
            console.warn(`[capture] shot was inside or against geometry; raised ${up}m`);
            return { moved: up, pos: p };
          }
        }
        return { moved: 0, pos };
      },

      setCamera: (pos, look, fov) => {
        for (const s of engine.order) {
          if (CAMERA_DRIVERS.has(s.constructor.id) && 'enabled' in s) {
            // Only record the ORIGINAL value. Two setCamera calls without an
            // intervening release would otherwise save the already-false value
            // and latch the controller off permanently after release.
            if (!('userData_wasEnabled' in s)) s.userData_wasEnabled = s.enabled;
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
        const rawPos = (pos ?? s.pos).slice();
        const rawLook = (look ?? s.look).slice();
        const eye = (pos ? null : s.eye);
        const groundedPos = api.groundedY(rawPos[0], rawPos[1], rawPos[2], eye);
        // Shift the aim point by the same amount the camera rose, so a grounded
        // street shot still looks level instead of straight into a hillside.
        rawLook[1] += groundedPos - rawPos[1];
        rawPos[1] = groundedPos;
        const freed = api.unstick(rawPos, rawLook);
        api.setCamera(freed.pos, rawLook, fov ?? s.fov);
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
