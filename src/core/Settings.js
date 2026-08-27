// Live-tunable quality + gameplay settings. Systems read these every frame; never cache.
const PRESETS = {
  low:    { shadowMap: 1024, shadowCascades: 2, ssao: false, ssr: false, bloom: true,
            motionBlur: false, dof: false, volumetrics: false, drawDist: 900,
            pedDensity: 0.25, trafficDensity: 0.3, anisotropy: 4, msaa: 0, pixelRatioCap: 1.0 },
  medium: { shadowMap: 2048, shadowCascades: 3, ssao: true,  ssr: false, bloom: true,
            motionBlur: false, dof: false, volumetrics: true,  drawDist: 1400,
            pedDensity: 0.5, trafficDensity: 0.6, anisotropy: 8, msaa: 0, pixelRatioCap: 1.25 },
  high:   { shadowMap: 3072, shadowCascades: 4, ssao: true,  ssr: true,  bloom: true,
            motionBlur: true,  dof: true,  volumetrics: true,  drawDist: 2200,
            pedDensity: 0.85, trafficDensity: 0.9, anisotropy: 16, msaa: 0, pixelRatioCap: 1.5 },
  ultra:  { shadowMap: 4096, shadowCascades: 4, ssao: true,  ssr: true,  bloom: true,
            motionBlur: true,  dof: true,  volumetrics: true,  drawDist: 3200,
            pedDensity: 1.0, trafficDensity: 1.0, anisotropy: 16, msaa: 0, pixelRatioCap: 2.0 },
};

export default class Settings {
  constructor(preset = 'high') {
    this.preset = preset;
    Object.assign(this, PRESETS[preset]);
    // Non-preset globals
    this.exposure = 1.0;
    this.timeOfDay = 9.25;      // hours, 0..24
    this.timeScale = 40;        // game-seconds per real-second
    this.weather = 'clear';     // clear | overcast | rain | storm | fog | snow
    this.fov = 62;
    this.invertY = false;
    this.mouseSensitivity = 1.0;
    this.masterVolume = 0.8;
    this.showStats = true;
  }
  apply(preset) {
    if (!PRESETS[preset]) return;
    this.preset = preset;
    Object.assign(this, PRESETS[preset]);
  }
  static get presets() { return Object.keys(PRESETS); }
}
