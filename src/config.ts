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
  index: number; // index of zone b (the zone we're in / entering)
}

const ZONE_BLEND_LEN = 30; // meters over which palettes crossfade

/** Which zone a travelled distance falls in, plus the crossfade into it. */
export function zoneBlendAt(distance: number): ZoneBlend {
  let idx = 0;
  for (let i = 0; i < ZONES.length; i++) {
    if (distance >= ZONES[i].startDist) idx = i;
  }
  const b = ZONES[idx];
  const a = ZONES[Math.max(0, idx - 1)];
  const t = idx === 0 ? 1 : Math.min(1, (distance - b.startDist) / ZONE_BLEND_LEN);
  return { a, b, t, index: idx };
}

/** Zone index only (no blend) — used for corridor segment styling. */
export function zoneIndexAt(distance: number): number {
  let idx = 0;
  for (let i = 0; i < ZONES.length; i++) {
    if (distance >= ZONES[i].startDist) idx = i;
  }
  return idx;
}

export const CONFIG = {
  corridor: {
    width: 6,
    height: 7,
    segmentLength: 8,
    visibleSegments: 16,
    camHeight: 2.2,
  },

  // [elapsed seconds, units/sec] — lerped between steps for smooth ramps
  speedCurve: [
    [0, 12],
    [20, 15],
    [45, 18],
    [75, 22],
  ] as [number, number][],
  // past the last curve step the speed keeps climbing forever (soft-capped)
  endlessSpeed: {
    growth: 0.08, // extra units/sec gained per second
    maxExtra: 12, // hard ceiling: 22 + 12 = 34 u/s
    milestones: [15, 18, 22, 25, 28, 31, 34], // "SPEED UP!" callouts
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
