import Engine from './core/Engine.js';
import RenderPipeline from './gfx/RenderPipeline.js';
import Assets from './gfx/Assets.js';
import PhysicsWorld from './physics/PhysicsWorld.js';
import CaptureHarness from './core/CaptureHarness.js';

const boot = document.getElementById('boot');
const bar = document.querySelector('#bar i');
const stat = document.getElementById('stat');

/**
 * Systems land incrementally as agents build them. `import.meta.glob` maps only the
 * files that actually exist at transform time, so a subsystem that hasn't been written
 * yet is simply absent from the map rather than a hard resolve failure. A file that
 * exists but throws is caught and reported, so one broken subsystem never takes the
 * whole game down.
 *
 * Order below is a hint only — Engine.init() topologically sorts by `static deps`.
 */
const MODULES = import.meta.glob([
  './core/Profiler.js',
  './gfx/*.js', './world/*.js', './ai/*.js',
  './gameplay/*.js', './ui/*.js', './audio/*.js',
]);

// Terrain / Roads / Water / RoadNetwork are deliberately absent: they carry no
// `static id` because City.js composes them directly rather than registering them.
const OPTIONAL = [
  './core/Profiler.js',
  './gfx/Materials.js',
  './gfx/Sky.js',
  './gfx/Clouds.js',
  './gfx/Weather.js',
  './gfx/Fog.js',
  './gfx/Lighting.js',
  './world/City.js',
  './world/Buildings.js',
  './world/Landmarks.js',
  './world/Props.js',
  './world/Vegetation.js',
  './world/VehicleFactory.js',
  './ai/Traffic.js',
  './ai/Pedestrians.js',
  './gameplay/Player.js',
  './gameplay/CameraRig.js',
  './gameplay/Missions.js',
  './audio/AudioEngine.js',
  './ui/HUD.js',
  './ui/Minimap.js',
  './ui/Menu.js',
  './ui/DevOverlay.js',
];

async function loadOptional(engine) {
  const loaded = [], missing = [], failed = [];
  for (const path of OPTIONAL) {
    const importer = MODULES[path];
    if (!importer) { missing.push(path.replace(/^.*\//, '')); continue; }
    let mod;
    try {
      mod = await importer();
    } catch (e) {
      failed.push(`${path}: ${String(e?.message || e).split('\n')[0]}`);
      console.error(`[boot] "${path}" failed to import:`, e);
      continue;
    }
    const Cls = mod.default;
    if (typeof Cls !== 'function' || !Cls.id) {
      failed.push(`${path}: no default-exported system class with a static id`);
      continue;
    }
    if (engine.systems.has(Cls.id)) continue;   // already registered
    try { engine.register(new Cls()); loaded.push(Cls.id); }
    catch (e) { failed.push(`${path}: ${e.message}`); }
  }
  return { loaded, missing, failed };
}

async function main() {
  const engine = new Engine(document.getElementById('app'));

  // Core three always load first and are never optional.
  engine
    .register(new RenderPipeline())
    .register(new Assets())
    .register(new PhysicsWorld())
    .register(new CaptureHarness());

  const report = await loadOptional(engine);

  await engine.init((p, label) => {
    bar.style.width = (p * 100).toFixed(0) + '%';
    stat.textContent = label;
  });

  engine.start();

  // Publish the automation surface the instant the engine is live, BEFORE the
  // cosmetic overlay fade. Every agent (and the capture harness) waits on
  // `bootReport`, and it used to sit behind the `setTimeout(300)` below — which a
  // hidden tab clamps to 1/second, or 1/minute once it has been hidden for five
  // minutes. Measured: engine ready at 44 s, `bootReport` still unset at 125 s.
  window.engine = engine;
  if (window.__boston) window.__boston.bootReport = report;
  console.info('[boston] active:', engine.order.map(s => s.constructor.id).join(', '));
  if (report.missing.length) console.info('[boston] not yet built:', report.missing.join(', '));
  if (report.failed.length) console.warn('[boston] failed:', report.failed.join(' | '));

  // Let one frame land before the overlay fades, so there is no black flash. A
  // hidden tab never renders one (rAF is paused), so waiting there buys nothing and
  // costs a throttled timer — skip it and fade immediately.
  if (!document.hidden) await new Promise(r => setTimeout(r, 300));
  boot.classList.add('gone');                 // opacity 0 + pointer-events: none
  setTimeout(() => boot.remove(), 900);       // detach after the transition
}

main().catch(e => {
  const el = document.getElementById('err');
  el.style.display = 'block';
  el.textContent = 'BOOT FAILED\n\n' + (e.stack || e);
  console.error(e);
});
