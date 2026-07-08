import type { Scene } from '@babylonjs/core/scene';
import type { Ray } from '@babylonjs/core/Culling/ray';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { GameMaterials } from './materials';
import type { ShatterSystem } from './shatter';
import { Obstacle, createObstacle, worldCenterToRef } from './obstacles';
import type { ObstacleSpec, HitOutcome } from './obstacles';
import { CONFIG } from './config';
import type { PowerUpKind } from './config';

interface PatternEntry {
  spec: ObstacleSpec;
  dz: number;
}

interface Pattern {
  len: number; // z-extent including breathing room
  intense?: boolean; // counts toward the forced-rest streak
  rest?: boolean; // pure-reward pattern used as a recovery moment
  entries: PatternEntry[];
}

const e = (spec: ObstacleSpec, dz: number): PatternEntry => ({ spec, dz });

// Fixed onboarding sequence — first 3 patterns of every run (doc §17, §31).
const OPENERS: Pattern[] = [
  { len: 26, entries: [e({ t: 'flat' }, 0)] },
  { len: 30, entries: [e({ t: 'flat' }, 0), e({ t: 'bonus', size: 'm' }, 13)] },
  { len: 30, entries: [e({ t: 'gate' }, 0), e({ t: 'bonus', size: 's', x: 1.3 }, 11)] },
];

// Fully zone-exclusive hazard pools — each zone threatens its own way.
// Zone 0 Crystal Wake: pure static glass. Zone 1 Prism Tunnel: everything
// moves. Zone 2 Fracture Hall: armor & ambush. Zone 3 Mirror Storm: chaos.
const ZONE_PATTERNS: Pattern[][] = [
  // --- zone 0: flat, gate, cubes, grid ---
  [
    { len: 26, entries: [e({ t: 'flat' }, 0), e({ t: 'bonus', size: 's' }, 8)] },
    { len: 24, entries: [e({ t: 'gate' }, 0)] },
    { len: 26, entries: [e({ t: 'cubes', extra: 2 }, 0)] },
    { len: 26, entries: [e({ t: 'grid' }, 0)] },
    { len: 30, entries: [e({ t: 'flat', w: 2.6 }, 0), e({ t: 'flat' }, 13)] },
    { len: 32, entries: [e({ t: 'grid' }, 0), e({ t: 'bonus', size: 'm' }, 12)] },
    {
      len: 26,
      entries: [e({ t: 'flat' }, 0), e({ t: 'bonus', size: 's', x: -1.3 }, 7), e({ t: 'bonus', size: 's', x: 1.3 }, 11)],
    },
    { len: 34, entries: [e({ t: 'gate' }, 0), e({ t: 'cubes' }, 15)] },
  ],

  // --- zone 1: blade, pendulum, mover, dualblade, orbit ---
  [
    { len: 26, entries: [e({ t: 'blade' }, 0)] },
    { len: 26, entries: [e({ t: 'pendulum' }, 0)] },
    { len: 26, entries: [e({ t: 'mover' }, 0)] },
    { len: 28, entries: [e({ t: 'dualblade' }, 0)], intense: true },
    { len: 28, entries: [e({ t: 'orbit' }, 0)], intense: true },
    { len: 30, entries: [e({ t: 'blade' }, 0), e({ t: 'bonus', size: 'm' }, 11)] },
    { len: 28, entries: [e({ t: 'mover' }, 0), e({ t: 'bonus', size: 'l', x: 1.35 }, 9)] },
    { len: 36, entries: [e({ t: 'pendulum' }, 0), e({ t: 'dualblade' }, 16)], intense: true },
    { len: 36, entries: [e({ t: 'orbit' }, 0), e({ t: 'bonus', size: 'm' }, 12), e({ t: 'blade' }, 18)], intense: true },
  ],

  // --- zone 2: reinforced, danger, door, stalactite ---
  [
    { len: 28, entries: [e({ t: 'reinforced' }, 0)], intense: true },
    { len: 24, entries: [e({ t: 'danger' }, 0)] },
    { len: 30, entries: [e({ t: 'door' }, 0)], intense: true },
    { len: 30, entries: [e({ t: 'stalactite' }, 0)], intense: true },
    { len: 30, entries: [e({ t: 'reinforced' }, 0), e({ t: 'bonus', size: 'l' }, 11)] },
    // risk bonus: reward gem right beside the danger crystal (doc §29)
    { len: 30, entries: [e({ t: 'danger' }, 0), e({ t: 'bonus', size: 'l', x: -1.35 }, 1)] },
    { len: 40, entries: [e({ t: 'door' }, 0), e({ t: 'stalactite' }, 18)], intense: true },
    { len: 38, entries: [e({ t: 'stalactite' }, 0), e({ t: 'danger' }, 16)], intense: true },
    { len: 40, entries: [e({ t: 'reinforced' }, 0), e({ t: 'door' }, 18)], intense: true },
  ],

  // --- zone 3: phase, wave, twinmover (simultaneity is the identity) ---
  [
    { len: 28, entries: [e({ t: 'phase' }, 0)], intense: true },
    { len: 30, entries: [e({ t: 'wave' }, 0)], intense: true },
    { len: 28, entries: [e({ t: 'twinmover' }, 0)], intense: true },
    { len: 30, entries: [e({ t: 'phase' }, 0), e({ t: 'bonus', size: 'm', x: 1.3 }, 10)] },
    { len: 38, entries: [e({ t: 'twinmover' }, 0), e({ t: 'phase' }, 17)], intense: true },
    { len: 40, entries: [e({ t: 'wave' }, 0), e({ t: 'twinmover' }, 18), e({ t: 'bonus', size: 'l', x: -1.3 }, 12)], intense: true },
    { len: 46, entries: [e({ t: 'phase' }, 0), e({ t: 'wave' }, 15), e({ t: 'twinmover' }, 32)], intense: true },
  ],
];

// Recovery patterns — pure ammo gifts, no threats (doc §31 difficulty rules).
const REST_PATTERNS: Pattern[] = [
  {
    len: 22,
    rest: true,
    entries: [e({ t: 'bonus', size: 'm', x: -1.2 }, 0), e({ t: 'bonus', size: 's', x: 1.2 }, 6)],
  },
  {
    len: 24,
    rest: true,
    entries: [e({ t: 'bonus', size: 'l' }, 0), e({ t: 'bonus', size: 's', x: 1.25 }, 7)],
  },
];

const POWERUP_KINDS: PowerUpKind[] = ['multishot', 'slowrift', 'shield'];

export class SegmentSpawner {
  active: Obstacle[] = [];
  /** Fired when the player slips past a still-live hazard (a dodge). */
  onDodge: () => void = () => {};

  private scene: Scene;
  private materials: GameMaterials;
  private nextZ = 0;
  private nextPowerupZ = 0;
  private queue: Pattern[] = [];
  private intenseStreak = 0;

  constructor(scene: Scene, materials: GameMaterials) {
    this.scene = scene;
    this.materials = materials;
  }

  reset(camZ: number) {
    for (const o of this.active) o.dispose();
    this.active = [];
    this.nextZ = camZ + CONFIG.spawn.firstObstacleZ;
    this.nextPowerupZ = camZ + CONFIG.powerups.firstAt;
    this.queue = [...OPENERS];
    this.intenseStreak = 0;
  }

  update(dt: number, time: number, camZ: number, zone: number, gameSpeed: number) {
    // spawn further ahead as the run speeds up so reaction time stays fair
    const ahead = Math.max(CONFIG.spawn.ahead, gameSpeed * 3.6);
    while (this.nextZ < camZ + ahead) this.spawnPattern(zone, gameSpeed);

    // rare golden power-up pickups, off the center line
    if (this.nextPowerupZ < camZ + ahead) {
      const kind = POWERUP_KINDS[Math.floor(Math.random() * POWERUP_KINDS.length)];
      const x = Math.random() < 0.5 ? -0.9 : 0.9;
      this.active.push(createObstacle(this.scene, this.materials, { t: 'powerup', kind, x }, this.nextPowerupZ));
      const [min, max] = CONFIG.powerups.spacing;
      this.nextPowerupZ += min + Math.random() * (max - min);
    }

    for (let i = this.active.length - 1; i >= 0; i--) {
      const o = this.active[i];
      o.update(dt, time, camZ);
      if (o.z < camZ - CONFIG.spawn.behind) {
        o.dispose();
        this.active.splice(i, 1);
      }
    }
  }

  private spawnPattern(zone: number, gameSpeed: number) {
    const pattern = this.pickPattern(zone);
    for (const entry of pattern.entries) {
      this.active.push(createObstacle(this.scene, this.materials, entry.spec, this.nextZ + entry.dz));
    }
    // gaps stretch with speed so time-between-patterns shrinks fairly
    this.nextZ += pattern.len + Math.max(8, 14 - zone * 2) + Math.max(0, (gameSpeed - 12) * 0.35);
  }

  private pickPattern(zone: number): Pattern {
    const fromQueue = this.queue.shift();
    if (fromQueue) return fromQueue;

    if (this.intenseStreak >= CONFIG.spawn.intenseBeforeRest) {
      this.intenseStreak = 0;
      return REST_PATTERNS[Math.floor(Math.random() * REST_PATTERNS.length)];
    }

    const pool = ZONE_PATTERNS[Math.min(zone, ZONE_PATTERNS.length - 1)];
    const pattern = pool[Math.floor(Math.random() * pool.length)];
    if (pattern.intense) this.intenseStreak++;
    else this.intenseStreak = 0;
    return pattern;
  }

  /**
   * Aim assist (mobile fairness): find the best breakable piece within a
   * small cone around the tap ray. Returns a *predicted* aim point that
   * leads moving pieces (blades, pendulums, movers) by their tracked
   * velocity so timed shots actually connect.
   */
  findAimTarget(ray: Ray, projectileSpeed: number): Vector3 | null {
    const cfg = CONFIG.aimAssist;
    const tmp = new Vector3();
    let best: Vector3 | null = null;
    let bestScore = -Infinity;

    for (const o of this.active) {
      const dz = o.z - ray.origin.z;
      if (dz < 2 || dz > cfg.maxDist) continue;

      for (const piece of o.pieces) {
        if (!piece.alive) continue;
        const center = piece.hasPrev ? piece.center : worldCenterToRef(piece.mesh, piece.center);
        tmp.copyFrom(center).subtractInPlace(ray.origin);
        const dist = tmp.length();
        if (dist < 2) continue;
        tmp.scaleInPlace(1 / dist);
        const cos = Vector3.Dot(tmp, ray.direction);
        const angle = Math.acos(Math.min(1, Math.max(-1, cos)));

        const small = piece.kind === 'bonus' || piece.kind === 'power';
        const limit = small ? cfg.bonusAngle : cfg.maxAngle;
        if (angle > limit) continue;

        // The tap direction dominates: a target the player aimed straight at
        // beats a higher-priority one elsewhere in the cone. Priority only
        // breaks near-ties (e.g. wall and gem both close to the ray).
        const priority = piece.blocking ? 3 : piece.kind === 'danger' || small ? 2 : 1;
        const score = priority * 10 - angle * 500 - dist * 0.1;
        if (score <= bestScore) continue;
        bestScore = score;

        // lead the target by its estimated velocity over the flight time
        const lead = dist / projectileSpeed;
        best = new Vector3(
          center.x + piece.velocity.x * lead,
          center.y + piece.velocity.y * lead,
          center.z + piece.velocity.z * lead
        );
      }
    }
    return best;
  }

  /** Projectile hit test across every nearby obstacle. */
  testHit(
    point: Vector3,
    radius: number,
    dir: Vector3,
    shatter: ShatterSystem,
    impactSpeed: number
  ): HitOutcome | null {
    for (const o of this.active) {
      if (Math.abs(o.z - point.z) > 4.5) continue;
      const outcome = o.testHit(point, radius, dir, shatter, impactSpeed);
      if (outcome) return outcome;
    }
    return null;
  }

  /** Camera-vs-obstacle crash test for the current frame. */
  checkCollision(camPos: Vector3): Obstacle | null {
    for (const o of this.active) {
      if (o.collided || o.passed) continue;
      if (camPos.z > o.z + 1.4) {
        o.passed = true;
        if (o.anyBlockingAlive) this.onDodge();
        continue;
      }
      if (camPos.z > o.z - 0.7 && o.anyBlockingAlive && o.cameraOverlap(camPos, 0.5)) {
        o.collided = true;
        return o;
      }
    }
    return null;
  }

  /**
   * Clear every hazard within `ahead` meters in front of the camera (used on
   * revive so the player doesn't instantly re-collide with the wall that just
   * killed them). Shatters each so it reads as a clean burst, not a pop-out.
   */
  clearNear(camZ: number, ahead: number, shatter: ShatterSystem) {
    for (const o of this.active) {
      if (o.disposed || o.collided) continue;
      if (o.z > camZ - 2 && o.z < camZ + ahead && o.anyBlockingAlive) {
        o.forceBreak(shatter, FORWARD_DIR);
        o.passed = true;
      }
    }
  }
}

const FORWARD_DIR = new Vector3(0, 0, 1);
