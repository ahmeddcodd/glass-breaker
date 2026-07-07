// Every gameplay tunable in one place. Values follow the design doc
// (speeds §18, ammo §11-12, scoring §13, penalties §14, zones §16).

export interface ZonePalette {
  name: string;
  startDist: number; // meters travelled at which the zone begins
  tier: number; // difficulty tier used by the segment spawner
  fog: string;
  clear: string;
  strip: string; // neon accent color (obstacle frames + corridor tint target)
  ambient: string; // corridor diffuse tint driver
  fogStart: number; // per-zone atmosphere depth
  fogEnd: number;
  hemi: number; // hemispheric light intensity
  dir: number; // directional light intensity
}

export const ZONES: ZonePalette[] = [
  {
    name: 'Crystal Wake', startDist: 0, tier: 0,
    fog: '#0c1a33', clear: '#050b18', strip: '#3fd2ff', ambient: '#26436b',
    fogStart: 26, fogEnd: 102, hemi: 0.9, dir: 0.6,
  },
  {
    name: 'Prism Tunnel', startDist: 300, tier: 1,
    fog: '#170f38', clear: '#0a0620', strip: '#b46bff', ambient: '#3a2a66',
    fogStart: 22, fogEnd: 90, hemi: 0.8, dir: 0.72,
  },
  {
    name: 'Fracture Hall', startDist: 680, tier: 2,
    fog: '#26080f', clear: '#120409', strip: '#ff4d63', ambient: '#54202c',
    fogStart: 14, fogEnd: 68, hemi: 0.55, dir: 0.45,
  },
  {
    name: 'Mirror Storm', startDist: 1120, tier: 3,
    fog: '#04181e', clear: '#020a0d', strip: '#c8f6ff', ambient: '#2c4a52',
    fogStart: 30, fogEnd: 115, hemi: 1.0, dir: 0.78,
  },
];

export interface ZoneBlend {
  a: ZonePalette;
  b: ZonePalette;
  t: number; // 0 = fully a, 1 = fully b
  index: number; // wrapped palette index of zone b (the zone we're in / entering)
  prevIndex: number; // wrapped palette index of zone a (crossfading out)
}

const ZONE_BLEND_LEN = 30; // meters over which palettes crossfade
// Past the last authored zone the run loops the four platforms forever; each
// looped zone spans this many meters (matches the last authored span, 1120-680).
const LOOP_SEG = 440;

/**
 * Monotonic "zone step" for a travelled distance: 0,1,2,3,4,5,… where the first
 * ZONES.length steps use the authored startDist values and every step past that
 * is a fixed LOOP_SEG apart. The palette/variant is `step % ZONES.length`, so
 * the four platforms cycle endlessly (…Mirror Storm → Crystal Wake → …).
 * Returns the step plus the start distance of that step (for crossfade math).
 */
function zoneStepAt(distance: number): { step: number; start: number } {
  const last = ZONES.length - 1;
  const lastStart = ZONES[last].startDist;
  if (distance < lastStart) {
    let idx = 0;
    for (let i = 0; i < ZONES.length; i++) {
      if (distance >= ZONES[i].startDist) idx = i;
    }
    return { step: idx, start: ZONES[idx].startDist };
  }
  const extra = Math.floor((distance - lastStart) / LOOP_SEG);
  return { step: last + extra, start: lastStart + extra * LOOP_SEG };
}

/** Which zone a travelled distance falls in, plus the crossfade into it.
 *  `index` is the wrapped palette index (0..ZONES.length-1); the run loops. */
export function zoneBlendAt(distance: number): ZoneBlend {
  const { step, start } = zoneStepAt(distance);
  const index = step % ZONES.length;
  const prevIndex = step === 0 ? 0 : (step - 1) % ZONES.length;
  const b = ZONES[index];
  const a = ZONES[prevIndex];
  const t = step === 0 ? 1 : Math.min(1, (distance - start) / ZONE_BLEND_LEN);
  return { a, b, t, index, prevIndex };
}

/** Wrapped zone index only (no blend) — used for corridor segment styling. */
export function zoneIndexAt(distance: number): number {
  return zoneStepAt(distance).step % ZONES.length;
}

export const CONFIG = {
  corridor: {
    width: 6,
    height: 7,
    segmentLength: 8,
    visibleSegments: 16,
    camHeight: 2.2,
  },

  // [elapsed seconds, units/sec] — lerped between steps for a continuous ramp
  speedCurve: [
    [0, 13],
    [12, 17],
    [28, 22],
    [45, 28],
  ] as [number, number][],
  // past the last curve step the speed keeps climbing forever (soft-capped)
  endlessSpeed: {
    growth: 0.14, // extra units/sec gained per second
    maxExtra: 8, // hard ceiling: 28 + 8 = 36 u/s (reached ~55s after the curve)
    milestones: [17, 22, 26, 28, 31, 34, 36], // "SPEED UP!" callouts
  },
  startDriftSpeed: 3.2, // slow tunnel drift behind the start screen

  projectile: {
    speed: 110, // at base game speed; scales up as the run speeds up
    speedPerGameSpeed: 1.4, // extra sphere speed per unit of game speed over 12
    gravity: 10, // downward pull — spheres fly a shallow ballistic arc
    bounce: 0.45, // floor restitution; walls are stiffer, ceiling kills vy
    lifetime: 2.5,
    radius: 0.22,
    poolSize: 12,
    aimDistance: 32, // spheres converge on the tap ray at this depth
  },

  aimAssist: {
    maxAngle: 0.095, // radians — magnetism cone around the tap ray
    bonusAngle: 0.125, // wider cone for small bonus crystals
    maxDist: 55,
    strength: 0.75, // 0 = raw tap ray, 1 = full snap to target center
  },

  ammo: {
    start: 25,
    lowWarning: 5,
  },

  score: {
    glass: 10,
    danger: 25,
    reinforced: 25,
    bonus: 15,
    perfect: 20, // extra points for a dead-center hit
    perfectAmmo: 1,
    distanceRate: 1, // passive points per meter travelled
  },

  combo: {
    window: 3.0, // seconds between hits before the chain resets
    tiers: [
      [3, 1.5],
      [5, 2],
      [10, 3],
    ] as [number, number][],
    milestoneAmmo: 2, // spheres granted when a tier is reached
  },

  collision: {
    light: 5, // flat panels, cubes, gates
    heavy: 10, // moving hazards, danger crystals
    crash: 15, // reinforced plates
  },

  spawn: {
    ahead: 78, // spawn segments this far in front of the camera
    behind: 10, // dispose obstacles this far behind
    firstObstacleZ: 34, // ~3s from the start at base speed
    intenseBeforeRest: 3, // force a breather after this many hard patterns
  },

  shatter: {
    shardPool: 220,
    sparkPool: 140,
    gravity: -13,
  },

  powerups: {
    firstAt: 180, // meters before the first pickup appears
    spacing: [220, 320] as [number, number], // meters between pickups
    multiShot: { duration: 6, spread: 0.055 }, // 3-sphere fan, radians of yaw
    slowRift: { duration: 3.5, scale: 0.45 }, // real-time seconds, world dt scale
  },
};

export type PowerUpKind = 'multishot' | 'slowrift' | 'shield';

export const POWERUP_LABELS: Record<PowerUpKind, string> = {
  multishot: 'MULTI-SHOT',
  slowrift: 'SLOW RIFT',
  shield: 'SHIELD PULSE',
};

export const BEST_SCORE_KEY = 'glass-breaker-best';
