import type { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
// value import: registers the InstancedMesh factory behind Mesh.createInstance
import '@babylonjs/core/Meshes/instancedMesh';
import type { InstancedMesh } from '@babylonjs/core/Meshes/instancedMesh';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import { CreatePolyhedron } from '@babylonjs/core/Meshes/Builders/polyhedronBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { SolidParticleSystem } from '@babylonjs/core/Particles/solidParticleSystem';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { GameMaterials } from './materials';
import { CONFIG, ZONES, zoneBlendAt, zoneIndexAt } from './config';

// Four architecturally distinct corridor styles — one per zone (doc §16, §20).
// Each variant is a merged structure mesh + a merged emissive-strip mesh with
// its own zone-colored material, hardware-instanced and recycled per slot.

const L = CONFIG.corridor.segmentLength;
const HW = CONFIG.corridor.width / 2; // 3
const H = CONFIG.corridor.height; // 7

// Zone palette colors parsed once — applyZoneBlend runs every frame and
// must not allocate or parse hex strings.
const ZONE_COLORS = ZONES.map((z) => ({
  fog: Color3.FromHexString(z.fog),
  clear: Color3.FromHexString(z.clear),
  strip: Color3.FromHexString(z.strip),
  ambient: Color3.FromHexString(z.ambient),
}));

interface VariantSet {
  structBase: Mesh;
  stripBase: Mesh;
  stripMat: StandardMaterial;
  stripBaseColor: Color3;
  structFree: InstancedMesh[];
  stripFree: InstancedMesh[];
  spinnerBase: Mesh | null;
}

interface Slot {
  z: number;
  variant: number;
  struct: InstancedMesh | null;
  strip: InstancedMesh | null;
  spinners: InstancedMesh[];
}

interface AmbientParticle {
  vx: number;
  vy: number;
  vz: number;
  life: number;
}

function box(
  scene: Scene,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0
): Mesh {
  const m = CreateBox('b', { width: w, height: h, depth: d }, scene);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  return m;
}

function gem(scene: Scene, size: number, x: number, y: number, z: number, ry: number, rz: number): Mesh {
  const m = CreatePolyhedron('g', { type: 1, size }, scene);
  m.position.set(x, y, z);
  m.rotation.set(0, ry, rz);
  return m;
}

function merge(meshes: Mesh[]): Mesh {
  const m = Mesh.MergeMeshes(meshes, true, true)!;
  m.isPickable = false;
  m.setEnabled(false);
  return m;
}

export class Corridor {
  private scene: Scene;
  private materials: GameMaterials;
  private variants: VariantSet[] = [];
  private slots: Slot[] = [];
  private activeSpinners: InstancedMesh[] = [];
  private spinnerFree: InstancedMesh[] = [];
  private portal: Mesh;
  private baseCorridorDiffuse: Color3;
  private tmpColor = new Color3();
  private z0 = 0; // world z where the current run's distance = 0
  private time = 0;

  // ambient particles: dust motes (zone 0) / streaming debris (zone 3)
  private ambient: SolidParticleSystem;
  private ambientStates: AmbientParticle[] = [];
  private ambientMode = 0;

  constructor(scene: Scene, materials: GameMaterials) {
    this.scene = scene;
    this.materials = materials;
    this.baseCorridorDiffuse = materials.corridor.diffuseColor.clone();

    this.buildCrystalWake();
    this.buildPrismTunnel();
    this.buildFractureHall();
    this.buildMirrorStorm();

    const { visibleSegments } = CONFIG.corridor;
    for (let i = 0; i < visibleSegments; i++) {
      const slot: Slot = { z: i * L, variant: -1, struct: null, strip: null, spinners: [] };
      this.assign(slot);
      this.slots.push(slot);
    }

    // Distant glowing portal — cheap depth cue riding ahead of the camera.
    this.portal = CreatePlane('portal', { size: 9 }, scene);
    this.portal.material = materials.portal;
    this.portal.position.set(0, H / 2, 90);
    this.portal.isPickable = false;

    // Ambient SPS: billboarded glints reused for motes and debris streaks.
    this.ambient = new SolidParticleSystem('ambient', scene, { updatable: true, isPickable: false });
    const quad = CreatePlane('ambientShape', { size: 0.055 }, scene);
    this.ambient.addShape(quad, 70);
    quad.dispose();
    const mesh = this.ambient.buildMesh();
    mesh.material = materials.spark;
    mesh.hasVertexAlpha = true;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    this.ambient.billboard = true;
    for (let i = 0; i < 70; i++) this.ambientStates.push({ vx: 0, vy: 0, vz: 0, life: 0 });
    for (const p of this.ambient.particles) p.scaling.setAll(0);
    this.ambient.setParticles();
  }

  // ------------------------------------------------------------- variants

  private makeVariant(structParts: Mesh[], stripParts: Mesh[], stripColor: string, spinnerBase: Mesh | null): void {
    const stripMat = new StandardMaterial(`stripV${this.variants.length}`, this.scene);
    stripMat.emissiveColor = Color3.FromHexString(stripColor);
    stripMat.diffuseColor = Color3.Black();
    stripMat.disableLighting = true;

    const structBase = merge(structParts);
    structBase.material = this.materials.corridor;
    const stripBase = merge(stripParts);
    stripBase.material = stripMat;
    if (spinnerBase) {
      spinnerBase.material = stripMat;
      spinnerBase.isPickable = false;
      spinnerBase.setEnabled(false);
    }

    this.variants.push({
      structBase,
      stripBase,
      stripMat,
      stripBaseColor: Color3.FromHexString(stripColor),
      structFree: [],
      stripFree: [],
      spinnerBase,
    });
  }

  /** Zone 0 — clean, tall, airy: recessed panels, double strips, dust motes. */
  private buildCrystalWake() {
    const s = this.scene;
    const struct = [
      box(s, 6.8, 0.3, L, 0, -0.15, 0), // floor
      box(s, 0.3, H, L, -HW - 0.15, H / 2, 0),
      box(s, 0.3, H, L, HW + 0.15, H / 2, 0),
      box(s, 0.12, 2.6, L * 0.7, -HW + 0.02, 3.0, 0), // recessed wall panels
      box(s, 0.12, 2.6, L * 0.7, HW - 0.02, 3.0, 0),
      box(s, 2.3, 0.2, L, -2.2, H + 0.08, 0), // ceiling side caps (center open)
      box(s, 2.3, 0.2, L, 2.2, H + 0.08, 0),
      box(s, 0.5, H, 0.55, -HW - 0.05, H / 2, -L / 2 + 0.3), // joint columns
      box(s, 0.5, H, 0.55, HW + 0.05, H / 2, -L / 2 + 0.3),
      box(s, 6.9, 0.3, 0.55, 0, H + 0.02, -L / 2 + 0.3), // joint ceiling beam
    ];
    const strips = [
      box(s, 0.06, 0.1, L * 0.92, -HW + 0.06, 4.35, 0),
      box(s, 0.06, 0.1, L * 0.92, HW - 0.06, 4.35, 0),
      box(s, 0.05, 0.06, L * 0.92, -HW + 0.06, 1.6, 0),
      box(s, 0.05, 0.06, L * 0.92, HW - 0.06, 1.6, 0),
      box(s, 0.08, 0.05, L * 0.92, -2.62, 0.03, 0),
      box(s, 0.08, 0.05, L * 0.92, 2.62, 0.03, 0),
    ];
    this.makeVariant(struct, strips, ZONES[0].strip, null);
  }

  /** Zone 1 — prism bore: walls fold inward at the top, zigzag violet strips,
   *  wall-mounted octahedra that visibly rotate. */
  private buildPrismTunnel() {
    const s = this.scene;
    const struct = [
      box(s, 6.8, 0.3, L, 0, -0.15, 0),
      box(s, 0.3, 4.6, L, -HW - 0.15, 2.3, 0), // vertical lower walls
      box(s, 0.3, 4.6, L, HW + 0.15, 2.3, 0),
      box(s, 0.25, 3.6, L, -2.55, 5.95, 0, 0, 0, -0.42), // tilted upper panels
      box(s, 0.25, 3.6, L, 2.55, 5.95, 0, 0, 0, 0.42),
      box(s, 1.5, 0.2, L, 0, 7.35, 0), // apex cap
      box(s, 0.4, 4.6, 0.5, -HW - 0.05, 2.3, -L / 2 + 0.3), // joint columns
      box(s, 0.4, 4.6, 0.5, HW + 0.05, 2.3, -L / 2 + 0.3),
      box(s, 0.35, 3.7, 0.5, -2.45, 5.95, -L / 2 + 0.3, 0, 0, -0.42), // joint Λ
      box(s, 0.35, 3.7, 0.5, 2.45, 5.95, -L / 2 + 0.3, 0, 0, 0.42),
    ];
    const strips: Mesh[] = [
      box(s, 0.12, 0.06, L * 0.92, 0, 7.22, 0), // apex glow line
      box(s, 0.05, 0.04, L * 0.92, -1.0, 0.03, 0),
      box(s, 0.05, 0.04, L * 0.92, 1.0, 0.03, 0),
    ];
    // diagonal zigzag accents along the lower walls
    for (let i = 0; i < 4; i++) {
      const zo = -3 + i * 2;
      const tilt = i % 2 === 0 ? 0.7 : -0.7;
      strips.push(box(s, 0.06, 1.7, 0.1, -HW + 0.05, 2.5, zo, 0, 0, tilt));
      strips.push(box(s, 0.06, 1.7, 0.1, HW - 0.05, 2.5, zo, 0, 0, -tilt));
    }
    const spinner = CreatePolyhedron('spinner', { type: 1, size: 0.4 }, s);
    this.makeVariant(struct, strips, ZONES[1].strip, spinner);
  }

  /** Zone 2 — oppressive fracture: jagged tilted slabs, low ceiling, dashed
   *  red hazard strips, embedded red crystals, flickering light. */
  private buildFractureHall() {
    const s = this.scene;
    const struct: Mesh[] = [box(s, 6.8, 0.35, L, 0, -0.15, 0), box(s, 6.9, 0.3, L, 0, 6.35, 0)];
    // staggered jagged wall slabs (deterministic "random" tilts)
    const slabs: [number, number, number, number][] = [
      // [y, zOffset, xJitter, tilt]
      [1.4, -2.2, 0.05, 0.13],
      [3.6, 0.2, -0.08, -0.1],
      [5.5, 2.1, 0.1, 0.16],
      [2.4, 2.4, -0.05, -0.14],
      [4.8, -1.8, 0.02, 0.09],
    ];
    for (const [y, zo, xj, tilt] of slabs) {
      struct.push(box(s, 0.4, 3.0, L * 0.48, -HW - 0.1 + xj, y, zo, 0, 0, tilt));
      struct.push(box(s, 0.4, 3.0, L * 0.48, HW + 0.1 - xj, y, zo, 0, 0, -tilt));
    }
    // backing walls so tilt gaps never show through
    struct.push(box(s, 0.25, H, L, -HW - 0.35, H / 2, 0));
    struct.push(box(s, 0.25, H, L, HW + 0.35, H / 2, 0));
    // broken rib stubs at the joint
    struct.push(box(s, 0.5, 2.2, 0.6, -HW, 1.1, -L / 2 + 0.3, 0, 0, 0.08));
    struct.push(box(s, 0.5, 2.2, 0.6, HW, 1.1, -L / 2 + 0.3, 0, 0, -0.08));
    struct.push(box(s, 0.5, 1.7, 0.6, -2.9, 5.45, -L / 2 + 0.3, 0, 0, -0.12));
    struct.push(box(s, 0.5, 1.7, 0.6, 2.9, 5.45, -L / 2 + 0.3, 0, 0, 0.12));

    const strips: Mesh[] = [];
    // dashed hazard strips
    for (const zo of [-2.6, 0, 2.6]) {
      strips.push(box(s, 0.07, 0.09, 1.6, -HW + 0.08, 3.2, zo));
      strips.push(box(s, 0.07, 0.09, 1.6, HW - 0.08, 3.2, zo));
    }
    strips.push(box(s, 0.06, 0.04, 1.8, -2.45, 0.04, 1.6));
    strips.push(box(s, 0.06, 0.04, 1.8, 2.45, 0.04, -1.6));
    // red crystals growing from the wall bases
    strips.push(gem(s, 0.34, -2.7, 0.45, -2.0, 0.5, 0.4));
    strips.push(gem(s, 0.24, -2.55, 0.35, 2.6, 1.2, -0.5));
    strips.push(gem(s, 0.38, 2.68, 0.5, 0.8, 2.1, 0.45));
    strips.push(gem(s, 0.22, 2.5, 0.3, -2.8, 0.3, -0.35));
    this.makeVariant(struct, strips, ZONES[2].strip, null);
  }

  /** Zone 3 — mirror canyon: angled zigzag panels, forward chevrons,
   *  near-white strips, glass debris streaming past. */
  private buildMirrorStorm() {
    const s = this.scene;
    const struct = [
      box(s, 6.8, 0.3, L, 0, -0.15, 0),
      box(s, 0.3, H, L, -HW - 0.35, H / 2, 0), // outer backing walls
      box(s, 0.3, H, L, HW + 0.35, H / 2, 0),
      // angled inner panels alternating to form a zigzag canyon
      box(s, 0.25, H, L * 0.56, -2.88, H / 2, -L / 4, 0, 0.18, 0),
      box(s, 0.25, H, L * 0.56, -2.88, H / 2, L / 4, 0, -0.18, 0),
      box(s, 0.25, H, L * 0.56, 2.88, H / 2, -L / 4, 0, -0.18, 0),
      box(s, 0.25, H, L * 0.56, 2.88, H / 2, L / 4, 0, 0.18, 0),
      // ceiling chevron pointing forward
      box(s, 0.25, 0.2, 2.7, -0.95, 6.95, 0.2, 0, -0.55, 0),
      box(s, 0.25, 0.2, 2.7, 0.95, 6.95, 0.2, 0, 0.55, 0),
      box(s, 6.9, 0.2, L, 0, 7.35, 0), // high cap above chevrons
    ];
    const strips = [
      box(s, 0.05, 0.08, L, -2.72, 4.6, 0),
      box(s, 0.05, 0.08, L, 2.72, 4.6, 0),
      box(s, 0.05, 0.08, L, -2.72, 2.6, 0),
      box(s, 0.05, 0.08, L, 2.72, 2.6, 0),
      // glowing chevron echo under the structural one
      box(s, 0.06, 0.06, 2.8, -0.95, 6.82, 0.2, 0, -0.55, 0),
      box(s, 0.06, 0.06, 2.8, 0.95, 6.82, 0.2, 0, 0.55, 0),
      // floor speed lines
      box(s, 0.04, 0.03, L, -0.85, 0.03, 0),
      box(s, 0.04, 0.03, L, 0.85, 0.03, 0),
      box(s, 0.04, 0.03, L, -1.9, 0.03, 0),
      box(s, 0.04, 0.03, L, 1.9, 0.03, 0),
    ];
    this.makeVariant(struct, strips, ZONES[3].strip, null);
  }

  // ---------------------------------------------------------- slot recycle

  /** World z at which the current run started (distance 0). */
  setRunStart(z0: number) {
    if (z0 === this.z0) return;
    this.z0 = z0;
    for (const slot of this.slots) this.assign(slot);
  }

  private zoneAtZ(z: number): number {
    return zoneIndexAt(Math.max(0, z - this.z0));
  }

  private acquire(variant: number, kind: 'struct' | 'strip'): InstancedMesh {
    const v = this.variants[variant];
    const pool = kind === 'struct' ? v.structFree : v.stripFree;
    const inst =
      pool.pop() ?? (kind === 'struct' ? v.structBase : v.stripBase).createInstance(`${kind}${variant}`);
    inst.isPickable = false;
    inst.setEnabled(true);
    return inst;
  }

  private release(variant: number, kind: 'struct' | 'strip', inst: InstancedMesh) {
    inst.setEnabled(false);
    (kind === 'struct' ? this.variants[variant].structFree : this.variants[variant].stripFree).push(inst);
  }

  private assign(slot: Slot) {
    const variant = this.zoneAtZ(slot.z);
    if (variant !== slot.variant) {
      if (slot.struct) this.release(slot.variant, 'struct', slot.struct);
      if (slot.strip) this.release(slot.variant, 'strip', slot.strip);
      for (const sp of slot.spinners) {
        sp.setEnabled(false);
        this.spinnerFree.push(sp);
        const i = this.activeSpinners.indexOf(sp);
        if (i >= 0) this.activeSpinners.splice(i, 1);
      }
      slot.spinners = [];

      slot.variant = variant;
      slot.struct = this.acquire(variant, 'struct');
      slot.strip = this.acquire(variant, 'strip');

      const spinnerBase = this.variants[variant].spinnerBase;
      if (spinnerBase) {
        for (const x of [-2.72, 2.72]) {
          const sp = this.spinnerFree.pop() ?? spinnerBase.createInstance('spin');
          sp.isPickable = false;
          sp.setEnabled(true);
          sp.position.set(x, 5.0, slot.z);
          sp.rotation.set(0, Math.random() * 2, 0);
          slot.spinners.push(sp);
          this.activeSpinners.push(sp);
        }
      }
    }
    slot.struct!.position.z = slot.z;
    slot.strip!.position.z = slot.z;
    for (const sp of slot.spinners) sp.position.z = slot.z;
  }

  // ---------------------------------------------------------------- update

  update(dt: number, camZ: number) {
    this.time += dt;
    const span = CONFIG.corridor.visibleSegments * L;

    for (const slot of this.slots) {
      if (slot.z < camZ - L * 2) {
        slot.z += span;
        this.assign(slot);
      }
    }

    // rotating prism decor (Prism Tunnel)
    for (const sp of this.activeSpinners) {
      sp.rotation.y += dt * 0.9;
      sp.rotation.z += dt * 0.35;
    }

    // hazard-light flicker (Fracture Hall)
    const v2 = this.variants[2];
    let f = 0.78 + 0.22 * Math.sin(this.time * 11.7) * Math.sin(this.time * 5.3);
    if (Math.sin(this.time * 2.13) > 0.965) f *= 0.3; // occasional dropout
    v2.stripMat.emissiveColor.copyFrom(v2.stripBaseColor).scaleInPlace(f);

    this.portal.position.z = camZ + 90;
    this.updateAmbient(dt, camZ);
  }

  private updateAmbient(dt: number, camZ: number) {
    const zone = this.zoneAtZ(camZ);
    const mode = zone === 0 ? 0 : zone === 3 ? 3 : -1;
    if (mode !== this.ambientMode) this.ambientMode = mode;

    // idle skip: nothing spawning and nothing still alive → no SPS update
    if (mode === -1 && !this.ambientStates.some((s) => s.life > 0)) return;

    for (let i = 0; i < this.ambientStates.length; i++) {
      const s = this.ambientStates[i];
      const p = this.ambient.particles[i];
      s.life -= dt;

      const gone = s.life <= 0 || p.position.z < camZ - 2;
      if (gone) {
        if (mode === -1) {
          p.scaling.setAll(0);
          continue;
        }
        if (mode === 0) {
          // dust motes: slow drift in the corridor volume ahead
          s.vx = (Math.random() * 2 - 1) * 0.25;
          s.vy = (Math.random() * 2 - 1) * 0.2;
          s.vz = (Math.random() * 2 - 1) * 0.3;
          s.life = 3 + Math.random() * 4;
          p.position.set((Math.random() * 2 - 1) * 2.5, 0.5 + Math.random() * 5.5, camZ + 4 + Math.random() * 38);
          p.scaling.setAll(0.6 + Math.random() * 0.8);
          if (p.color) p.color.set(0.55, 0.85, 1, 0.5);
        } else {
          // mirror-storm debris: bright streaks racing past the camera
          s.vx = (Math.random() * 2 - 1) * 1.5;
          s.vy = (Math.random() * 2 - 1) * 1.5;
          s.vz = -(26 + Math.random() * 16);
          s.life = 2 + Math.random() * 2;
          p.position.set((Math.random() * 2 - 1) * 2.6, 0.6 + Math.random() * 5.8, camZ + 30 + Math.random() * 55);
          p.scaling.set(0.7, 3.5 + Math.random() * 2.5, 1); // elongated streak
          if (p.color) p.color.set(0.95, 1, 1, 0.75);
        }
        continue;
      }

      p.position.x += s.vx * dt;
      p.position.y += s.vy * dt;
      p.position.z += s.vz * dt;
    }
    this.ambient.setParticles();
  }

  /** Blend scene atmosphere between zone palettes (doc §16, §19).
   *  Runs every frame — uses pre-parsed colors, zero allocations. */
  applyZoneBlend(distance: number) {
    const { a, b, t, index } = zoneBlendAt(distance);
    const ca = ZONE_COLORS[Math.max(0, index - 1)];
    const cb = ZONE_COLORS[index];

    Color3.LerpToRef(ca.fog, cb.fog, t, this.scene.fogColor);
    this.scene.fogStart = a.fogStart + (b.fogStart - a.fogStart) * t;
    this.scene.fogEnd = a.fogEnd + (b.fogEnd - a.fogEnd) * t;
    Color3.LerpToRef(ca.clear, cb.clear, t, this.tmpColor);
    this.scene.clearColor.set(this.tmpColor.r, this.tmpColor.g, this.tmpColor.b, 1);

    // shared accent used by obstacle frames/hubs follows the zone color
    Color3.LerpToRef(ca.strip, cb.strip, t, this.materials.strip.emissiveColor);
    this.materials.portal.emissiveColor.copyFrom(this.materials.strip.emissiveColor);

    Color3.LerpToRef(ca.ambient, cb.ambient, t, this.tmpColor);
    Color3.LerpToRef(this.baseCorridorDiffuse, this.tmpColor, 0.5, this.materials.corridor.diffuseColor);
  }
}
