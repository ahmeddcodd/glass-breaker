// Procedural WebAudio sound (doc §26): zero asset files. Everything is
// synthesized — filtered noise bursts for glass, sine pings for rewards,
// and an ADAPTIVE MUSIC ENGINE: a step sequencer whose tempo follows the
// run speed, whose key follows the zone, and whose layers react to combo,
// low ammo and slow rift. The context is created on the first user gesture.

// Per-zone musical identity: root note + brightness of the pad.
// Zone 0 calm A minor, zone 1 lifted C, zone 2 dark low F#, zone 3 high A.
const ZONE_ROOTS = [55, 65.41, 46.25, 110];

// minor pentatonic ratios — everything melodic pulls from this, so random
// combinations always sound intentional
const SCALE = [1, 6 / 5, 4 / 3, 3 / 2, 16 / 9, 2];

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private ambientGain: GainNode | null = null;
  private lfo: OscillatorNode | null = null;
  // pad voices with the harmonic ratio each holds relative to the zone root,
  // so a zone change can retune the whole chord by ratio * newRoot
  private padOscs: OscillatorNode[] = [];
  private padRatios: number[] = [];
  // shared reverb send: gives the pad (and a touch of the music) a sense of
  // space so the bed reads as background music rather than dry tones
  private reverb: ConvolverNode | null = null;
  private reverbGain: GainNode | null = null;

  // music bus: sequenced notes route through a filter so slow rift can
  // muffle the whole soundtrack at once
  private musicGain: GainNode | null = null;
  private musicFilter: BiquadFilterNode | null = null;

  // sequencer state
  private step = 0;
  private nextStepTime = 0;
  private barCount = 0;
  private msPlaying = false;
  private msSpeed = 12;
  private msZone = 0;
  private msCombo = 0;
  private msLowAmmo = false;
  private msSlow = false;
  private appliedZone = -1;

  // YouTube Playables audio toggle: when muted, nothing may reach the output
  private muted = false;
  private paused = false;

  /** Hard mute (Playables cert): zero the master bus, survive unlock order. */
  setEnabled(enabled: boolean) {
    this.muted = !enabled;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
  }

  /** Freeze the whole audio graph while the game is paused by YouTube. */
  suspend() {
    this.paused = true;
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }

  resume() {
    this.paused = false;
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  unlock() {
    if (this.paused) return; // don't fight a Playables pause
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    // Bus compressor/limiter glues the mix and guards against clipping now that
    // the background bed carries real level + reverb — makes it sound produced.
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 24;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.006;
    comp.release.value = 0.22;
    this.master.connect(comp).connect(this.ctx.destination);

    // 1s of shared white noise, reused by every burst.
    const len = this.ctx.sampleRate;
    this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.musicFilter = this.ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 12000;
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.55;
    this.musicGain.connect(this.musicFilter).connect(this.master);

    this.startAmbient();
    this.nextStepTime = this.ctx.currentTime + 0.15;
    window.setInterval(() => this.scheduleAhead(), 85);
  }

  /** Fed every frame by the game loop — drives tempo, key and layers. */
  setMusicState(playing: boolean, speed: number, zone: number, combo: number, lowAmmo: boolean, slow: boolean) {
    this.msPlaying = playing;
    this.msSpeed = speed;
    this.msZone = Math.min(zone, ZONE_ROOTS.length - 1);
    this.msCombo = combo;
    this.msLowAmmo = lowAmmo;

    if (this.msSlow !== slow && this.ctx && this.musicFilter) {
      // slow rift: muffle the soundtrack and (via BPM) halve the pulse
      this.musicFilter.frequency.linearRampToValueAtTime(slow ? 380 : 12000, this.ctx.currentTime + 0.25);
    }
    this.msSlow = slow;

    if (this.msZone !== this.appliedZone && this.ctx) {
      this.appliedZone = this.msZone;
      const root = ZONE_ROOTS[this.msZone];
      const t = this.ctx.currentTime + 1.2;
      // retune the whole chord: each voice keeps its harmonic ratio to the root
      this.padOscs.forEach((osc, i) => {
        osc.frequency.linearRampToValueAtTime(root * this.padRatios[i], t);
      });
    }
  }

  // ------------------------------------------------------------ sequencer

  private currentBpm(): number {
    // pulse quickens with the run: 96 bpm at start, ~180 at max speed
    const base = 96 + (this.msSpeed - 12) * 3.8;
    return this.msSlow ? base * 0.5 : base;
  }

  private scheduleAhead() {
    if (!this.ctx) return;
    const lookahead = 0.2;
    while (this.nextStepTime < this.ctx.currentTime + lookahead) {
      if (this.msPlaying) this.scheduleStep(this.nextStepTime, this.step);
      const stepDur = 60 / this.currentBpm() / 4; // 16th notes
      this.nextStepTime += stepDur;
      this.step = (this.step + 1) % 16;
      if (this.step === 0) this.barCount++;
    }
  }

  /** One 16th-note step of the driving pulse. */
  private scheduleStep(t: number, step: number) {
    const root = ZONE_ROOTS[this.msZone];
    const drive = Math.min(1, (this.msSpeed - 12) / 22); // 0 → 1 across the run

    // KICK — four on the floor, the heartbeat of "keep going"
    if (step % 4 === 0) this.kickAt(t, 0.34 + drive * 0.1);

    // HATS — offbeats; 16th ticks sneak in as speed rises
    if (step % 4 === 2) this.hatAt(t, 0.07 + drive * 0.05);
    else if (drive > 0.35 && step % 2 === 1) this.hatAt(t, 0.028 + drive * 0.02);

    // BASS — pulsing minor-pentatonic line, brighter filter at speed
    const bassSteps: Record<number, number> = { 0: 0, 6: 3, 8: 0, 11: 4, 14: 5 };
    if (step in bassSteps) {
      const alt = this.barCount % 2 === 1 && step === 11 ? 1 : bassSteps[step];
      this.bassAt(t, root * 2 * SCALE[alt], 260 + this.msSpeed * 26);
    }

    // ARP — sparkle layer that only exists while a combo is alive
    if (this.msCombo >= 3 && step % 4 === 1) {
      const idx = (step + this.barCount * 3) % SCALE.length;
      const gain = 0.05 + Math.min(0.06, this.msCombo * 0.006);
      this.arpAt(t, root * 8 * SCALE[idx], gain);
    }

    // LOW AMMO — anxious 16th tick, quiet but insistent
    if (this.msLowAmmo && step % 2 === 1) {
      this.pingAt(t, 2600, 0.03, 0.022, 'sine', this.musicGain);
    }
  }

  private lastKickTime = 0;

  /** 1 on each kick, decaying to 0 — lets visuals pulse with the beat. */
  beatPulse(): number {
    if (!this.ctx) return 0;
    const d = this.ctx.currentTime - this.lastKickTime;
    if (d < 0) return 1; // kick scheduled just ahead of now
    return Math.max(0, 1 - d * 3.2);
  }

  private kickAt(t: number, gain: number) {
    if (!this.ctx || !this.musicGain) return;
    this.lastKickTime = t;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(44, t + 0.11);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(g).connect(this.musicGain);
    osc.start(t);
    osc.stop(t + 0.18);
  }

  private hatAt(t: number, gain: number) {
    if (!this.ctx || !this.musicGain || !this.noiseBuffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = 1 + Math.random() * 0.4;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 6500;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    src.connect(filter).connect(g).connect(this.musicGain);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 0.06);
  }

  private bassAt(t: number, freq: number, cutoff: number) {
    if (!this.ctx || !this.musicGain) return;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(cutoff, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(120, cutoff * 0.4), t + 0.2);
    filter.Q.value = 3;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.16, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    osc.connect(filter).connect(g).connect(this.musicGain);
    osc.start(t);
    osc.stop(t + 0.26);
  }

  private arpAt(t: number, freq: number, gain: number) {
    if (!this.ctx || !this.musicGain) return;
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    osc.connect(g).connect(this.musicGain);
    osc.start(t);
    osc.stop(t + 0.16);
  }

  private pingAt(
    t: number,
    freq: number,
    dur: number,
    gain: number,
    type: OscillatorType,
    dest: AudioNode | null
  ) {
    if (!this.ctx || !dest) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  // ---------------------------------------------------------------- helpers

  private ping(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', delay = 0, freqEnd = 0) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (freqEnd > 0) osc.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, gain: number, filterType: BiquadFilterType, freq: number, q = 1, delay = 0) {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  // ------------------------------------------------------------------- SFX

  shoot() {
    this.noise(0.1, 0.18, 'lowpass', 700);
    this.ping(260, 0.07, 0.12, 'triangle', 0, 130);
  }

  denied() {
    this.ping(140, 0.15, 0.2, 'square', 0, 90);
  }

  glassBreak(size = 1) {
    const pings = 3 + Math.round(size * 3);
    for (let i = 0; i < pings; i++) {
      const f = 1500 + Math.random() * 2800;
      this.ping(f, 0.08 + Math.random() * 0.18, 0.1 + Math.random() * 0.08, 'triangle', Math.random() * 0.07);
    }
    this.noise(0.22 + size * 0.12, 0.24 * size + 0.1, 'highpass', 2600, 0.7);
  }

  crack() {
    this.ping(2000 + Math.random() * 800, 0.06, 0.14, 'triangle');
    this.noise(0.08, 0.16, 'highpass', 3200);
  }

  bonus() {
    this.ping(880, 0.14, 0.16, 'sine');
    this.ping(1318, 0.2, 0.16, 'sine', 0.07);
  }

  dangerBreak() {
    this.ping(320, 0.35, 0.28, 'sawtooth', 0, 70);
    this.noise(0.4, 0.3, 'lowpass', 350);
    this.glassBreak(1.2);
  }

  collide() {
    this.ping(90, 0.3, 0.5, 'sine', 0, 45);
    this.noise(0.25, 0.35, 'lowpass', 260);
  }

  combo(tier: number) {
    const base = 660 + tier * 160;
    for (let i = 0; i <= tier + 1; i++) {
      this.ping(base * Math.pow(1.25, i), 0.12, 0.14, 'sine', i * 0.06);
    }
  }

  ammoGain() {
    this.ping(990, 0.09, 0.1, 'sine');
  }

  gameOver() {
    this.ping(440, 0.5, 0.2, 'sine', 0, 220);
    this.ping(330, 0.7, 0.18, 'sine', 0.25, 110);
    this.noise(0.6, 0.12, 'lowpass', 300, 1, 0.1);
  }

  uiTap() {
    this.ping(720, 0.05, 0.1, 'sine');
  }

  /** Metallic tick when a sphere ricochets off the corridor shell. */
  bounce(intensity = 1) {
    this.ping(420 + Math.random() * 160, 0.06, 0.08 * intensity, 'triangle', 0, 200);
    this.noise(0.05, 0.06 * intensity, 'highpass', 1800);
  }

  /** Air-rip when the player slips past a live hazard. */
  whoosh(intensity = 1) {
    this.noise(0.28, 0.14 * intensity, 'bandpass', 900 + intensity * 500, 1.4);
  }

  /** Rising sting for a speed milestone. */
  speedUp() {
    this.ping(520, 0.16, 0.14, 'sine', 0, 880);
    this.ping(780, 0.2, 0.12, 'sine', 0.08, 1240);
  }

  /** Golden fanfare on collecting a power-up. */
  powerup() {
    for (let i = 0; i < 4; i++) this.ping(660 * Math.pow(1.335, i), 0.16, 0.15, 'sine', i * 0.07);
    this.noise(0.3, 0.08, 'highpass', 2200);
  }

  /** Shield absorbing a collision: soft boom + shimmer instead of a thud. */
  shieldBlock() {
    this.ping(220, 0.35, 0.3, 'sine', 0, 110);
    for (let i = 0; i < 3; i++) this.ping(1800 + i * 500, 0.2, 0.08, 'triangle', 0.05 + i * 0.05);
  }

  /** Slow rift enter/exit: pitch dives in, rises back out. */
  riftEnter() {
    this.ping(880, 0.5, 0.2, 'sine', 0, 180);
    this.noise(0.5, 0.1, 'lowpass', 500);
  }

  riftExit() {
    this.ping(220, 0.35, 0.16, 'sine', 0, 880);
  }

  // --------------------------------------------------------------- ambient

  private startAmbient() {
    if (!this.ctx || !this.master) return;

    // Shared reverb: a synthesized decaying-noise impulse gives the whole bed a
    // sense of space so it sits like background music instead of dry tones.
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this.makeReverbImpulse(2.4, 2.8);
    this.reverbGain = this.ctx.createGain();
    this.reverbGain.gain.value = 0.5; // tasteful space, not a wash
    this.reverb.connect(this.reverbGain).connect(this.master);

    // Ambient bus at a real background level (was 0.05 — nearly inaudible),
    // still sitting under the kick/bass so the mix stays clean.
    this.ambientGain = this.ctx.createGain();
    this.ambientGain.gain.value = 0.17;
    this.ambientGain.connect(this.master);
    // a portion of the pad feeds the reverb for width/space
    const padVerbSend = this.ctx.createGain();
    padVerbSend.gain.value = 0.5;
    padVerbSend.connect(this.reverb);

    // Warm chord pad: a proper voicing (sub, root, fifth, octave, colour tone),
    // most voices detuned into pairs for width and slow movement. Ratios are
    // relative to the zone root so setMusicState can retune the whole chord.
    // [ratio, waveform, level, detune-cents]
    const voices: [number, OscillatorType, number, number][] = [
      [0.5, 'sine', 0.5, 0], // sub-octave body
      [1, 'sine', 0.42, -5], // root
      [1, 'triangle', 0.3, 6], // root (slightly detuned pair, warmer)
      [1.5, 'sine', 0.26, 4], // fifth
      [2, 'triangle', 0.2, -6], // octave
      [2, 'sine', 0.16, 7], // octave (detuned pair)
      [6 / 5 + 1, 'triangle', 0.12, 5], // colour tone (minor third, up an octave)
    ];
    // soft low-pass keeps the pad warm and un-harsh under the rhythm
    const padTone = this.ctx.createBiquadFilter();
    padTone.type = 'lowpass';
    padTone.frequency.value = 2200;
    padTone.Q.value = 0.3;
    padTone.connect(this.ambientGain);
    padTone.connect(padVerbSend);

    for (const [ratio, type, level, detune] of voices) {
      const osc = this.ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = ZONE_ROOTS[0] * ratio;
      osc.detune.value = detune;
      const g = this.ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(padTone);
      osc.start();
      this.padOscs.push(osc);
      this.padRatios.push(ratio);
    }

    // Slow pulse so the bed breathes instead of droning flat.
    this.lfo = this.ctx.createOscillator();
    this.lfo.frequency.value = 0.22;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 0.03;
    this.lfo.connect(lfoGain).connect(this.ambientGain.gain);
    this.lfo.start();

    // Airy shimmer bed — high, quiet noise wash for air, routed through space.
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900;
    filter.Q.value = 0.5;
    const g = this.ctx.createGain();
    g.gain.value = 0.04;
    src.connect(filter).connect(g);
    g.connect(this.ambientGain);
    g.connect(padVerbSend);
    src.start();
  }

  /** Synthesize a reverb impulse response: exponentially-decaying filtered
   *  noise. Cheap, dependency-free, gives the bed a plausible room/space. */
  private makeReverbImpulse(seconds: number, decay: number): AudioBuffer {
    const rate = this.ctx!.sampleRate;
    const len = Math.max(1, Math.floor(seconds * rate));
    const buf = this.ctx!.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        // stereo-decorrelated noise with an exponential tail
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  /** 0..1 — raises the bed's presence and breathing through later zones. */
  setIntensity(t: number) {
    if (!this.ctx || !this.ambientGain || !this.lfo) return;
    const now = this.ctx.currentTime;
    this.ambientGain.gain.linearRampToValueAtTime(0.17 + t * 0.06, now + 1.5);
    this.lfo.frequency.linearRampToValueAtTime(0.22 + t * 0.9, now + 1.5);
  }
}
