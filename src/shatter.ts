import type { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { CreatePolyhedron } from '@babylonjs/core/Meshes/Builders/polyhedronBuilder';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import { CreateTorus } from '@babylonjs/core/Meshes/Builders/torusBuilder';
import { SolidParticleSystem } from '@babylonjs/core/Particles/solidParticleSystem';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import type { GameMaterials } from './materials';
import { CONFIG } from './config';

// Fake shatter per design doc §21: no physics engine — pooled shard
// particles with scripted velocity, gravity, spin and alpha fade.

interface ParticleState {
  vx: number;
  vy: number;
  vz: number;
  sx: number; // spin
  sy: number;
  sz: number;
  life: number;
  maxLife: number;
  scale: number;
  r: number;
  g: number;
  b: number;
}

interface FlashState {
  mesh: Mesh;
  life: number;
}

function makeStates(count: number): ParticleState[] {
  const arr: ParticleState[] = [];
  for (let i = 0; i < count; i++) {
    arr.push({ vx: 0, vy: 0, vz: 0, sx: 0, sy: 0, sz: 0, life: 0, maxLife: 1, scale: 1, r: 1, g: 1, b: 1 });
  }
  return arr;
}

export class ShatterSystem {
  private shards: SolidParticleSystem;
  private sparks: SolidParticleSystem;
  private shardStates: ParticleState[];
  private sparkStates: ParticleState[];
  private nextShard = 0;
  private nextSpark = 0;
  private flashes: FlashState[] = [];
  private rings: FlashState[] = [];
  private anyActive = false;

  constructor(scene: Scene, materials: GameMaterials) {
    const { shardPool, sparkPool } = CONFIG.shatter;

    // Glass shards: flattened tetrahedra, one draw call for the whole pool.
    this.shards = new SolidParticleSystem('shards', scene, { updatable: true, isPickable: false });
    const shardShape = CreatePolyhedron('shardShape', { type: 0, size: 0.1 }, scene);
    this.shards.addShape(shardShape, shardPool);
    shardShape.dispose();
    const shardMesh = this.shards.buildMesh();
    shardMesh.material = materials.shard;
    shardMesh.hasVertexAlpha = true;
    shardMesh.isPickable = false;
    shardMesh.alwaysSelectAsActiveMesh = true;
    this.shardStates = makeStates(shardPool);

    // Sparks: tiny additive billboarded quads.
    this.sparks = new SolidParticleSystem('sparks', scene, { updatable: true, isPickable: false });
    const sparkShape = CreatePlane('sparkShape', { size: 0.07 }, scene);
    this.sparks.addShape(sparkShape, sparkPool);
    sparkShape.dispose();
    const sparkMesh = this.sparks.buildMesh();
    sparkMesh.material = materials.spark;
    sparkMesh.hasVertexAlpha = true;
    sparkMesh.isPickable = false;
    sparkMesh.alwaysSelectAsActiveMesh = true;
    this.sparks.billboard = true;
    this.sparkStates = makeStates(sparkPool);

    this.hideAll();

    // Impact flash pool: additive discs that scale up and vanish.
    for (let i = 0; i < 6; i++) {
      const flash = CreatePlane(`flash${i}`, { size: 1 }, scene);
      flash.material = materials.flash;
      flash.billboardMode = Mesh.BILLBOARDMODE_ALL;
      flash.isPickable = false;
      flash.setEnabled(false);
      this.flashes.push({ mesh: flash, life: 0 });
    }

    // Shockwave rings: expanding additive tori — the "punch" of big breaks.
    for (let i = 0; i < 4; i++) {
      const ring = CreateTorus(`ring${i}`, { diameter: 1, thickness: 0.045, tessellation: 32 }, scene);
      ring.material = materials.flash;
      ring.billboardMode = Mesh.BILLBOARDMODE_ALL;
      ring.isPickable = false;
      ring.setEnabled(false);
      this.rings.push({ mesh: ring, life: 0 });
    }
  }

  private hideAll() {
    for (const p of this.shards.particles) p.scaling.setAll(0);
    for (const p of this.sparks.particles) p.scaling.setAll(0);
    this.shards.setParticles();
    this.sparks.setParticles();
  }

  /**
   * Shatter burst at a world position.
   * @param dir      projectile travel direction (biases shard spray forward)
   * @param color    shard tint
   * @param count    10-30 depending on object size (doc §21)
   * @param size     overall shard scale multiplier
   * @param momentum impact-speed factor (1 = baseline) — faster spheres
   *                 punch shards through harder
   */
  burst(pos: Vector3, dir: Vector3, color: Color4, count: number, size = 1, momentum = 1) {
    for (let i = 0; i < count; i++) {
      const idx = this.nextShard;
      this.nextShard = (this.nextShard + 1) % this.shardStates.length;
      const p = this.shards.particles[idx];
      const s = this.shardStates[idx];

      const spread = 4.5 * size;
      s.vx = (Math.random() * 2 - 1) * spread + dir.x * 2.5 * momentum;
      s.vy = Math.random() * spread * 0.9 + 1 + dir.y * 2 * momentum;
      // Limit backward speed so shards drift past the camera instead of
      // slamming into the lens as giant close-up polygons.
      s.vz = Math.max(-1.2, (Math.random() * 2 - 1) * spread + dir.z * 3.5 * momentum);
      s.sx = (Math.random() * 2 - 1) * 9;
      s.sy = (Math.random() * 2 - 1) * 9;
      s.sz = (Math.random() * 2 - 1) * 9;
      s.maxLife = 0.7 + Math.random() * 0.7;
      s.life = s.maxLife;
      s.scale = (0.5 + Math.random()) * size;
      s.r = color.r;
      s.g = color.g;
      s.b = color.b;

      p.position.set(
        pos.x + (Math.random() * 2 - 1) * 0.3 * size,
        pos.y + (Math.random() * 2 - 1) * 0.3 * size,
        pos.z + (Math.random() * 2 - 1) * 0.15
      );
      p.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      // Flatten one axis so pieces read as slivers of glass, not rocks.
      p.scaling.set(s.scale, s.scale * 0.35, s.scale);
      if (p.color) p.color.set(s.r, s.g, s.b, 1);
    }
    this.spawnSparks(pos, color, Math.min(14, 6 + count));
    if (size >= 0.9) this.ring(pos, size); // shockwave on meaty breaks
    this.anyActive = true;
  }

  /** Expanding shockwave ring at an impact point. */
  ring(pos: Vector3, scale = 1) {
    const r = this.rings.find((x) => x.life <= 0) ?? this.rings[0];
    r.life = 0.3;
    r.mesh.position.copyFrom(pos);
    r.mesh.scaling.setAll(0.3 * scale);
    r.mesh.visibility = 0.9;
    r.mesh.setEnabled(true);
    (r.mesh as Mesh & { __ringScale?: number }).__ringScale = scale;
  }

  private spawnSparks(pos: Vector3, color: Color4, count: number) {
    for (let i = 0; i < count; i++) {
      const idx = this.nextSpark;
      this.nextSpark = (this.nextSpark + 1) % this.sparkStates.length;
      const p = this.sparks.particles[idx];
      const s = this.sparkStates[idx];

      s.vx = (Math.random() * 2 - 1) * 7;
      s.vy = (Math.random() * 2 - 1) * 7;
      s.vz = (Math.random() * 2 - 1) * 7;
      s.maxLife = 0.25 + Math.random() * 0.3;
      s.life = s.maxLife;
      s.scale = 0.7 + Math.random() * 1.2;
      s.r = Math.min(1, color.r + 0.4);
      s.g = Math.min(1, color.g + 0.4);
      s.b = Math.min(1, color.b + 0.4);

      p.position.copyFrom(pos);
      p.scaling.setAll(s.scale);
      if (p.color) p.color.set(s.r, s.g, s.b, 1);
    }
  }

  flash(pos: Vector3, scale = 1) {
    const f = this.flashes.find((x) => x.life <= 0) ?? this.flashes[0];
    f.life = 0.18;
    f.mesh.position.copyFrom(pos);
    f.mesh.scaling.setAll(0.4 * scale);
    f.mesh.visibility = 1;
    f.mesh.setEnabled(true);
  }

  update(dt: number) {
    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) {
        f.mesh.setEnabled(false);
        continue;
      }
      const t = 1 - f.life / 0.18;
      f.mesh.scaling.setAll(0.4 + t * 2.2);
      f.mesh.visibility = 1 - t;
    }

    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      if (r.life <= 0) {
        r.mesh.setEnabled(false);
        continue;
      }
      const t = 1 - r.life / 0.3;
      const scale = (r.mesh as Mesh & { __ringScale?: number }).__ringScale ?? 1;
      r.mesh.scaling.setAll((0.3 + t * 2.8) * scale);
      r.mesh.visibility = (1 - t) * 0.9;
    }

    if (!this.anyActive) return;

    const g = CONFIG.shatter.gravity;
    let active = 0;

    for (let i = 0; i < this.shardStates.length; i++) {
      const s = this.shardStates[i];
      if (s.life <= 0) continue;
      const p = this.shards.particles[i];
      s.life -= dt;
      if (s.life <= 0) {
        p.scaling.setAll(0);
        continue;
      }
      active++;
      s.vy += g * dt;
      p.position.x += s.vx * dt;
      p.position.y += s.vy * dt;
      p.position.z += s.vz * dt;
      p.rotation.x += s.sx * dt;
      p.rotation.y += s.sy * dt;
      p.rotation.z += s.sz * dt;
      if (p.color) p.color.a = Math.min(1, (s.life / s.maxLife) * 1.6);
      // Shards clatter off the floor instead of sinking through it.
      if (p.position.y < 0.12 && s.vy < 0) {
        p.position.y = 0.12;
        s.vy = -s.vy * 0.45;
        s.vx *= 0.8;
        s.vz *= 0.9;
        s.sx *= 0.6;
        s.sz *= 0.6;
      }
    }

    for (let i = 0; i < this.sparkStates.length; i++) {
      const s = this.sparkStates[i];
      if (s.life <= 0) continue;
      const p = this.sparks.particles[i];
      s.life -= dt;
      if (s.life <= 0) {
        p.scaling.setAll(0);
        continue;
      }
      active++;
      p.position.x += s.vx * dt;
      p.position.y += s.vy * dt;
      p.position.z += s.vz * dt;
      if (p.color) p.color.a = s.life / s.maxLife;
    }

    this.shards.setParticles();
    this.sparks.setParticles();
    if (active === 0) this.anyActive = false;
  }
}
