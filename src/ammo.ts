import { CONFIG } from './config';

// Ammo doubles as health (doc §14): shots spend it, crystals refill it,
// collisions drain it, and dropping below zero ends the run.
export class AmmoSystem {
  count = CONFIG.ammo.start;

  reset() {
    this.count = CONFIG.ammo.start;
  }

  get low(): boolean {
    return this.count <= CONFIG.ammo.lowWarning;
  }

  get empty(): boolean {
    return this.count <= 0;
  }

  spend(): boolean {
    if (this.count <= 0) return false;
    this.count--;
    return true;
  }

  gain(n: number) {
    this.count += n;
  }

  /** Apply a collision penalty. Returns true when it kills the run. */
  penalize(n: number): boolean {
    const fatal = this.count - n < 0;
    this.count = Math.max(0, this.count - n);
    return fatal;
  }
}
