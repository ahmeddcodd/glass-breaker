import { CONFIG } from './config';
import type { PowerUpKind } from './config';

// Power-up state (doc §28): one timed effect at a time (multi-shot or slow
// rift; collecting a new one replaces the old) plus an independent shield
// charge that persists until it absorbs a collision.
export class PowerUpManager {
  private timed: 'multishot' | 'slowrift' | null = null;
  private remaining = 0;
  private duration = 1;
  shieldReady = false;

  /** Fired when a timed effect runs out (slow rift needs an exit cue). */
  onTimedEnd: (kind: 'multishot' | 'slowrift') => void = () => {};

  activate(kind: PowerUpKind) {
    if (kind === 'shield') {
      this.shieldReady = true;
      return;
    }
    if (this.timed === 'slowrift' && kind !== 'slowrift') this.onTimedEnd('slowrift');
    this.timed = kind;
    this.duration = kind === 'multishot' ? CONFIG.powerups.multiShot.duration : CONFIG.powerups.slowRift.duration;
    this.remaining = this.duration;
  }

  /** dt must be real (unscaled) time so slow rift doesn't stretch itself. */
  update(dt: number) {
    if (!this.timed) return;
    this.remaining -= dt;
    if (this.remaining <= 0) {
      const ended = this.timed;
      this.timed = null;
      this.onTimedEnd(ended);
    }
  }

  get multiShotActive(): boolean {
    return this.timed === 'multishot';
  }

  get slowRiftActive(): boolean {
    return this.timed === 'slowrift';
  }

  get activeTimed(): 'multishot' | 'slowrift' | null {
    return this.timed;
  }

  /** 1 → 0 as the timed effect drains. */
  get progress(): number {
    return this.timed ? Math.max(0, this.remaining / this.duration) : 0;
  }

  /** Try to absorb a collision. Returns true if the shield ate it. */
  consumeShield(): boolean {
    if (!this.shieldReady) return false;
    this.shieldReady = false;
    return true;
  }

  reset() {
    if (this.timed) this.onTimedEnd(this.timed);
    this.timed = null;
    this.remaining = 0;
    this.shieldReady = false;
  }
}
