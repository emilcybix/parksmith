import { Container, Sprite, Texture } from 'pixi.js';
import type { WeatherEffects } from './weatherLook';
import { CLOUD_WRAP_VOXELS } from './weatherLook';

/**
 * The classic renderer's weather presentation (Phase 20 step 3), deliberately simple:
 *  - cloud shadows: a fixed pool of soft ellipse sprites drawn with the MULTIPLY blend, so a shadow
 *    can only darken and cool what is under it (it never greys a candy colour out; the tint is the
 *    shared `cloudTint`, every channel >= 0.78). The pool lives in the camera container, so clouds
 *    are anchored to the park and a camera pan costs nothing;
 *  - rain: a fixed pool of thin streak sprites in screen space (above the camera, like real rain).
 *
 * Everything is created once in the constructor. `apply` only writes properties of the pooled
 * sprites, and only when the effects moved (a calm or paused frame writes nothing): no display
 * object, Graphics or array is created per frame. Gloom and the lightning flash are not drawn here,
 * they go through the camera tint (`classicTint`). There are no puddles and no shimmer in classic.
 * Presentation only: it reads the effects and nothing flows back.
 */

export const CLASSIC_RAIN_POOL = 160;
export const CLASSIC_CLOUD_POOL = 6;
/** Screen pixels a rain streak falls per animation row (the shared phase is in rows). */
const RAIN_PIXELS_PER_ROW = 12;
const RAIN_STREAK_WIDTH = 1.75;
const RAIN_STREAK_HEIGHT = 14;
const RAIN_ALPHA = 0.65;
/** Cloud ellipse size as a share of the park's screen extent. */
const CLOUD_WIDTH_SHARE = 0.42;
const CLOUD_ASPECT = 0.55;
const CLOUD_TEXTURE_WIDTH = 128;
const CLOUD_TEXTURE_HEIGHT = 80;

export interface ScreenSize { width: number; height: number }
/** The park's extent in camera (world) pixels. */
export interface FieldBounds { x: number; y: number; width: number; height: number }

const frac = (value: number): number => value - Math.floor(value);
const channelByte = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 255);
const packRgb = (rgb: readonly [number, number, number]): number => (
  (channelByte(rgb[0]) << 16) | (channelByte(rgb[1]) << 8) | channelByte(rgb[2])
);

/** One soft radial ellipse, white with a falling alpha, generated once. WHITE where no canvas exists (tests). */
const createCloudTexture = (): Texture => {
  try {
    if (typeof document === 'undefined') return Texture.WHITE;
    const canvas = document.createElement('canvas');
    canvas.width = CLOUD_TEXTURE_WIDTH;
    canvas.height = CLOUD_TEXTURE_HEIGHT;
    const context = canvas.getContext('2d');
    if (!context) return Texture.WHITE;
    context.translate(CLOUD_TEXTURE_WIDTH / 2, CLOUD_TEXTURE_HEIGHT / 2);
    context.scale(1, CLOUD_TEXTURE_HEIGHT / CLOUD_TEXTURE_WIDTH);
    const gradient = context.createRadialGradient(0, 0, 0, 0, 0, CLOUD_TEXTURE_WIDTH / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.45, 'rgba(255,255,255,0.8)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(-CLOUD_TEXTURE_WIDTH / 2, -CLOUD_TEXTURE_WIDTH / 2, CLOUD_TEXTURE_WIDTH, CLOUD_TEXTURE_WIDTH);
    return Texture.from(canvas);
  } catch {
    return Texture.WHITE;
  }
};

export class ClassicWeather {
  /** In the camera container (world space), above the construction art. */
  readonly cloudLayer = new Container();
  /** In the stage (screen space), above the camera. */
  readonly rainLayer = new Container();
  private readonly clouds: Sprite[] = [];
  private readonly rain: Sprite[] = [];
  private readonly rainX = new Float32Array(CLASSIC_RAIN_POOL);
  private readonly rainY = new Float32Array(CLASSIC_RAIN_POOL);
  private readonly cloudX = new Float32Array(CLASSIC_CLOUD_POOL);
  private readonly cloudY = new Float32Array(CLASSIC_CLOUD_POOL);
  private readonly cloudTexture: Texture;
  private ownsTexture = false;
  private readonly rainSignature = new Float64Array(10);
  private readonly cloudSignature = new Float64Array(12);
  private rainTintHex = -1;
  private cloudTintHex = -1;
  private rainRotation = Number.NaN;
  private destroyed = false;
  /** Phase 26: maps a point of the unrotated park field into the current view (null at view 0). */
  private mapper: ((x: number, y: number, out: { x: number; y: number }) => void) | null = null;
  private mapperKey = 0;
  private readonly mapped = { x: 0, y: 0 };

  constructor(
    private readonly getScreen: () => Readonly<ScreenSize>,
    private readonly getField: () => Readonly<FieldBounds>,
  ) {
    this.cloudTexture = createCloudTexture();
    this.ownsTexture = this.cloudTexture !== Texture.WHITE;
    for (const layer of [this.cloudLayer, this.rainLayer]) {
      layer.eventMode = 'none';
      layer.interactiveChildren = false;
      layer.visible = false;
    }
    for (let i = 0; i < CLASSIC_CLOUD_POOL; i += 1) {
      const sprite = new Sprite(this.cloudTexture);
      sprite.anchor.set(0.5);
      sprite.blendMode = 'multiply';
      sprite.visible = false;
      this.cloudX[i] = frac(i * 0.618034 + 0.13);
      this.cloudY[i] = frac(i * 0.381966 * 2 + 0.31);
      this.clouds.push(sprite);
      this.cloudLayer.addChild(sprite);
    }
    for (let i = 0; i < CLASSIC_RAIN_POOL; i += 1) {
      const sprite = new Sprite(Texture.WHITE);
      sprite.anchor.set(0.5);
      sprite.width = RAIN_STREAK_WIDTH;
      sprite.height = RAIN_STREAK_HEIGHT;
      sprite.alpha = RAIN_ALPHA;
      sprite.visible = false;
      // R2 low-discrepancy sequence: an even scatter that needs no random numbers.
      this.rainX[i] = frac(i * 0.7548776662 + 0.123);
      this.rainY[i] = frac(i * 0.5698402910 + 0.37);
      this.rain.push(sprite);
      this.rainLayer.addChild(sprite);
    }
  }

  /** Number of display objects this pool owns (a test pins that it never changes). */
  get displayCount(): number { return this.clouds.length + this.rain.length + 2; }

  /**
   * Cloud shadows keep their WORLD anchor when the map turns: their field positions are computed as
   * if the park were unrotated and `mapper` carries each point into the current view. `key` (the view
   * rotation) is part of the change signature, so a turn repositions the pool once and then costs nothing.
   */
  setViewMapper(key: number, mapper: ((x: number, y: number, out: { x: number; y: number }) => void) | null): void {
    this.mapper = mapper;
    this.mapperKey = key;
    this.cloudSignature[0] = -1;
  }

  apply(effects: Readonly<WeatherEffects>): void {
    if (this.destroyed) return;
    if (!effects.active) {
      this.cloudLayer.visible = false;
      this.rainLayer.visible = false;
      this.cloudSignature[0] = -1;
      this.rainSignature[0] = -1;
      return;
    }
    this.applyClouds(effects);
    this.applyRain(effects);
  }

  private applyClouds(effects: Readonly<WeatherEffects>): void {
    const count = effects.cloudStrength > 0 ? Math.min(CLASSIC_CLOUD_POOL, Math.ceil(CLASSIC_CLOUD_POOL * effects.cloudCover)) : 0;
    const field = this.getField();
    const s = this.cloudSignature;
    const unchanged = s[0] === count && s[1] === effects.cloudStrength && s[2] === effects.cloudOffsetX && s[3] === effects.cloudOffsetY
      && s[4] === effects.cloudTint[0] && s[5] === effects.cloudTint[1] && s[6] === effects.cloudTint[2]
      && s[7] === field.x && s[8] === field.y && s[9] === field.width && s[10] === field.height
      && s[11] === this.mapperKey;
    if (unchanged) return;
    s[0] = count;
    s[1] = effects.cloudStrength;
    s[2] = effects.cloudOffsetX;
    s[3] = effects.cloudOffsetY;
    s[4] = effects.cloudTint[0];
    s[5] = effects.cloudTint[1];
    s[6] = effects.cloudTint[2];
    s[7] = field.x;
    s[8] = field.y;
    s[9] = field.width;
    s[10] = field.height;
    s[11] = this.mapperKey;
    this.cloudLayer.visible = count > 0;
    if (count === 0) return;

    const cloudWidth = field.width * CLOUD_WIDTH_SHARE;
    const cloudHeight = cloudWidth * CLOUD_ASPECT;
    // The field is padded by one cloud so the wrap happens off the park, out of sight.
    const spanX = field.width + cloudWidth;
    const spanY = field.height + cloudHeight;
    const driftX = effects.cloudOffsetX / CLOUD_WRAP_VOXELS;
    const driftY = effects.cloudOffsetY / CLOUD_WRAP_VOXELS;
    const tintHex = packRgb(effects.cloudTint);
    const retint = tintHex !== this.cloudTintHex;
    this.cloudTintHex = tintHex;
    for (let i = 0; i < CLASSIC_CLOUD_POOL; i += 1) {
      const sprite = this.clouds[i];
      const visible = i < count;
      if (retint) sprite.tint = tintHex;
      if (sprite.visible !== visible) sprite.visible = visible;
      if (!visible) continue;
      sprite.width = cloudWidth * (0.8 + 0.4 * frac(i * 0.37));
      sprite.height = cloudHeight * (0.8 + 0.4 * frac(i * 0.53));
      let x = field.x - cloudWidth / 2 + frac(this.cloudX[i] + driftX) * spanX;
      let y = field.y - cloudHeight / 2 + frac(this.cloudY[i] + driftY) * spanY;
      if (this.mapper) {
        this.mapper(x, y, this.mapped);
        x = this.mapped.x;
        y = this.mapped.y;
      }
      sprite.x = x;
      sprite.y = y;
      sprite.alpha = 0.6 + 0.4 * frac(i * 0.71 + 0.2);
    }
  }

  private applyRain(effects: Readonly<WeatherEffects>): void {
    const screen = this.getScreen();
    const count = Math.min(CLASSIC_RAIN_POOL, Math.round(CLASSIC_RAIN_POOL * effects.rainDensity));
    const s = this.rainSignature;
    const unchanged = s[0] === count && s[1] === effects.rainSlant && s[2] === effects.rainPhaseA && s[3] === effects.rainPhaseB
      && s[4] === effects.rainTint[0] && s[5] === effects.rainTint[1] && s[6] === effects.rainTint[2]
      && s[7] === screen.width && s[8] === screen.height;
    if (unchanged) return;
    s[0] = count;
    s[1] = effects.rainSlant;
    s[2] = effects.rainPhaseA;
    s[3] = effects.rainPhaseB;
    s[4] = effects.rainTint[0];
    s[5] = effects.rainTint[1];
    s[6] = effects.rainTint[2];
    s[7] = screen.width;
    s[8] = screen.height;
    this.rainLayer.visible = count > 0;
    if (count === 0 || screen.width <= 0 || screen.height <= 0) return;

    const slant = effects.rainSlant;
    const rotation = -Math.atan(slant);
    const rotationChanged = rotation !== this.rainRotation;
    this.rainRotation = rotation;
    const tintHex = packRgb(effects.rainTint);
    const retint = tintHex !== this.rainTintHex;
    this.rainTintHex = tintHex;
    const width = screen.width;
    const height = screen.height;
    for (let i = 0; i < CLASSIC_RAIN_POOL; i += 1) {
      const sprite = this.rain[i];
      const visible = i < count;
      if (retint) sprite.tint = tintHex;
      if (rotationChanged) sprite.rotation = rotation;
      if (sprite.visible !== visible) sprite.visible = visible;
      if (!visible) continue;
      // Two parallax sheets: even streaks follow phase A, odd ones the slower phase B.
      const phase = (i & 1) === 0 ? effects.rainPhaseA : effects.rainPhaseB;
      const y = (this.rainY[i] * height + phase * RAIN_PIXELS_PER_ROW) % height;
      const x = (this.rainX[i] * width + slant * y) % width;
      sprite.x = x;
      sprite.y = y;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cloudLayer.removeFromParent();
    this.rainLayer.removeFromParent();
    this.cloudLayer.destroy({ children: true });
    this.rainLayer.destroy({ children: true });
    if (this.ownsTexture) this.cloudTexture.destroy(true);
  }
}
