import type { Scene } from '@babylonjs/core/scene';
import type { Ray } from '@babylonjs/core/Culling/ray';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { Vector3, Quaternion } from '@babylonjs/core/Maths/math.vector';
import type { GameMaterials } from './materials';
import { CONFIG } from './config';

/**
 * Called with a world point + radius + travel direction + impact speed;
 * returns true when something was hit (the callee applies all side effects).
 */
export type HitTester = (point: Vector3, radius: number, direction: Vector3, speed: number) => boolean;

interface Projectile {
  mesh: Mesh;
  trail: Mesh;
  velocity: Vector3;
  life: number;
  active: boolean;
  hitSomething: boolean;
  bounces: number;
  countMiss: boolean; // multi-shot side spheres don't reset the combo
}

const UP = new Vector3(0, 1, 0);
const HALF_W = CONFIG.corridor.width / 2;
const CEILING = CONFIG.corridor.height;
// hot-loop scratch vectors — projectiles.update must not allocate
const tmpDir = new Vector3();
const tmpStep = new Vector3();
const tmpOffset = new Vector3();

export class ProjectileManager {
  private pool: Projectile[] = [];
  /** Fired when a projectile expires without breaking anything (a miss). */
  onMiss: () => void = () => {};
  /** Fired when a sphere ricochets off the floor/walls/ceiling. */
  onBounce: (position: Vector3, speed: number) => void = () => {};

  constructor(scene: Scene, materials: GameMaterials) {
    const { poolSize, radius } = CONFIG.projectile;
    for (let i = 0; i < poolSize; i++) {
      const mesh = CreateSphere(`proj${i}`, { diameter: radius * 2, segments: 10 }, scene);
      mesh.material = materials.metal;
      mesh.isPickable = false;
      mesh.setEnabled(false);

      const trail = CreateCylinder(
        `trail${i}`,
        { height: 1, diameterTop: radius * 0.9, diameterBottom: radius * 0.25, tessellation: 6 },
        scene
      );
      trail.material = materials.trail;
      trail.isPickable = false;
      trail.rotationQuaternion = Quaternion.Identity();
      trail.setEnabled(false);

      this.pool.push({
        mesh,
        trail,
        velocity: new Vector3(),
        life: 0,
        active: false,
        hitSomething: false,
        bounces: 0,
        countMiss: true,
      });
    }
  }

  get activeCount(): number {
    return this.pool.reduce((n, p) => n + (p.active ? 1 : 0), 0);
  }

  /**
   * Launch a sphere along the tap ray (optionally bent toward an
   * aim-assist target). The launch angle compensates for gravity drop so
   * the arc still lands where the player tapped. Returns the spawn
   * position for muzzle FX, or null when the pool is exhausted.
   */
  fire(
    ray: Ray,
    aimPoint: Vector3 | null = null,
    speed = CONFIG.projectile.speed,
    countMiss = true
  ): Vector3 | null {
    const p = this.pool.find((q) => !q.active);
    if (!p) return null;
    p.countMiss = countMiss;

    const { lifetime, aimDistance, gravity } = CONFIG.projectile;

    // Spawn slightly below the camera center, then converge on the tap ray
    // so shots feel launched from the player's hands (doc §11).
    const target = (aimPoint ?? ray.origin.add(ray.direction.scale(aimDistance))).clone();
    const spawn = ray.origin.add(new Vector3(0, -0.5, 0)).add(ray.direction.scale(0.9));

    // Ballistic compensation: aim high by the expected gravity drop.
    const flightTime = Vector3.Distance(spawn, target) / speed;
    target.y += 0.5 * gravity * flightTime * flightTime;

    const dir = target.subtract(spawn).normalize();
    p.velocity.copyFrom(dir.scale(speed));
    p.mesh.position.copyFrom(spawn);
    p.life = lifetime;
    p.active = true;
    p.hitSomething = false;
    p.bounces = 0;
    p.mesh.setEnabled(true);

    Quaternion.FromUnitVectorsToRef(UP, dir, p.trail.rotationQuaternion!);
    p.trail.setEnabled(true);
    p.trail.scaling.set(1, 0.1, 1);
    return spawn;
  }

  update(dt: number, testHit: HitTester) {
    const { radius, gravity, bounce } = CONFIG.projectile;

    for (const p of this.pool) {
      if (!p.active) continue;

      p.life -= dt;
      if (p.life <= 0) {
        this.deactivate(p);
        if (!p.hitSomething && p.countMiss) this.onMiss();
        continue;
      }

      // Gravity pulls the sphere into a shallow arc (Smash Hit feel).
      p.velocity.y -= gravity * dt;

      // Substep so fast spheres can't tunnel through thin glass.
      const speed = p.velocity.length();
      const frameDist = speed * dt;
      const steps = Math.max(1, Math.ceil(frameDist / 0.3));
      p.velocity.scaleToRef(dt / steps, tmpStep);

      let hit = false;
      for (let s = 0; s < steps; s++) {
        p.mesh.position.addInPlace(tmpStep);
        const pos = p.mesh.position;

        // ricochet off the corridor shell: floor, walls, ceiling
        let bounced = false;
        if (pos.y < radius && p.velocity.y < 0) {
          pos.y = radius;
          p.velocity.y *= -bounce;
          p.velocity.x *= 0.92;
          p.velocity.z *= 0.98;
          bounced = true;
        }
        if (pos.x < -HALF_W + radius && p.velocity.x < 0) {
          pos.x = -HALF_W + radius;
          p.velocity.x *= -0.6;
          bounced = true;
        } else if (pos.x > HALF_W - radius && p.velocity.x > 0) {
          pos.x = HALF_W - radius;
          p.velocity.x *= -0.6;
          bounced = true;
        }
        if (pos.y > CEILING - radius && p.velocity.y > 0) {
          pos.y = CEILING - radius;
          p.velocity.y *= -0.4;
          bounced = true;
        }
        if (bounced) {
          p.bounces++;
          p.velocity.scaleToRef(dt / steps, tmpStep);
          if (p.bounces <= 3) this.onBounce(pos, p.velocity.length());
        }

        this.velocityDir(p, tmpDir);
        if (testHit(pos, radius, tmpDir, p.velocity.length())) {
          hit = true;
          break;
        }
      }

      if (hit) {
        p.hitSomething = true;
        this.deactivate(p);
        continue;
      }

      // Trail follows the live velocity so bounces and the arc read clearly.
      this.velocityDir(p, tmpDir);
      Quaternion.FromUnitVectorsToRef(UP, tmpDir, p.trail.rotationQuaternion!);
      const trailLen = Math.min(2.6, (CONFIG.projectile.lifetime - p.life) * 14);
      p.trail.scaling.set(1, trailLen, 1);
      tmpDir.scaleToRef(trailLen / 2 + radius, tmpOffset);
      p.trail.position.copyFrom(p.mesh.position).subtractInPlace(tmpOffset);
    }
  }

  private velocityDir(p: Projectile, out: Vector3) {
    out.copyFrom(p.velocity);
    const len = out.length();
    if (len > 0.0001) out.scaleInPlace(1 / len);
    else out.set(0, 0, 1);
  }

  clear() {
    for (const p of this.pool) this.deactivate(p);
  }

  private deactivate(p: Projectile) {
    p.active = false;
    p.mesh.setEnabled(false);
    p.trail.setEnabled(false);
  }
}
