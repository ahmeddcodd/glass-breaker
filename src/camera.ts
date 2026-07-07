import type { Scene } from '@babylonjs/core/scene';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { CONFIG } from './config';

// First-person rig: auto-forward glide with a gentle float/sway and an
// impact shake that decays exponentially (design doc §9).
export class CameraRig {
  camera: FreeCamera;
  z = 0;
  private bobTime = 0;
  private shakeMag = 0;

  constructor(scene: Scene) {
    this.camera = new FreeCamera('cam', new Vector3(0, CONFIG.corridor.camHeight, 0), scene);
    this.camera.fov = 1.05; // vertical FOV — tuned for tall 9:16 screens
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
    // speed sensation: FOV widens and the bob quickens at high velocity
    const targetFov = 1.05 + Math.min(0.16, Math.max(0, (speed - 12) * 0.008));
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
