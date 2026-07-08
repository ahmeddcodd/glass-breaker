export interface GameOverStats {
  score: number;
  best: number;
  isNewBest: boolean;
  distance: number;
  accuracy: number;
  smashed: number;
}

// All UI is a DOM overlay (doc §24-25): crisper text than in-scene UI and a
// clean portrait layout with the top 8% reserved for HUD numbers.
export type AudioSetting = 'sfx' | 'music' | 'ambient';

export class UI {
  onStart: () => void = () => {};
  onRestart: () => void = () => {};
  onContinue: () => void = () => {};
  /** Fired when a settings toggle changes: which one and its new value. */
  onSettingChange: (key: AudioSetting, value: boolean) => void = () => {};

  private scoreEl: HTMLElement;
  private ammoEl: HTMLElement;
  private distanceEl: HTMLElement;
  private comboEl: HTMLElement;
  private hudEl: HTMLElement;
  private promptEl: HTMLElement;
  private promptMainEl: HTMLElement;
  private promptSubEl: HTMLElement;
  private toastEl: HTMLElement;
  private popupLayer: HTMLElement;
  private vignetteEl: HTMLElement;
  private hitFlashEl: HTMLElement;
  private startScreen: HTMLElement;
  private overScreen: HTMLElement;
  private powerBadge: HTMLElement;
  private powerName: HTMLElement;
  private powerFill: HTMLElement;
  private shieldBadge: HTMLElement;
  private slowTint: HTMLElement;
  private continueBtn: HTMLElement;
  private countdownEl: HTMLElement;
  private fakeAdEl: HTMLElement;
  private fakeAdTimerEl: HTMLElement;
  private fakeAdSkipEl: HTMLElement;
  private settingsBtn: HTMLElement;
  private settingsPanel: HTMLElement;
  private settingsNote: HTMLElement;
  private toggles: Record<AudioSetting, HTMLElement>;
  private promptTimer: number | null = null;
  private lastPowerLabel: string | null = null;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="hud" id="hud">
        <div class="hud-block">
          <span class="hud-label">Score</span>
          <span class="hud-value" id="score-value">0</span>
        </div>
        <div class="hud-block center">
          <span class="hud-value" id="distance-value">0m</span>
          <span id="combo-badge">COMBO x1</span>
          <div id="powerup-badge">
            <span id="powerup-name"></span>
            <div id="powerup-bar"><div id="powerup-fill"></div></div>
          </div>
          <span id="shield-badge">◈ SHIELD READY</span>
        </div>
        <div class="hud-block right">
          <span class="hud-label">Spheres</span>
          <span class="hud-value" id="ammo-value">25</span>
        </div>
      </div>
      <div id="zone-toast"></div>
      <div id="prompt"><span id="prompt-main"></span><span id="prompt-sub"></span></div>
      <div id="popup-layer"></div>
      <div id="vignette"></div>
      <div id="hit-flash"></div>
      <div id="effect-flash"></div>
      <div id="slow-tint"></div>
      <div id="countdown"></div>
      <div id="fake-ad">
        <div id="fake-ad-badge">AD</div>
        <div id="fake-ad-title">AD BREAK</div>
        <div id="fake-ad-timer"></div>
        <button class="btn" id="fake-ad-skip" style="display:none">Skip Ad</button>
      </div>
      <button id="settings-btn" aria-label="Settings">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
      </button>
      <div id="settings-panel">
        <div id="settings-card">
          <div id="settings-title">Settings</div>
          <label class="setting-row"><span>Sound Effects</span><span class="toggle" id="toggle-sfx"><span class="toggle-knob"></span></span></label>
          <label class="setting-row"><span>Music</span><span class="toggle" id="toggle-music"><span class="toggle-knob"></span></span></label>
          <label class="setting-row"><span>Ambient</span><span class="toggle" id="toggle-ambient"><span class="toggle-knob"></span></span></label>
          <div id="settings-note"></div>
          <button class="btn" id="settings-close">Done</button>
        </div>
      </div>
      <div class="screen" id="start-screen">
        <div class="game-title">Glass<br/>Breaker</div>
        <div class="game-subtitle">Break glass · Save spheres · Survive</div>
        <div class="tap-hint">Tap to Start</div>
      </div>
      <div class="screen" id="gameover-screen">
        <div class="gameover-title">Run Over</div>
        <div class="final-score-label" style="margin-top:4vh">Score</div>
        <div class="final-score" id="final-score">0</div>
        <div class="new-best" id="new-best" style="display:none">New Best!</div>
        <div class="stats">
          <div class="stat-row"><span>Best</span><b id="stat-best">0</b></div>
          <div class="stat-row"><span>Distance</span><b id="stat-distance">0m</b></div>
          <div class="stat-row"><span>Accuracy</span><b id="stat-accuracy">0%</b></div>
          <div class="stat-row"><span>Smashed</span><b id="stat-smashed">0</b></div>
        </div>
        <button class="btn btn-continue" id="continue-btn" style="display:none">
          <span class="btn-continue-icon">▶</span> Continue
          <span class="btn-continue-sub">Watch ad to revive</span>
        </button>
        <button class="btn" id="restart-btn">Play Again</button>
      </div>
    `;

    const get = (id: string) => document.getElementById(id)!;
    this.hudEl = get('hud');
    this.scoreEl = get('score-value');
    this.ammoEl = get('ammo-value');
    this.distanceEl = get('distance-value');
    this.comboEl = get('combo-badge');
    this.promptEl = get('prompt');
    this.promptMainEl = get('prompt-main');
    this.promptSubEl = get('prompt-sub');
    this.toastEl = get('zone-toast');
    this.popupLayer = get('popup-layer');
    this.vignetteEl = get('vignette');
    this.hitFlashEl = get('hit-flash');
    this.startScreen = get('start-screen');
    this.overScreen = get('gameover-screen');
    this.powerBadge = get('powerup-badge');
    this.powerName = get('powerup-name');
    this.powerFill = get('powerup-fill');
    this.shieldBadge = get('shield-badge');
    this.slowTint = get('slow-tint');
    this.continueBtn = get('continue-btn');
    this.countdownEl = get('countdown');
    this.fakeAdEl = get('fake-ad');
    this.fakeAdTimerEl = get('fake-ad-timer');
    this.fakeAdSkipEl = get('fake-ad-skip');
    this.settingsBtn = get('settings-btn');
    this.settingsPanel = get('settings-panel');
    this.settingsNote = get('settings-note');
    this.toggles = { sfx: get('toggle-sfx'), music: get('toggle-music'), ambient: get('toggle-ambient') };

    this.startScreen.addEventListener('pointerdown', () => this.onStart());
    get('restart-btn').addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      this.onRestart();
    });
    this.continueBtn.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      this.onContinue();
    });

    // Settings: gear opens the panel; each toggle fires onSettingChange; the
    // panel closes on Done or a tap on the backdrop (outside the card).
    this.settingsBtn.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      this.openSettings();
    });
    get('settings-close').addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      this.closeSettings();
    });
    this.settingsPanel.addEventListener('pointerdown', (ev) => {
      if (ev.target === this.settingsPanel) this.closeSettings(); // backdrop tap
    });
    (Object.keys(this.toggles) as AudioSetting[]).forEach((key) => {
      this.toggles[key].addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        const next = !this.toggles[key].classList.contains('on');
        this.setToggleVisual(key, next);
        this.onSettingChange(key, next);
      });
    });
  }

  showStart() {
    this.startScreen.classList.add('visible');
    this.overScreen.classList.remove('visible');
    this.hudEl.classList.remove('visible');
  }

  showPlaying() {
    this.startScreen.classList.remove('visible');
    this.overScreen.classList.remove('visible');
    this.hudEl.classList.add('visible');
  }

  showGameOver(stats: GameOverStats, canContinue = false) {
    this.hudEl.classList.remove('visible');
    this.setLowAmmo(false);
    this.prompt('');
    document.getElementById('final-score')!.textContent = String(stats.score);
    document.getElementById('stat-best')!.textContent = String(stats.best);
    document.getElementById('stat-distance')!.textContent = `${Math.round(stats.distance)}m`;
    document.getElementById('stat-accuracy')!.textContent = `${stats.accuracy}%`;
    document.getElementById('stat-smashed')!.textContent = String(stats.smashed);
    document.getElementById('new-best')!.style.display = stats.isNewBest ? '' : 'none';
    this.setContinueEnabled(canContinue);
    this.continueBtn.style.display = canContinue ? '' : 'none';
    this.overScreen.classList.add('visible');
  }

  /** Enable/disable the Continue button (disabled while an ad is loading). */
  setContinueEnabled(enabled: boolean) {
    this.continueBtn.classList.toggle('loading', !enabled);
    (this.continueBtn as HTMLButtonElement).disabled = !enabled;
  }

  /** Swap the Continue button label to a loading state while the ad plays. */
  setContinueLoading(loading: boolean) {
    this.setContinueEnabled(!loading);
    this.continueBtn.classList.toggle('is-loading', loading);
  }

  /** Hide the whole game-over screen (used when a revive is granted). */
  hideGameOver() {
    this.overScreen.classList.remove('visible');
  }

  // -------------------------------------------------------------- settings

  /** Reflect the current settings on the toggles (called after load). */
  setSettingsState(s: Record<AudioSetting, boolean>) {
    (Object.keys(this.toggles) as AudioSetting[]).forEach((k) => this.setToggleVisual(k, s[k]));
  }

  private setToggleVisual(key: AudioSetting, on: boolean) {
    this.toggles[key].classList.toggle('on', on);
  }

  /**
   * Show/hide a note in the panel (used to tell the player that YouTube has
   * muted everything, so their toggles look inert on purpose — no conflict).
   */
  setSettingsMuteNote(ytMuted: boolean) {
    this.settingsNote.textContent = ytMuted ? 'Muted by YouTube' : '';
    this.settingsNote.classList.toggle('visible', ytMuted);
  }

  private openSettings() {
    this.settingsPanel.classList.add('visible');
  }

  private closeSettings() {
    this.settingsPanel.classList.remove('visible');
  }

  /** Show/hide the gear button (hidden during active play to keep the HUD clean). */
  setSettingsButtonVisible(visible: boolean) {
    this.settingsBtn.classList.toggle('visible', visible);
    if (!visible) this.closeSettings();
  }

  /**
   * Placeholder "ad break" for hosting without real YouTube ads (Vercel/local).
   * Shows a full-screen ad screen with a countdown; resolves when it finishes
   * or the player taps Skip (enabled after a couple seconds). Never used in the
   * real Playables env — genuine ads run there instead.
   */
  showFakeAd(seconds = 4): Promise<void> {
    return new Promise((resolve) => {
      let remaining = seconds;
      this.fakeAdEl.classList.add('visible');
      this.fakeAdSkipEl.style.display = 'none';
      this.fakeAdTimerEl.textContent = `Ad · ${remaining}s`;

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearInterval(timer);
        this.fakeAdSkipEl.removeEventListener('pointerdown', onSkip);
        this.fakeAdEl.classList.remove('visible');
        resolve();
      };
      const onSkip = (ev: Event) => {
        ev.stopPropagation();
        finish();
      };
      this.fakeAdSkipEl.addEventListener('pointerdown', onSkip);

      const timer = window.setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          finish();
          return;
        }
        this.fakeAdTimerEl.textContent = `Ad · ${remaining}s`;
        if (remaining <= seconds - 2) this.fakeAdSkipEl.style.display = '';
      }, 1000);
    });
  }

  /**
   * Show a single big countdown number ("3", "2", "1", or "GO!"). Pass an
   * empty string to clear it. Re-triggers the pop animation each call.
   */
  showCountdown(text: string) {
    if (!text) {
      this.countdownEl.classList.remove('show');
      this.countdownEl.textContent = '';
      return;
    }
    this.countdownEl.textContent = text;
    this.countdownEl.classList.remove('show');
    void this.countdownEl.offsetWidth; // restart the CSS animation
    this.countdownEl.classList.add('show');
  }

  setScore(score: number) {
    this.scoreEl.textContent = String(score);
  }

  /** Quick scale-bump on the score number when a break lands. */
  scorePop() {
    this.scoreEl.classList.remove('pop');
    void this.scoreEl.offsetWidth;
    this.scoreEl.classList.add('pop');
  }

  /** Full-screen edge flash: 'cyan' for speed-ups, 'gold' for combo tiers. */
  edgeFlash(kind: 'cyan' | 'gold') {
    const el = document.getElementById('effect-flash')!;
    el.className = '';
    void el.offsetWidth;
    el.className = `flash-${kind}`;
  }

  setAmmo(count: number) {
    this.ammoEl.textContent = String(count);
  }

  ammoGainFlash() {
    this.ammoEl.classList.remove('gain');
    void this.ammoEl.offsetWidth; // restart the CSS animation
    this.ammoEl.classList.add('gain');
  }

  setLowAmmo(low: boolean) {
    this.ammoEl.classList.toggle('low', low);
    this.vignetteEl.classList.toggle('active', low);
  }

  setDistance(meters: number) {
    this.distanceEl.textContent = `${Math.floor(meters)}m`;
  }

  setCombo(combo: number, multiplier: number) {
    const show = combo >= 2;
    this.comboEl.classList.toggle('visible', show);
    if (show) {
      this.comboEl.textContent = multiplier > 1 ? `COMBO x${multiplier}` : `COMBO ${combo}`;
      this.comboEl.classList.remove('bump');
      void (this.comboEl as HTMLElement).offsetWidth;
      this.comboEl.classList.add('bump');
    }
  }

  /** Tutorial / feedback line at the bottom of the screen. An optional second
   *  line (smaller, dimmer, un-spaced) carries longer explanatory hints. */
  prompt(text: string, durationMs = 0, subText = '') {
    if (this.promptTimer !== null) {
      clearTimeout(this.promptTimer);
      this.promptTimer = null;
    }
    if (!text) {
      this.promptEl.classList.remove('visible');
      return;
    }
    this.promptMainEl.textContent = text;
    this.promptSubEl.textContent = subText;
    this.promptSubEl.style.display = subText ? '' : 'none';
    this.promptEl.classList.add('visible');
    if (durationMs > 0) {
      this.promptTimer = window.setTimeout(() => this.promptEl.classList.remove('visible'), durationMs);
    }
  }

  /** Big zone-name announcement. */
  toast(text: string) {
    this.toastEl.textContent = text;
    this.toastEl.classList.remove('show');
    void this.toastEl.offsetWidth;
    this.toastEl.classList.add('show');
  }

  /** Floating score text at a screen position (fractions 0..1 of the stage). */
  popup(fx: number, fy: number, text: string, cls = '') {
    const el = document.createElement('div');
    el.className = `popup ${cls}`.trim();
    el.textContent = text;
    el.style.left = `${(fx * 100).toFixed(1)}%`;
    el.style.top = `${(fy * 100).toFixed(1)}%`;
    // slight random tilt so stacked popups don't read as UI furniture
    el.style.setProperty('--rot', `${(Math.random() * 12 - 6).toFixed(1)}deg`);
    this.popupLayer.appendChild(el);
    setTimeout(() => el.remove(), 950);
  }

  damageFlash() {
    this.hitFlashEl.classList.remove('flash');
    void this.hitFlashEl.offsetWidth;
    this.hitFlashEl.classList.add('flash');
  }

  /** Timed power-up badge: label + draining bar. Pass null to hide. */
  setPowerUp(label: string | null, progress: number) {
    if (label !== this.lastPowerLabel) {
      this.lastPowerLabel = label;
      this.powerBadge.classList.toggle('visible', label !== null);
      if (label) this.powerName.textContent = label;
    }
    if (label) this.powerFill.style.width = `${Math.round(progress * 100)}%`;
  }

  setShield(on: boolean) {
    this.shieldBadge.classList.toggle('visible', on);
  }

  setSlowTint(on: boolean) {
    this.slowTint.classList.toggle('active', on);
  }

  /** Instant expanding ring at the touch point (stage-relative CSS px). */
  tapRipple(x: number, y: number) {
    const el = document.createElement('div');
    el.className = 'tap-ripple';
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    this.popupLayer.appendChild(el);
    setTimeout(() => el.remove(), 500);
  }
}
