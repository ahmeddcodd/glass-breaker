import type { Scene } from '@babylonjs/core/scene';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { CONFIG } from './config';

// The FOV is authored as a *vertical* angle tuned for a 9:16 portrait screen.
// Babylon's default fovMode (VERTICAL_FIXED) holds the vertical extent constant
// and lets the horizontal extent follow the aspect ratio. Real phones are often
// narrower/taller than a clean 9:16, which collapses the horizontal FOV and makes
// the corridor + balls look tiny. We compensate by widening the vertical fov so the
// *horizontal* framing (the gameplay-critical corridor width) stays consistent.
const BASE_ASPECT = 9 / 16;
const MAX_FOV = 1.55; // ceiling so an extreme sliver viewport can't blow the fov up

/** Widen a base vertical fov so the horizontal extent matches the 9:16 look. */
function aspectFov(baseFov: number, aspect: number): number {
  // Only widen when narrower than 9:16; at/above baseline (desktop) leave it alone.
  const a = Math.min(aspect, BASE_ASPECT);
  const fov = 2 * Math.atan((Math.tan(baseFov / 2) * BASE_ASPECT) / a);
  return Math.min(MAX_FOV, fov);
}

// First-person rig: auto-forward glide with a gentle float/sway and an
// impact shake that decays exponentially (design doc §9).
export class CameraRig {
  camera: FreeCamera;
  z = 0;
  private engine: AbstractEngine;
  private bobTime = 0;
  private shakeMag = 0;

  constructor(scene: Scene) {
    this.engine = scene.getEngine();
    this.camera = new FreeCamera('cam', new Vector3(0, CONFIG.corridor.camHeight, 0), scene);
    this.camera.fov = aspectFov(1.05, this.engine.getAspectRatio(this.camera)); // vertical FOV baseline
    this.camera.minZ = 0.1;
    this.camera.maxZ = 220;
    this.camera.setTarget(new Vector3(0, CONFIG.corridor.camHeight, 10));
  }

  advance(dt: number, speed: number) {
    this.z += speed * dt;
  }

  shake(magnitude: number) {
    this.shakeMag = Math.max(this.shakeMag, magnitude);
  }

  update(dt: number, speed = CONFIG.speedCurve[0][1]) {
    // speed sensation: FOV widens and the bob quickens at high velocity.
    // The base (vertical) fov is then aspect-compensated so tall phones keep the
    // same horizontal framing as desktop (reads the live aspect → tracks resize).
    const baseFov = 1.05 + Math.min(0.16, Math.max(0, (speed - 12) * 0.008));
    const targetFov = aspectFov(baseFov, this.engine.getAspectRatio(this.camera));
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 2.5);

    this.bobTime += dt * (0.75 + speed * 0.022);
    this.shakeMag *= Math.exp(-7 * dt);
    if (this.shakeMag < 0.001) this.shakeMag = 0;

    const sway = Math.sin(this.bobTime * 0.9) * 0.06;
    const float = Math.sin(this.bobTime * 1.4) * 0.075;
    const sx = (Math.random() * 2 - 1) * this.shakeMag;
    const sy = (Math.random() * 2 - 1) * this.shakeMag;

    this.camera.position.set(sway + sx, CONFIG.corridor.camHeight + float + sy, this.z);
  }
}
