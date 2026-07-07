import '@babylonjs/core/Culling/ray'; // registers Scene.createPickingRay
import type { Engine } from '@babylonjs/core/Engines/engine';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { Scene } from '@babylonjs/core/scene';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3, Matrix } from '@babylonjs/core/Maths/math.vector';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { GlowLayer } from '@babylonjs/core/Layers/glowLayer';

import { Ray } from '@babylonjs/core/Culling/ray';
import { CONFIG, ZONES, zoneBlendAt, POWERUP_LABELS } from './config';
import { PowerUpManager } from './powerups';
import { createMaterials } from './materials';
import type { GameMaterials } from './materials';
import { CameraRig } from './camera';
import { InputManager } from './input';
import { ProjectileManager } from './projectiles';
import { ShatterSystem } from './shatter';
import { Corridor } from './corridor';
import { SegmentSpawner } from './segments';
import { ScoreSystem } from './score';
import { AmmoSystem } from './ammo';
import { UI } from './ui';
import { AudioManager } from './audio';
import * as playables from './playables';
import type { HitOutcome } from './obstacles';

type GameState = 'start' | 'playing' | 'gameover';

const FORWARD = new Vector3(0, 0, 1);

export class Game {
  private engine: Engine;
  private scene: Scene;
  private rig: CameraRig;
  private corridor: Corridor;
  private spawner: SegmentSpawner;
  private projectiles: ProjectileManager;
  private shatter: ShatterSystem;
  private score: ScoreSystem;
  private ammo: AmmoSystem;
  private ui: UI;
  private audio: AudioManager;

  private hemi: HemisphericLight;
  private dirLight: DirectionalLight;
  private glow: GlowLayer;

  // adaptive quality: steps resolution/glow down when FPS drops (doc §39)
  private qualityLevel = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private lowStreak = 0;
  private highStreak = 0;
  private qualityCooldown = 4; // warmup before the first measurement counts

  private state: GameState = 'start';
  /** Set by YouTube Playables onPause — halts all updates AND rendering. */
  private paused = false;
  private firstFrameSignalled = false;
  private runTime = 0;
  private totalTime = 0;
  private freezeTimer = 0;
  private runStartZ = 0;
  private zoneIndex = 0;
  /** ?dist=NNN — start the run this far in (zone screenshots / testing). */
  private debugDist = Math.max(0, Number(new URLSearchParams(location.search).get('dist')) || 0);

  // speed system
  private currentSpeed = CONFIG.speedCurve[0][1];
  private nextMilestone = 0;
  private lastWhoosh = 0;

  private powerups = new PowerUpManager();

  // one-shot tutorial flags per run
  private firstShotFired = false;
  private firstBreakDone = false;
  private lowAmmoWarned = false;

  // HUD change caching so the DOM isn't touched every frame
  private lastScore = -1;
  private lastAmmo = -1;
  private lastDistance = -1;
  private displayScore = 0; // lerped count-up toward the real score

  constructor(engine: Engine, canvas: HTMLCanvasElement) {
    this.engine = engine;
    this.scene = new Scene(engine);
    this.scene.clearColor = Color4.FromHexString('#050b18ff');
    this.scene.fogMode = Scene.FOGMODE_LINEAR;
    this.scene.fogStart = 24;
    this.scene.fogEnd = 95;
    this.scene.fogColor = Color3.FromHexString('#0c1a33');

    this.hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), this.scene);
    this.hemi.intensity = ZONES[0].hemi;
    this.hemi.groundColor = Color3.FromHexString('#0a1626');
    this.dirLight = new DirectionalLight('dir', new Vector3(0.15, -0.5, 0.85), this.scene);
    this.dirLight.intensity = ZONES[0].dir;

    // subtle shader-level grade — no post-process pass needed
    this.scene.imageProcessingConfiguration.contrast = 1.15;
    this.scene.imageProcessingConfiguration.exposure = 1.08;

    // No pointer-move picking: input is a raw canvas listener, so the scene
    // never needs to raycast meshes under the cursor.
    this.scene.skipPointerMovePicking = true;
    this.scene.detachControl();

    // Fixed-size glow target: the neon look survives a small blur texture,
    // and it stops glow cost scaling with device resolution.
    this.glow = new GlowLayer('glow', this.scene, { blurKernelSize: 24, mainTextureFixedSize: 512 });
    this.glow.intensity = 0.7;

    const materials = createMaterials(this.scene);
    this.rig = new CameraRig(this.scene);
    this.corridor = new Corridor(this.scene, materials);
    this.spawner = new SegmentSpawner(this.scene, materials);
    this.projectiles = new ProjectileManager(this.scene, materials);
    this.shatter = new ShatterSystem(this.scene, materials);
    this.score = new ScoreSystem();
    this.ammo = new AmmoSystem();
    this.audio = new AudioManager();
    this.ui = new UI(document.getElementById('ui')!);

    this.ui.onStart = () => this.startRun();
    this.ui.onRestart = () => {
      this.audio.uiTap();
      this.startRun();
    };
    this.projectiles.onMiss = () => {
      if (this.state !== 'playing') return;
      this.score.miss();
      this.ui.setCombo(0, 1);
    };
    this.projectiles.onBounce = (pos) => {
      this.audio.bounce(0.8);
      this.shatter.flash(pos, 0.3);
    };
    this.spawner.onDodge = () => {
      // air-rip when slipping past a live hazard at speed
      if (this.state !== 'playing' || this.currentSpeed < 14) return;
      if (this.totalTime - this.lastWhoosh < 0.3) return;
      this.lastWhoosh = this.totalTime;
      this.audio.whoosh(Math.min(1.5, this.currentSpeed / 20));
    };
    this.powerups.onTimedEnd = (kind) => {
      if (kind === 'slowrift') {
        this.ui.setSlowTint(false);
        this.audio.riftExit();
      }
      this.ui.setPowerUp(null, 0);
    };

    const input = new InputManager(engine, canvas);
    input.onTap = (x, y, cssX, cssY) => this.handleTap(x, y, cssX, cssY);

    // YouTube Playables wiring (no-ops outside the Playables environment):
    // cloud-saved best score, the platform mute toggle, and pause/resume.
    void playables.loadBestScore().then((best) => this.score.setBest(best));
    this.audio.setEnabled(playables.isAudioEnabled());
    playables.onAudioEnabledChange((enabled) => this.audio.setEnabled(enabled));
    playables.onPause(() => {
      this.paused = true;
      this.audio.suspend();
      playables.saveBestScore(this.score.best);
    });
    playables.onResume(() => {
      this.paused = false;
      this.audio.resume();
    });

    // QA hook (?qa in the URL): trigger a power-up collection exactly as a
    // real pickup would — used by automated device testing, inert otherwise.
    if (new URLSearchParams(location.search).has('qa')) {
      (globalThis as { __qaPower?: (k: 'multishot' | 'slowrift' | 'shield') => void }).__qaPower = (k) =>
        this.collectPower(k, 0.5, 0.4);
    }

    this.ui.showStart();
    this.corridor.setRunStart(-this.debugDist);
    this.corridor.applyZoneBlend(this.debugDist);
    this.updateZone(this.debugDist);

    this.scene.executeWhenReady(() => {
      this.prewarmShaders(materials);
      // Freeze materials whose defines never change (colors may still be
      // animated — that's uniform-level and works on frozen materials).
      // strip/corridor/portal + zone strip mats stay unfrozen: conservative.
      for (const m of [
        materials.glass,
        materials.glassCracked,
        materials.reinforced,
        materials.bonus,
        materials.bonusCore,
        materials.danger,
        materials.dangerCore,
        materials.power,
        materials.powerCore,
        materials.metal,
        materials.lattice,
        materials.trail,
        materials.shard,
        materials.spark,
        materials.flash,
      ]) {
        m.freeze();
      }
      // Shaders are warm and the start screen is interactive — let YouTube
      // drop its loading spinner. gameReady must follow firstFrameReady.
      this.signalFirstFrame();
      playables.gameReady();
    });
  }

  /**
   * Compile every shader combination during the loading/start screen so the
   * first shot, first break, and first appearance of each obstacle type
   * never hitch mid-run.
   */
  private prewarmShaders(materials: GameMaterials) {
    // temp meshes so obstacle materials (no live meshes yet) compile too
    const temps: Mesh[] = [];
    for (const mat of [
      materials.glass,
      materials.glassCracked,
      materials.reinforced,
      materials.bonus,
      materials.bonusCore,
      materials.danger,
      materials.dangerCore,
      materials.power,
      materials.powerCore,
      materials.lattice,
      materials.strip,
    ]) {
      const m = CreateBox('prewarm', { size: 0.1 }, this.scene);
      m.material = mat;
      m.setEnabled(false);
      m.isPickable = false;
      temps.push(m);
    }

    const done = new Set<string>();
    for (const mesh of this.scene.meshes) {
      const mat = mesh.material;
      if (!mat) continue;
      const instances = (mesh as unknown as Partial<Mesh>).instances;
      const hasInstances = !!instances && instances.length > 0;
      const key = mat.name + (hasInstances ? '+i' : '');
      if (done.has(key)) continue;
      done.add(key);
      try {
        mat.forceCompilation(mesh);
        if (hasInstances) mat.forceCompilation(mesh, undefined, { useInstances: true });
      } catch {
        // best-effort: a failed prewarm just means a later lazy compile
      }
    }

    setTimeout(() => temps.forEach((m) => m.dispose()), 4000);
  }

  // ------------------------------------------------------------- main loop

  tick() {
    // Playables pause: freeze everything, including rendering, until onResume.
    if (this.paused) return;

    const rawDt = Math.min(this.engine.getDeltaTime() / 1000, 0.05);
    this.updateQuality(rawDt);
    let dt = rawDt;
    if (this.freezeTimer > 0) {
      // hit-stop micro-freeze on big impacts (doc §21)
      this.freezeTimer -= rawDt;
      dt = 0;
    }

    this.totalTime += dt;

    if (this.state === 'playing') {
      this.updatePlaying(dt);
    } else {
      // Start & game-over screens keep the tunnel alive behind the UI.
      if (this.state === 'start') {
        this.rig.advance(dt, CONFIG.startDriftSpeed);
        this.corridor.setRunStart(this.rig.z - this.debugDist);
      }
      this.rig.update(dt);
      this.corridor.update(dt, this.rig.z);
    }

    // adaptive soundtrack: tempo from speed, key from zone, layers from
    // combo / low ammo / slow rift
    this.audio.setMusicState(
      this.state === 'playing',
      this.currentSpeed,
      this.zoneIndex,
      this.score.combo,
      this.ammo.low && this.state === 'playing',
      this.powerups.slowRiftActive
    );

    // neon glow breathes with the kick drum — visuals lock to the beat
    const beat = this.state === 'playing' ? this.audio.beatPulse() : 0;
    this.glow.intensity = (this.qualityLevel >= 2 ? 0.55 : 0.7) * (1 + beat * 0.28);

    this.shatter.update(dt);
    this.scene.render();
    this.signalFirstFrame();
  }

  private signalFirstFrame() {
    if (this.firstFrameSignalled) return;
    this.firstFrameSignalled = true;
    playables.firstFrameReady();
  }

  /**
   * Adaptive quality (doc §39): measure FPS in 0.5s windows; sustained drops
   * step the render resolution (and eventually glow) down, long stretches of
   * smooth 57+ FPS step back up. Hysteresis prevents oscillation.
   */
  private updateQuality(rawDt: number) {
    if (this.qualityCooldown > 0) {
      this.qualityCooldown -= rawDt;
      return;
    }
    this.fpsAccum += rawDt;
    this.fpsFrames++;
    if (this.fpsAccum < 0.5) return;

    const fps = this.fpsFrames / this.fpsAccum;
    (globalThis as { __fps?: number }).__fps = Math.round(fps); // QA hook
    this.fpsAccum = 0;
    this.fpsFrames = 0;

    if (fps < 48 && this.qualityLevel < 3) {
      this.highStreak = 0;
      if (++this.lowStreak >= 3) this.applyQuality(this.qualityLevel + 1);
    } else if (fps > 57 && this.qualityLevel > 0) {
      this.lowStreak = 0;
      if (++this.highStreak >= 16) this.applyQuality(this.qualityLevel - 1);
    } else {
      this.lowStreak = 0;
      this.highStreak = 0;
    }
  }

  private applyQuality(level: number) {
    this.qualityLevel = level;
    this.lowStreak = 0;
    this.highStreak = 0;
    this.qualityCooldown = 1.5;
    const dprCap = [2, 1.5, 1.25, 1][level];
    this.engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, dprCap));
    this.glow.isEnabled = level < 3;
    this.glow.intensity = level >= 2 ? 0.55 : 0.7;
    (globalThis as { __quality?: number }).__quality = level; // QA hook
  }

  private updatePlaying(dt: number) {
    // power-up timers tick in real time; slow rift scales the world's time
    this.powerups.update(dt);
    const worldDt = this.powerups.slowRiftActive ? dt * CONFIG.powerups.slowRift.scale : dt;
    const timed = this.powerups.activeTimed;
    this.ui.setPowerUp(timed ? POWERUP_LABELS[timed] : null, this.powerups.progress);

    this.runTime += worldDt;
    const speed = this.speedAt(this.runTime);
    this.currentSpeed = speed;

    // "SPEED UP!" callouts as the run crosses each velocity milestone
    const milestones = CONFIG.endlessSpeed.milestones;
    if (this.nextMilestone < milestones.length && speed >= milestones[this.nextMilestone]) {
      this.nextMilestone++;
      this.ui.popup(0.5, 0.3, 'SPEED UP!', 'big');
      this.ui.edgeFlash('cyan');
      this.audio.speedUp();
      this.vibrate(20);
    }

    this.rig.advance(worldDt, speed);
    this.rig.update(worldDt, speed);
    this.corridor.update(worldDt, this.rig.z);

    const distance = this.rig.z - this.runStartZ;
    this.corridor.applyZoneBlend(distance);
    this.updateZone(distance);

    this.spawner.update(worldDt, this.totalTime, this.rig.z, ZONES[this.zoneIndex].tier, speed);

    this.projectiles.update(worldDt, (point, radius, direction, projSpeed) => {
      const outcome = this.spawner.testHit(point, radius, direction, this.shatter, projSpeed);
      if (!outcome) return false;
      this.handleOutcome(outcome);
      return true;
    });

    this.handleCollisions(worldDt);
    this.score.update(worldDt, speed * worldDt);
    this.refreshHud(distance, dt);
  }

  /** Piecewise speed curve (doc §18): holds each step, ramps over 5s —
   *  then keeps climbing forever past the last step (soft-capped). */
  private speedAt(t: number): number {
    const curve = CONFIG.speedCurve;
    let speed = curve[0][1];
    for (let i = 1; i < curve.length; i++) {
      const [time, value] = curve[i];
      if (t >= time) {
        const prev = curve[i - 1][1];
        speed = prev + (value - prev) * Math.min(1, (t - time) / 5);
      }
    }
    const lastTime = curve[curve.length - 1][0];
    if (t > lastTime + 5) {
      const { growth, maxExtra } = CONFIG.endlessSpeed;
      speed += Math.min(maxExtra, (t - lastTime - 5) * growth);
    }
    return speed;
  }

  private updateZone(distance: number) {
    const blend = zoneBlendAt(distance);
    // per-zone lighting crossfades with the palette
    this.hemi.intensity = blend.a.hemi + (blend.b.hemi - blend.a.hemi) * blend.t;
    this.dirLight.intensity = blend.a.dir + (blend.b.dir - blend.a.dir) * blend.t;

    if (blend.index !== this.zoneIndex) {
      this.zoneIndex = blend.index;
      if (this.state === 'playing') {
        this.ui.toast(ZONES[blend.index].name);
        this.audio.setIntensity(blend.index / (ZONES.length - 1));
        this.audio.combo(0);
      }
    }
  }

  // ----------------------------------------------------------------- input

  private handleTap(x: number, y: number, cssX: number, cssY: number) {
    if (this.state !== 'playing') return;
    this.audio.unlock();
    this.ui.tapRipple(cssX, cssY);

    if (this.ammo.empty) {
      this.audio.denied();
      this.ui.popup(0.5, 0.55, 'NO SPHERES!', 'danger');
      return;
    }

    const ray = this.scene.createPickingRay(x, y, null, this.rig.camera);

    // Spheres launch faster as the run speeds up, so shots stay viable.
    const fireSpeed =
      CONFIG.projectile.speed + Math.max(0, this.currentSpeed - 12) * CONFIG.projectile.speedPerGameSpeed;

    // Multi-shot: 3-sphere fan for the price of one (doc §28-A).
    const yaws = this.powerups.multiShotActive
      ? [0, -CONFIG.powerups.multiShot.spread, CONFIG.powerups.multiShot.spread]
      : [0];

    let spawn: Vector3 | null = null;
    for (const yaw of yaws) {
      let shotRay = ray;
      if (yaw !== 0) {
        const d = ray.direction;
        const cos = Math.cos(yaw);
        const sin = Math.sin(yaw);
        shotRay = new Ray(ray.origin, new Vector3(d.x * cos + d.z * sin, d.y, -d.x * sin + d.z * cos), ray.length);
      }

      // Aim assist: bend the shot toward the best breakable near the tap
      // ray, leading moving targets by their tracked velocity.
      const assist = this.spawner.findAimTarget(shotRay, fireSpeed);
      let aimPoint: Vector3 | null = null;
      if (assist) {
        const raw = shotRay.origin.add(shotRay.direction.scale(CONFIG.projectile.aimDistance));
        aimPoint = Vector3.Lerp(raw, assist, CONFIG.aimAssist.strength);
      }

      // only the center sphere counts as a miss (combo-wise) if it whiffs
      const s = this.projectiles.fire(shotRay, aimPoint, fireSpeed, yaw === 0);
      if (s && !spawn) spawn = s;
    }
    if (!spawn) return;
    this.shatter.flash(spawn.add(ray.direction.scale(0.4)), 0.45);
    this.rig.shake(0.012); // subtle launch recoil

    this.ammo.spend();
    this.score.registerShot();
    this.audio.shoot();

    if (!this.firstShotFired) {
      this.firstShotFired = true;
      this.ui.prompt('');
    }
    this.checkLowAmmo();
  }

  // ------------------------------------------------------------- hit logic

  private handleOutcome(outcome: HitOutcome) {
    const screen = this.worldToScreen(outcome.point);

    if (!outcome.broke) {
      // Reinforced plate cracked — one more hit needed.
      this.score.addHit(0);
      this.audio.crack();
      this.vibrate(12);
      this.ui.popup(screen.x, screen.y, 'CRACKED!');
      this.ui.setCombo(this.score.combo, this.score.multiplier);
      return;
    }

    const result = this.score.addHit(outcome.score);
    this.ui.scorePop();
    let label = `+${result.points}`;
    let cls = '';

    if (outcome.perfect) {
      this.score.addBonusPoints(CONFIG.score.perfect);
      // a breath of hit-stop makes dead-center shots feel surgical
      this.freezeTimer = Math.max(this.freezeTimer, 0.02);
      label = `PERFECT +${result.points + CONFIG.score.perfect}`;
      cls = 'gold';
    }

    if (outcome.kind === 'danger') {
      this.freezeTimer = 0.045;
      this.rig.shake(0.05);
      this.audio.dangerBreak();
      this.vibrate(35);
      cls = 'danger';
    } else if (outcome.kind === 'bonus') {
      this.audio.bonus();
      this.vibrate(15);
    } else if (outcome.kind !== 'power') {
      this.audio.glassBreak(Math.min(1.4, 0.7 + outcome.score / 25));
      this.vibrate(15);
    }

    if (outcome.power) this.collectPower(outcome.power, screen.x, Math.max(0.1, screen.y - 0.06));

    this.ui.popup(screen.x, screen.y, label, cls);

    if (outcome.ammo > 0) {
      this.ammo.gain(outcome.ammo);
      this.audio.ammoGain();
      this.ui.popup(screen.x, Math.max(0.1, screen.y - 0.05), `+${outcome.ammo} SPHERES`, 'gold');
      this.ui.ammoGainFlash();
      this.checkLowAmmo();
    }

    if (result.tierReached !== null) {
      this.ammo.gain(CONFIG.combo.milestoneAmmo);
      this.audio.combo(result.tierReached);
      this.vibrate(20);
      this.ui.popup(0.5, 0.4, `COMBO x${result.multiplier}`, 'big gold');
      this.ui.ammoGainFlash();
      this.ui.edgeFlash('gold');
    }

    this.ui.setCombo(this.score.combo, this.score.multiplier);

    if (!this.firstBreakDone) {
      this.firstBreakDone = true;
      this.ui.prompt('Hit crystals for more spheres', 2600);
    }
  }

  private collectPower(kind: NonNullable<HitOutcome['power']>, sx: number, sy: number) {
    this.powerups.activate(kind);
    this.audio.powerup();
    this.vibrate(30);
    this.ui.popup(sx, sy, POWERUP_LABELS[kind], 'big gold');
    if (kind === 'slowrift') {
      this.ui.setSlowTint(true);
      this.audio.riftEnter();
    } else if (kind === 'shield') {
      this.ui.setShield(true);
    }
  }

  // ------------------------------------------------------------ collisions

  private handleCollisions(dt: number) {
    void dt;
    const obstacle = this.spawner.checkCollision(this.rig.camera.position);
    if (!obstacle) return;

    // Shield Pulse absorbs the whole collision (doc §28-E).
    if (this.powerups.consumeShield()) {
      obstacle.forceBreak(this.shatter, FORWARD);
      this.rig.shake(0.06);
      this.audio.shieldBlock();
      this.vibrate(40);
      this.ui.setShield(false);
      this.ui.popup(0.5, 0.5, 'SHIELD!', 'big');
      return;
    }

    const wasEmpty = this.ammo.empty;
    const fatal = this.ammo.penalize(obstacle.collisionCost);

    obstacle.forceBreak(this.shatter, FORWARD);
    this.rig.shake(0.14);
    this.ui.damageFlash();
    this.audio.collide();
    this.vibrate(70);
    this.score.collision();
    this.ui.setCombo(0, 1);
    this.ui.popup(0.5, 0.5, `-${obstacle.collisionCost}`, 'danger big');

    if (wasEmpty || fatal) {
      this.gameOver();
    } else {
      this.checkLowAmmo();
    }
  }

  private checkLowAmmo() {
    this.ui.setLowAmmo(this.ammo.low);
    if (this.ammo.empty) {
      this.ui.prompt('Out of spheres — dodge to survive!');
    } else if (this.ammo.low && !this.lowAmmoWarned) {
      this.lowAmmoWarned = true;
      this.ui.prompt("Don't run out!", 2200);
    }
  }

  // ------------------------------------------------------------ game state

  private startRun() {
    this.audio.unlock();
    this.audio.setIntensity(0);

    this.projectiles.clear();
    this.spawner.reset(this.rig.z);
    this.score.reset();
    this.ammo.reset();

    this.runTime = 0;
    this.runStartZ = this.rig.z - this.debugDist;
    this.corridor.setRunStart(this.runStartZ);
    this.zoneIndex = zoneBlendAt(this.debugDist).index;
    this.currentSpeed = CONFIG.speedCurve[0][1];
    this.nextMilestone = 0;
    this.lastWhoosh = 0;
    this.powerups.reset();
    this.ui.setPowerUp(null, 0);
    this.ui.setShield(false);
    this.ui.setSlowTint(false);
    this.firstShotFired = false;
    this.firstBreakDone = false;
    this.lowAmmoWarned = false;
    this.lastScore = -1;
    this.lastAmmo = -1;
    this.lastDistance = -1;
    this.displayScore = 0;

    this.ui.showPlaying();
    this.ui.setLowAmmo(false);
    this.ui.setCombo(0, 1);
    this.ui.prompt('Tap to shoot');
    this.refreshHud(0);

    this.state = 'playing';
  }

  private gameOver() {
    this.state = 'gameover';
    this.powerups.reset();
    this.ui.setPowerUp(null, 0);
    this.ui.setShield(false);
    this.ui.setSlowTint(false);
    const isNewBest = this.score.finishRun();
    if (isNewBest) playables.saveBestScore(this.score.best);
    playables.sendScore(this.score.score);
    this.audio.gameOver();
    this.vibrate(120);
    this.ui.showGameOver({
      score: this.score.score,
      best: this.score.best,
      isNewBest,
      distance: this.score.distance,
      accuracy: this.score.accuracy,
      smashed: this.score.objectsSmashed,
    });
  }

  // --------------------------------------------------------------- helpers

  private refreshHud(distance: number, dt = 0.016) {
    // score counts up toward the real value — big hits visibly "roll in"
    this.displayScore += (this.score.score - this.displayScore) * Math.min(1, dt * 10);
    if (this.score.score - this.displayScore < 1) this.displayScore = this.score.score;
    const shown = Math.floor(this.displayScore);
    if (shown !== this.lastScore) {
      this.lastScore = shown;
      this.ui.setScore(shown);
    }
    if (this.ammo.count !== this.lastAmmo) {
      this.lastAmmo = this.ammo.count;
      this.ui.setAmmo(this.lastAmmo);
    }
    const meters = Math.floor(distance);
    if (meters !== this.lastDistance) {
      this.lastDistance = meters;
      this.ui.setDistance(meters);
    }
  }

  /** Project a world point to stage-fraction coordinates for UI popups. */
  private worldToScreen(p: Vector3): { x: number; y: number } {
    const w = this.engine.getRenderWidth();
    const h = this.engine.getRenderHeight();
    const projected = Vector3.Project(
      p,
      Matrix.IdentityReadOnly,
      this.scene.getTransformMatrix(),
      this.rig.camera.viewport.toGlobal(w, h)
    );
    return {
      x: Math.min(0.9, Math.max(0.1, projected.x / w)),
      y: Math.min(0.85, Math.max(0.12, projected.y / h)),
    };
  }

  private vibrate(ms: number) {
    if (navigator.vibrate) navigator.vibrate(ms);
  }
}
