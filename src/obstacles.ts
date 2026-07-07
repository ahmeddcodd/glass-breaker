import type { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { CreatePolyhedron } from '@babylonjs/core/Meshes/Builders/polyhedronBuilder';
import { CreateTorus } from '@babylonjs/core/Meshes/Builders/torusBuilder';
import { Vector3, Matrix } from '@babylonjs/core/Maths/math.vector';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import type { GameMaterials } from './materials';
import type { ShatterSystem } from './shatter';
import { CONFIG } from './config';
import type { PowerUpKind } from './config';

export type PieceKind = 'glass' | 'reinforced' | 'bonus' | 'danger' | 'power';

export interface Piece {
  mesh: Mesh;
  kind: PieceKind;
  blocking: boolean;
  hp: number;
  alive: boolean;
  scoreValue: number;
  ammoValue: number;
  perfectRadius: number; // local-space "dead center" radius; 0 = no perfect zone
  shatterSize: number;
  power?: PowerUpKind; // set on power-up pickups
  // world-space motion tracking for aim-assist target leading
  center: Vector3;
  prevCenter: Vector3;
  velocity: Vector3;
  hasPrev: boolean;
}

export interface HitOutcome {
  score: number; // base points, before the combo multiplier
  ammo: number;
  perfect: boolean;
  broke: boolean; // false when a reinforced plate only cracked
  kind: PieceKind;
  hitStop: boolean;
  point: Vector3;
  power?: PowerUpKind;
}

const SHATTER_COLORS: Record<PieceKind, Color4> = {
  glass: new Color4(0.72, 0.9, 1, 1),
  reinforced: new Color4(0.6, 0.82, 0.97, 1),
  bonus: new Color4(0.45, 1, 0.85, 1),
  danger: new Color4(1, 0.35, 0.45, 1),
  power: new Color4(1, 0.85, 0.4, 1),
};

const tmpMatrix = new Matrix();
const tmpLocal = new Vector3();

/** True when a world point (padded) lies inside a mesh's local bounding box.
 *  computeWorldMatrix(false) reuses the cached matrix unless the transform is
 *  dirty — vital because projectiles test this many times per frame. */
function pointInMesh(mesh: Mesh, point: Vector3, pad: number, outLocal?: Vector3): boolean {
  mesh.computeWorldMatrix(false).invertToRef(tmpMatrix);
  Vector3.TransformCoordinatesToRef(point, tmpMatrix, tmpLocal);
  const bb = mesh.getBoundingInfo().boundingBox;
  const ok =
    tmpLocal.x >= bb.minimum.x - pad &&
    tmpLocal.x <= bb.maximum.x + pad &&
    tmpLocal.y >= bb.minimum.y - pad &&
    tmpLocal.y <= bb.maximum.y + pad &&
    tmpLocal.z >= bb.minimum.z - pad &&
    tmpLocal.z <= bb.maximum.z + pad;
  if (ok && outLocal) outLocal.copyFrom(tmpLocal);
  return ok;
}

/** Fresh world-space center of a mesh's bounding box. */
export function worldCenterToRef(mesh: Mesh, out: Vector3): Vector3 {
  const m = mesh.computeWorldMatrix(false);
  Vector3.TransformCoordinatesToRef(mesh.getBoundingInfo().boundingBox.center, m, out);
  return out;
}

export class Obstacle {
  root: TransformNode;
  pieces: Piece[] = [];
  collisionCost: number;
  /** Extra decorative meshes destroyed on dispose (frames, pendulum arms). */
  decor: Mesh[] = [];
  collided = false;
  passed = false;
  disposed = false;
  animate: ((self: Obstacle, dt: number, time: number, camZ: number) => void) | null = null;
  private phase = Math.random() * Math.PI * 2;

  constructor(scene: Scene, z: number, collisionCost: number) {
    this.root = new TransformNode('obstacle', scene);
    this.root.position.z = z;
    this.collisionCost = collisionCost;
  }

  get z(): number {
    return this.root.position.z;
  }

  get time0(): number {
    return this.phase;
  }

  get anyBlockingAlive(): boolean {
    return this.pieces.some((p) => p.alive && p.blocking);
  }

  update(dt: number, time: number, camZ: number) {
    if (!this.animate) return;
    this.animate(this, dt, time + this.phase, camZ);
    if (dt > 0) this.trackVelocities(dt);
  }

  /** Estimate world-space velocity of each animated piece for aim leading. */
  private trackVelocities(dt: number) {
    for (const piece of this.pieces) {
      if (!piece.alive) continue;
      worldCenterToRef(piece.mesh, piece.center);
      if (piece.hasPrev) {
        piece.velocity.set(
          (piece.center.x - piece.prevCenter.x) / dt,
          (piece.center.y - piece.prevCenter.y) / dt,
          (piece.center.z - piece.prevCenter.z) / dt
        );
      }
      piece.prevCenter.copyFrom(piece.center);
      piece.hasPrev = true;
    }
  }

  /** Projectile test: returns a hit outcome and applies break side effects.
   *  `impactSpeed` scales the shard spray so fast spheres hit harder. */
  testHit(
    point: Vector3,
    radius: number,
    dir: Vector3,
    shatter: ShatterSystem,
    impactSpeed = CONFIG.projectile.speed
  ): HitOutcome | null {
    const momentum = Math.min(2, Math.max(0.6, impactSpeed / CONFIG.projectile.speed));
    for (const piece of this.pieces) {
      if (!piece.alive) continue;
      if (!pointInMesh(piece.mesh, point, radius, tmpLocal)) continue;

      const perfect =
        piece.perfectRadius > 0 &&
        Math.abs(tmpLocal.x) < piece.perfectRadius &&
        Math.abs(tmpLocal.y) < piece.perfectRadius;

      piece.hp -= 1;
      const color = SHATTER_COLORS[piece.kind];
      const center = worldCenterToRef(piece.mesh, piece.center);

      if (piece.hp > 0) {
        // Reinforced plate: first hit only cracks it (doc §15-F). The
        // material swap + crack star happen in the reinforced builder wrapper.
        shatter.burst(point.clone(), dir, color, 8, 0.5, momentum);
        return {
          score: 0,
          ammo: 0,
          perfect: false,
          broke: false,
          kind: piece.kind,
          hitStop: false,
          point: point.clone(),
        };
      }

      piece.alive = false;
      piece.mesh.setEnabled(false);
      this.hideDecorIfCleared();
      const count = Math.round((12 + piece.shatterSize * 10) * (0.8 + momentum * 0.3));
      shatter.burst(center.clone(), dir, color, count, piece.shatterSize, momentum);

      return {
        score: piece.scoreValue,
        ammo: piece.ammoValue + (perfect ? CONFIG.score.perfectAmmo : 0),
        perfect,
        broke: true,
        kind: piece.kind,
        hitStop: piece.kind === 'danger',
        point: center.clone(),
        power: piece.power,
      };
    }
    return null;
  }

  /** Does any live blocking piece overlap the camera point right now? */
  cameraOverlap(camPos: Vector3, pad: number): boolean {
    for (const piece of this.pieces) {
      if (!piece.alive || !piece.blocking) continue;
      if (pointInMesh(piece.mesh, camPos, pad)) return true;
    }
    return false;
  }

  /** Collision smash: shatter every live piece with no rewards. */
  forceBreak(shatter: ShatterSystem, dir: Vector3) {
    for (const piece of this.pieces) {
      if (!piece.alive) continue;
      piece.alive = false;
      piece.mesh.setEnabled(false);
      worldCenterToRef(piece.mesh, piece.center);
      shatter.burst(piece.center.clone(), dir, SHATTER_COLORS[piece.kind], 14, piece.shatterSize);
    }
    this.hideDecorIfCleared();
  }

  /** Once nothing breakable remains, standalone decor (blade hubs, pendulum
   *  arms, orbit tracks) must vanish too — no floating leftovers mid-path. */
  private hideDecorIfCleared() {
    if (this.pieces.some((p) => p.alive)) return;
    for (const d of this.decor) d.setEnabled(false);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const piece of this.pieces) piece.mesh.dispose();
    for (const d of this.decor) d.dispose();
    this.root.dispose();
  }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export type ObstacleSpec =
  | { t: 'flat'; x?: number; y?: number; w?: number; h?: number }
  | { t: 'gate' }
  | { t: 'blade'; speed?: number }
  | { t: 'pendulum'; freq?: number }
  | { t: 'cubes'; extra?: number }
  | { t: 'reinforced' }
  | { t: 'mover'; range?: number; speed?: number }
  | { t: 'danger'; x?: number; y?: number }
  | { t: 'bonus'; size: 's' | 'm' | 'l'; x?: number; y?: number }
  // zone-exclusive signatures
  | { t: 'grid' } // zone 0: 3×3 honeycomb, break the center
  | { t: 'dualblade'; speed?: number } // zone 1: counter-rotating pair
  | { t: 'orbit'; speed?: number } // zone 1: gems on an elliptical orbit
  | { t: 'door' } // zone 2: panels slide shut as you approach
  | { t: 'stalactite' } // zone 2: trembles, then drops onto the path
  | { t: 'phase'; period?: number } // zone 3: strobe barrier
  | { t: 'wave' } // zone 3: staggered glass-storm wall
  | { t: 'twinmover'; speed?: number } // zone 3: opposed sliding pair
  | { t: 'powerup'; kind: PowerUpKind; x?: number };

interface BuildCtx {
  scene: Scene;
  materials: GameMaterials;
}

function glassPanel(ctx: BuildCtx, parent: TransformNode, w: number, h: number, x: number, y: number): Mesh {
  const mesh = CreateBox('panel', { width: w, height: h, depth: 0.09 }, ctx.scene);
  mesh.material = ctx.materials.glass;
  mesh.parent = parent;
  mesh.position.set(x, y, 0);
  mesh.isPickable = false;
  return mesh;
}

/** Full emissive border frame around a panel (all four sides). */
function panelFrame(ctx: BuildCtx, panel: Mesh, w: number, h: number): Mesh[] {
  const frames: Mesh[] = [];
  for (const dy of [-h / 2, h / 2]) {
    const bar = CreateBox('frame', { width: w + 0.14, height: 0.07, depth: 0.12 }, ctx.scene);
    bar.material = ctx.materials.strip;
    bar.parent = panel;
    bar.position.set(0, dy, 0);
    bar.isPickable = false;
    frames.push(bar);
  }
  for (const dx of [-w / 2, w / 2]) {
    const bar = CreateBox('frame', { width: 0.07, height: h + 0.14, depth: 0.12 }, ctx.scene);
    bar.material = ctx.materials.strip;
    bar.parent = panel;
    bar.position.set(dx, 0, 0);
    bar.isPickable = false;
    frames.push(bar);
  }
  return frames;
}

/** Glowing ring marking the perfect-hit zone at a panel's center. */
function perfectRing(ctx: BuildCtx, panel: Mesh, radius: number): Mesh {
  const ring = CreateTorus(
    'perfect',
    { diameter: radius * 2, thickness: 0.035, tessellation: 26 },
    ctx.scene
  );
  ring.material = ctx.materials.strip;
  ring.parent = panel;
  ring.rotation.x = Math.PI / 2; // face the camera
  ring.position.z = -0.06;
  ring.isPickable = false;
  return ring;
}

/** Two-layer crystal: transparent shell + hot counter-rotating core. */
function crystal(
  ctx: BuildCtx,
  parent: TransformNode,
  kind: 'bonus' | 'danger',
  size: number
): { shell: Mesh; core: Mesh } {
  let shell: Mesh;
  if (kind === 'bonus') {
    shell = CreatePolyhedron('crystal', { type: 2, size }, ctx.scene);
    shell.material = ctx.materials.bonus;
  } else {
    // spiky silhouette: two octahedra, one rotated 45°
    const a = CreatePolyhedron('ca', { type: 1, size }, ctx.scene);
    const b = CreatePolyhedron('cb', { type: 1, size: size * 0.8 }, ctx.scene);
    b.rotation.y = Math.PI / 4;
    b.scaling.y = 1.25;
    shell = Mesh.MergeMeshes([a, b], true, true)!;
    shell.material = ctx.materials.danger;
    shell.scaling.y = 1.55;
  }
  shell.parent = parent;
  shell.isPickable = false;

  const core = CreatePolyhedron('core', { type: 1, size: size * 0.42 }, ctx.scene);
  core.material = kind === 'bonus' ? ctx.materials.bonusCore : ctx.materials.dangerCore;
  core.parent = shell;
  core.isPickable = false;
  return { shell, core };
}

function addPiece(o: Obstacle, mesh: Mesh, partial: Partial<Piece> & { kind: PieceKind }): Piece {
  const piece: Piece = {
    mesh,
    kind: partial.kind,
    blocking: partial.blocking ?? false,
    hp: partial.hp ?? 1,
    alive: true,
    scoreValue: partial.scoreValue ?? CONFIG.score.glass,
    ammoValue: partial.ammoValue ?? 0,
    perfectRadius: partial.perfectRadius ?? 0,
    shatterSize: partial.shatterSize ?? 1,
    center: new Vector3(),
    prevCenter: new Vector3(),
    velocity: new Vector3(),
    hasPrev: false,
  };
  worldCenterToRef(mesh, piece.center);
  o.pieces.push(piece);
  return piece;
}

const CAM_Y = CONFIG.corridor.camHeight;

export function createObstacle(scene: Scene, materials: GameMaterials, spec: ObstacleSpec, z: number): Obstacle {
  const ctx: BuildCtx = { scene, materials };
  const { collision, score } = CONFIG;

  switch (spec.t) {
    case 'flat': {
      const w = spec.w ?? 3.2;
      const h = spec.h ?? 2.6;
      const o = new Obstacle(scene, z, collision.light);
      const panel = glassPanel(ctx, o.root, w, h, spec.x ?? 0, spec.y ?? CAM_Y);
      o.decor.push(...panelFrame(ctx, panel, w, h), perfectRing(ctx, panel, 0.5));
      addPiece(o, panel, { kind: 'glass', blocking: (spec.x ?? 0) === 0, perfectRadius: 0.5, shatterSize: 1.1 });
      return o;
    }

    case 'gate': {
      // Center panel blocks the path; side panels are combo fodder (doc §15-B).
      const o = new Obstacle(scene, z, collision.light);
      const center = glassPanel(ctx, o.root, 1.5, 2.8, 0, CAM_Y);
      o.decor.push(...panelFrame(ctx, center, 1.5, 2.8), perfectRing(ctx, center, 0.4));
      addPiece(o, center, { kind: 'glass', blocking: true, perfectRadius: 0.4 });
      for (const x of [-1.95, 1.95]) {
        const side = glassPanel(ctx, o.root, 1.7, 2.8, x, CAM_Y);
        addPiece(o, side, { kind: 'glass', blocking: false, perfectRadius: 0.4 });
      }
      return o;
    }

    case 'blade': {
      const o = new Obstacle(scene, z, collision.heavy);
      const blade = CreateBox('blade', { width: 4.6, height: 0.55, depth: 0.1 }, scene);
      blade.material = materials.glass;
      blade.parent = o.root;
      blade.position.y = CAM_Y;
      blade.isPickable = false;
      // glowing tips make the sweep readable at speed
      for (const x of [-2.2, 2.2]) {
        const tip = CreateBox('tip', { width: 0.22, height: 0.62, depth: 0.14 }, scene);
        tip.material = materials.strip;
        tip.parent = blade;
        tip.position.x = x;
        tip.isPickable = false;
      }
      const hub = CreateCylinder('hub', { diameter: 0.55, height: 0.22, tessellation: 12 }, scene);
      hub.material = materials.strip;
      hub.parent = o.root;
      hub.position.y = CAM_Y;
      hub.rotation.x = Math.PI / 2;
      hub.isPickable = false;
      o.decor.push(hub);
      addPiece(o, blade, { kind: 'glass', blocking: true, shatterSize: 1.1 });
      const speed = spec.speed ?? 1.1;
      o.animate = (self, dt) => {
        blade.rotation.z += speed * dt;
        void self;
      };
      return o;
    }

    case 'pendulum': {
      const o = new Obstacle(scene, z, collision.heavy);
      const pivot = new TransformNode('pivot', scene);
      pivot.parent = o.root;
      pivot.position.y = CONFIG.corridor.height - 0.6;
      const arm = CreateCylinder('arm', { diameter: 0.07, height: 3.2, tessellation: 6 }, scene);
      arm.material = materials.strip;
      arm.parent = pivot;
      arm.position.y = -1.6;
      arm.isPickable = false;
      o.decor.push(arm);
      const gem = CreatePolyhedron('pgem', { type: 1, size: 0.62 }, scene);
      gem.material = materials.glass;
      gem.parent = pivot;
      gem.position.y = -3.35;
      gem.isPickable = false;
      addPiece(o, gem, { kind: 'glass', blocking: true, shatterSize: 0.9 });
      const freq = spec.freq ?? 1.5;
      o.animate = (self, _dt, time) => {
        pivot.rotation.z = Math.sin(time * freq + self.time0) * 0.85;
      };
      return o;
    }

    case 'cubes': {
      const o = new Obstacle(scene, z, collision.light);
      const spots: [number, number, boolean][] = [
        [0, CAM_Y, true],
        [-1.25, CAM_Y + 1, false],
        [1.25, CAM_Y + 1, false],
        [-1.25, CAM_Y - 0.9, false],
        [1.25, CAM_Y - 0.9, false],
      ];
      const count = Math.min(spots.length, 3 + (spec.extra ?? 0));
      const cubes: Mesh[] = [];
      for (let i = 0; i < count; i++) {
        const [x, y, blocking] = spots[i];
        const cube = CreateBox('cube', { size: 0.9 }, scene);
        cube.material = materials.glass;
        cube.parent = o.root;
        cube.position.set(x, y, 0);
        cube.rotation.set(0.5, 0.7, 0.2);
        cube.isPickable = false;
        cubes.push(cube);
        addPiece(o, cube, { kind: 'glass', blocking, shatterSize: 0.75 });
      }
      o.animate = (self, dt, time) => {
        for (let i = 0; i < cubes.length; i++) {
          cubes[i].position.y = spots[i][1] + Math.sin(time * 1.6 + i * 1.3) * 0.18;
          cubes[i].rotation.y += dt * 0.6;
        }
        void self;
      };
      return o;
    }

    case 'reinforced': {
      const o = new Obstacle(scene, z, collision.crash);
      const panel = CreateBox('rpanel', { width: 2.9, height: 2.4, depth: 0.2 }, scene);
      panel.material = materials.reinforced;
      panel.parent = o.root;
      panel.position.y = CAM_Y;
      panel.isPickable = false;
      o.decor.push(...panelFrame(ctx, panel, 2.9, 2.4), perfectRing(ctx, panel, 0.45));
      // metal lattice cross — reads as "armored, takes two hits"
      for (const bar of [
        { w: 2.95, h: 0.1, x: 0, y: 0 },
        { w: 0.1, h: 2.45, x: 0, y: 0 },
      ]) {
        const m = CreateBox('lattice', { width: bar.w, height: bar.h, depth: 0.24 }, scene);
        m.material = materials.lattice;
        m.parent = panel;
        m.position.set(bar.x, bar.y, 0);
        m.isPickable = false;
      }
      // crack star: hidden until the first hit
      const crackBars: Mesh[] = [];
      for (let i = 0; i < 4; i++) {
        const c = CreateBox('crack', { width: 0.045, height: 1.5, depth: 0.02 }, scene);
        c.material = materials.glassCracked;
        c.parent = panel;
        c.rotation.z = (Math.PI / 4) * i + 0.35;
        c.position.z = -0.12;
        c.setEnabled(false);
        c.isPickable = false;
        crackBars.push(c);
      }
      const piece = addPiece(o, panel, {
        kind: 'reinforced',
        blocking: true,
        hp: 2,
        scoreValue: score.reinforced,
        perfectRadius: 0.45,
        shatterSize: 1.2,
      });
      const baseTestHit = o.testHit.bind(o);
      o.testHit = (point, radius, dir, shatter, impactSpeed) => {
        const wasAlive = piece.hp;
        const outcome = baseTestHit(point, radius, dir, shatter, impactSpeed);
        if (outcome && !outcome.broke && wasAlive === 2) {
          panel.material = materials.glassCracked;
          for (const c of crackBars) c.setEnabled(true);
        }
        return outcome;
      };
      return o;
    }

    case 'mover': {
      const o = new Obstacle(scene, z, collision.heavy);
      const panel = glassPanel(ctx, o.root, 2.4, 2.4, 0, CAM_Y);
      o.decor.push(...panelFrame(ctx, panel, 2.4, 2.4), perfectRing(ctx, panel, 0.4));
      addPiece(o, panel, { kind: 'glass', blocking: true, perfectRadius: 0.4, shatterSize: 1 });
      const range = spec.range ?? 1.6;
      const speed = spec.speed ?? 1.6;
      o.animate = (self, _dt, time) => {
        panel.position.x = Math.sin(time * speed + self.time0) * range;
      };
      return o;
    }

    case 'danger': {
      const o = new Obstacle(scene, z, collision.heavy);
      const { shell, core } = crystal(ctx, o.root, 'danger', 0.7);
      shell.position.set(spec.x ?? 0, spec.y ?? CAM_Y, 0);
      addPiece(o, shell, {
        kind: 'danger',
        blocking: (spec.x ?? 0) === 0,
        scoreValue: score.danger,
        shatterSize: 1.3,
      });
      o.animate = (self, dt, time) => {
        shell.rotation.y += dt * 1.8;
        core.rotation.y -= dt * 3.2;
        const pulse = 1 + Math.sin(time * 5 + self.time0) * 0.07;
        core.scaling.setAll(pulse);
      };
      return o;
    }

    case 'bonus': {
      const sizes = { s: 0.38, m: 0.55, l: 0.75 } as const;
      const ammo = { s: 1, m: 3, l: 5 } as const;
      const o = new Obstacle(scene, z, 0);
      const { shell, core } = crystal(ctx, o.root, 'bonus', sizes[spec.size]);
      const baseY = spec.y ?? CAM_Y + 0.4;
      shell.position.set(spec.x ?? 0, baseY, 0);
      addPiece(o, shell, {
        kind: 'bonus',
        blocking: false,
        scoreValue: score.bonus,
        ammoValue: ammo[spec.size],
        shatterSize: 0.65 + sizes[spec.size],
      });
      o.animate = (self, dt, time) => {
        shell.rotation.y += dt * 2.4;
        core.rotation.y -= dt * 4.2;
        core.rotation.x += dt * 1.5;
        shell.position.y = baseY + Math.sin(time * 2 + self.time0) * 0.22;
      };
      return o;
    }

    // ----------------------------------------------------- zone 0 signature

    case 'grid': {
      // 3×3 honeycomb of small panels — only the center blocks the path.
      const o = new Obstacle(scene, z, collision.light);
      for (const gx of [-1.15, 0, 1.15]) {
        for (const gy of [CAM_Y - 1.2, CAM_Y, CAM_Y + 1.2]) {
          const cell = glassPanel(ctx, o.root, 1.0, 1.0, gx, gy);
          const blocking = gx === 0 && gy === CAM_Y;
          if (blocking) o.decor.push(...panelFrame(ctx, cell, 1.0, 1.0), perfectRing(ctx, cell, 0.3));
          addPiece(o, cell, { kind: 'glass', blocking, perfectRadius: blocking ? 0.3 : 0, shatterSize: 0.7 });
        }
      }
      return o;
    }

    // ----------------------------------------------------- zone 1 signatures

    case 'dualblade': {
      const o = new Obstacle(scene, z, collision.heavy);
      const speed = spec.speed ?? 1.2;
      const blades: Mesh[] = [];
      for (const [dz, dir] of [
        [-0.14, 1],
        [0.14, -0.75],
      ] as [number, number][]) {
        const blade = CreateBox('dblade', { width: 4.2, height: 0.5, depth: 0.1 }, scene);
        blade.material = materials.glass;
        blade.parent = o.root;
        blade.position.set(0, CAM_Y, dz);
        blade.isPickable = false;
        for (const x of [-2.0, 2.0]) {
          const tip = CreateBox('tip', { width: 0.2, height: 0.58, depth: 0.14 }, scene);
          tip.material = materials.strip;
          tip.parent = blade;
          tip.position.x = x;
          tip.isPickable = false;
        }
        blade.metadata = dir;
        blades.push(blade);
        addPiece(o, blade, { kind: 'glass', blocking: true, shatterSize: 1 });
      }
      const hub = CreateCylinder('hub', { diameter: 0.6, height: 0.34, tessellation: 12 }, scene);
      hub.material = materials.strip;
      hub.parent = o.root;
      hub.position.y = CAM_Y;
      hub.rotation.x = Math.PI / 2;
      hub.isPickable = false;
      o.decor.push(hub);
      o.animate = (_self, dt) => {
        for (const b of blades) b.rotation.z += speed * (b.metadata as number) * dt;
      };
      return o;
    }

    case 'orbit': {
      // Two gems on an elliptical orbit: the path is open when they sweep
      // wide, blocked when they cross the vertical — shoot one to widen the
      // timing window.
      const o = new Obstacle(scene, z, collision.heavy);
      const speed = spec.speed ?? 1.5;
      const gems: Mesh[] = [];
      for (let i = 0; i < 2; i++) {
        const gem = CreatePolyhedron('ogem', { type: 1, size: 0.42 }, scene);
        gem.material = materials.glass;
        gem.parent = o.root;
        gem.isPickable = false;
        gems.push(gem);
        addPiece(o, gem, { kind: 'glass', blocking: true, shatterSize: 0.85 });
      }
      // faint elliptical track showing the gems' orbit path
      const hub = CreateTorus('ohub', { diameter: 3.2, thickness: 0.04, tessellation: 40 }, scene);
      hub.material = materials.strip;
      hub.parent = o.root;
      hub.position.y = CAM_Y;
      hub.rotation.x = Math.PI / 2; // face the camera
      hub.scaling.set(1, 1, 0.44); // squash to the 1.6 × 0.7 ellipse
      hub.isPickable = false;
      o.decor.push(hub);
      o.animate = (self, _dt, time) => {
        for (let i = 0; i < gems.length; i++) {
          const a = time * speed + self.time0 + i * Math.PI;
          gems[i].position.set(Math.cos(a) * 1.6, CAM_Y + Math.sin(a) * 0.7, 0);
          gems[i].rotation.y = a * 2;
        }
      };
      return o;
    }

    // ----------------------------------------------------- zone 2 signatures

    case 'door': {
      // Two panels slide shut as the player approaches — shoot one or lose.
      const o = new Obstacle(scene, z, collision.heavy);
      const panels: Mesh[] = [];
      for (const side of [-1, 1]) {
        const panel = glassPanel(ctx, o.root, 1.7, 2.6, side * 2.4, CAM_Y);
        o.decor.push(...panelFrame(ctx, panel, 1.7, 2.6));
        panels.push(panel);
        addPiece(o, panel, { kind: 'glass', blocking: true, perfectRadius: 0.35, shatterSize: 0.95 });
      }
      o.animate = (self, _dt, _time, camZ) => {
        const p = Math.min(1, Math.max(0, 1 - (self.z - camZ - 6) / 26));
        panels[0].position.x = -(2.4 - 1.55 * p);
        panels[1].position.x = 2.4 - 1.55 * p;
      };
      return o;
    }

    case 'stalactite': {
      // Ceiling crystal: trembles + glows as you close in, then drops onto
      // the path and stays there as a floor hazard.
      const o = new Obstacle(scene, z, collision.heavy);
      const { shell, core } = crystal(ctx, o.root, 'danger', 0.6);
      shell.position.set(0, 6.1, 0);
      addPiece(o, shell, { kind: 'danger', blocking: true, scoreValue: score.danger, shatterSize: 1.2 });
      let state = 0; // 0 idle, 1 trembling, 2 falling, 3 landed
      let trembleT = 0;
      let vy = 0;
      o.animate = (self, dt, time, camZ) => {
        shell.rotation.y += dt * 0.8;
        core.rotation.y -= dt * 2;
        if (state === 0 && camZ > self.z - 26) state = 1;
        if (state === 1) {
          trembleT += dt;
          shell.position.x = Math.sin(time * 60) * 0.06;
          core.scaling.setAll(1 + Math.sin(time * 30) * 0.35);
          if (trembleT > 0.9) {
            state = 2;
            shell.position.x = 0;
          }
        } else if (state === 2) {
          vy -= 24 * dt;
          shell.position.y += vy * dt;
          if (shell.position.y <= 1.05) {
            shell.position.y = 1.05;
            state = 3;
            core.scaling.setAll(1);
          }
        }
      };
      return o;
    }

    // ----------------------------------------------------- zone 3 signatures

    case 'phase': {
      // Strobe barrier: only solid (blocking AND shootable) part of the time.
      const o = new Obstacle(scene, z, collision.heavy);
      const panel = glassPanel(ctx, o.root, 2.6, 2.4, 0, CAM_Y);
      o.decor.push(...panelFrame(ctx, panel, 2.6, 2.4), perfectRing(ctx, panel, 0.4));
      const piece = addPiece(o, panel, { kind: 'glass', blocking: true, perfectRadius: 0.4, shatterSize: 1 });
      const period = spec.period ?? 2.0;
      let solid = true;
      o.animate = (self, _dt, time) => {
        const cycle = ((time + self.time0) % period) / period;
        solid = cycle < 0.55;
        piece.blocking = solid;
        if (solid) {
          panel.visibility = 1;
        } else if (cycle > 0.8) {
          // warning blink just before it solidifies
          panel.visibility = 0.15 + (Math.sin(time * 26) > 0 ? 0.3 : 0);
        } else {
          panel.visibility = 0.12;
        }
      };
      const baseTestHit = o.testHit.bind(o);
      o.testHit = (point, radius, dir, shatter, impactSpeed) =>
        solid ? baseTestHit(point, radius, dir, shatter, impactSpeed) : null;
      return o;
    }

    case 'wave': {
      // Glass storm: three staggered columns of panels rolling toward you.
      const o = new Obstacle(scene, z, collision.light);
      const cols: [number, number][] = [
        [-1.15, 0],
        [0, 1.3],
        [1.15, 2.6],
      ];
      const bobs: Mesh[] = [];
      for (const [gx, gz] of cols) {
        for (const gy of [CAM_Y - 1.2, CAM_Y, CAM_Y + 1.2]) {
          const cell = glassPanel(ctx, o.root, 1.05, 1.05, gx, gy);
          cell.position.z = gz;
          const blocking = gx === 0 && gy === CAM_Y;
          if (blocking) o.decor.push(...panelFrame(ctx, cell, 1.05, 1.05));
          bobs.push(cell);
          addPiece(o, cell, { kind: 'glass', blocking, shatterSize: 0.7 });
        }
      }
      o.animate = (self, _dt, time) => {
        for (let i = 0; i < bobs.length; i++) {
          bobs[i].rotation.z = Math.sin(time * 2 + self.time0 + i) * 0.12;
        }
      };
      return o;
    }

    case 'twinmover': {
      // Two panels sliding in opposition — one is always converging on you.
      const o = new Obstacle(scene, z, collision.heavy);
      const speed = spec.speed ?? 1.8;
      const panels: Mesh[] = [];
      for (const dz of [0, 1.1]) {
        const panel = glassPanel(ctx, o.root, 1.9, 2.4, 0, CAM_Y);
        panel.position.z = dz;
        o.decor.push(...panelFrame(ctx, panel, 1.9, 2.4));
        panels.push(panel);
        addPiece(o, panel, { kind: 'glass', blocking: true, perfectRadius: 0.35, shatterSize: 0.95 });
      }
      o.animate = (self, _dt, time) => {
        const s = Math.sin(time * speed + self.time0) * 1.5;
        panels[0].position.x = s;
        panels[1].position.x = -s;
      };
      return o;
    }

    // ------------------------------------------------------------ power-up

    case 'powerup': {
      const o = new Obstacle(scene, z, 0);
      const shell = CreatePolyhedron('pshell', { type: 1, size: 0.5 }, scene);
      shell.material = materials.power;
      shell.parent = o.root;
      shell.isPickable = false;
      const baseY = CAM_Y + 0.5;
      shell.position.set(spec.x ?? 0, baseY, 0);
      const core = CreatePolyhedron('pcore', { type: 1, size: 0.26 }, scene);
      core.material = materials.powerCore;
      core.parent = shell;
      core.isPickable = false;
      const halo = CreateTorus('phalo', { diameter: 1.25, thickness: 0.05, tessellation: 32 }, scene);
      halo.material = materials.powerCore;
      halo.parent = shell;
      halo.rotation.x = Math.PI / 5;
      halo.isPickable = false;
      addPiece(o, shell, {
        kind: 'power',
        blocking: false,
        scoreValue: 10,
        shatterSize: 1.1,
        power: spec.kind,
      });
      o.animate = (self, dt, time) => {
        shell.rotation.y += dt * 2.2;
        core.rotation.x += dt * 3.4;
        halo.rotation.y += dt * 1.6;
        shell.position.y = baseY + Math.sin(time * 2.2 + self.time0) * 0.24;
      };
      return o;
    }
  }
}
