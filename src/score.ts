import { CONFIG } from './config';

export interface HitResult {
  points: number;
  combo: number;
  multiplier: number;
  /** Combo tier index newly reached by this hit (for milestones), or null. */
  tierReached: number | null;
}

export class ScoreSystem {
  score = 0;
  best = 0;
  combo = 0;
  comboTimer = 0;
  distance = 0;
  shotsFired = 0;
  shotsHit = 0;
  objectsSmashed = 0;
  private fractionalScore = 0;
  private reachedTiers = new Set<number>();

  /** Best score arrives asynchronously (Playables cloud save / localStorage). */
  setBest(best: number) {
    this.best = Math.max(this.best, best);
  }

  reset() {
    this.score = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.distance = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.objectsSmashed = 0;
    this.fractionalScore = 0;
    this.reachedTiers.clear();
  }

  get multiplier(): number {
    let m = 1;
    for (const [hits, mult] of CONFIG.combo.tiers) {
      if (this.combo >= hits) m = mult;
    }
    return m;
  }

  get accuracy(): number {
    return this.shotsFired === 0 ? 0 : Math.round((this.shotsHit / this.shotsFired) * 100);
  }

  registerShot() {
    this.shotsFired++;
  }

  /** A successful break/hit worth `base` points. */
  addHit(base: number): HitResult {
    this.shotsHit++;
    this.objectsSmashed++;
    this.combo++;
    this.comboTimer = CONFIG.combo.window;

    let tierReached: number | null = null;
    CONFIG.combo.tiers.forEach(([hits], i) => {
      if (this.combo === hits && !this.reachedTiers.has(i)) {
        this.reachedTiers.add(i);
        tierReached = i;
      }
    });

    const points = Math.round(base * this.multiplier);
    this.score += points;
    return { points, combo: this.combo, multiplier: this.multiplier, tierReached };
  }

  addBonusPoints(points: number) {
    this.score += points;
  }

  miss() {
    this.resetCombo();
  }

  collision() {
    this.resetCombo();
  }

  private resetCombo() {
    this.combo = 0;
    this.comboTimer = 0;
    this.reachedTiers.clear();
  }

  /** Per-frame: combo window countdown + passive distance score (doc §13). */
  update(dt: number, metersDelta: number) {
    this.distance += metersDelta;
    this.fractionalScore += metersDelta * CONFIG.score.distanceRate;
    if (this.fractionalScore >= 1) {
      const whole = Math.floor(this.fractionalScore);
      this.score += whole;
      this.fractionalScore -= whole;
    }
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.resetCombo();
    }
  }

  /** Returns true when this run set a new best score.
   *  Persistence is the caller's job (playables.saveBestScore). */
  finishRun(): boolean {
    const isBest = this.score > this.best;
    if (isBest) this.best = this.score;
    return isBest;
  }
}
