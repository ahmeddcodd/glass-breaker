// YouTube Playables SDK wrapper — the only module allowed to touch the
// `ytgame` global. Outside the Playables environment (local dev, Vercel
// preview) every call degrades gracefully: lifecycle signals become no-ops
// and the best score falls back to localStorage.
// SDK reference: https://developers.google.com/youtube/gaming/playables/reference/sdk

import { BEST_SCORE_KEY } from './config';

interface YtGame {
  IN_PLAYABLES_ENV: boolean;
  SDK_VERSION: string;
  game: {
    firstFrameReady(): void;
    gameReady(): void;
    loadData(): Promise<string>;
    saveData(data: string): Promise<void>;
  };
  engagement: {
    sendScore(score: { value: number }): Promise<void>;
  };
  ads: {
    requestRewardedAd(rewardId: string): Promise<boolean>;
    requestInterstitialAd(): Promise<void>;
  };
  system: {
    isAudioEnabled(): boolean;
    onAudioEnabledChange(callback: (enabled: boolean) => void): () => void;
    onPause(callback: () => void): () => void;
    onResume(callback: () => void): () => void;
  };
  health: {
    logError(): void;
    logWarning(): void;
  };
}

declare global {
  // eslint-disable-next-line no-var
  var ytgame: YtGame | undefined;
}

const sdk = typeof ytgame !== 'undefined' ? ytgame : undefined;

export const inPlayablesEnv = !!sdk?.IN_PLAYABLES_ENV;

// Outside the real Playables env (Vercel / local) there is no YouTube ad
// system, so the rewarded-ad Continue flow is simulated: a short placeholder
// "ad break" plays, then the reward is granted. Inside the real Playables env
// this is never used — genuine YouTube ads always run instead.
const simulateAds = !inPlayablesEnv;

/**
 * Presenter for the simulated ad break (set by the game to a UI method). It
 * shows the placeholder ad screen and resolves when it finishes. If left
 * unset, the simulation just waits briefly and grants the reward.
 */
let simulatedAdPresenter: (() => Promise<void>) | null = null;
export function setSimulatedAdPresenter(fn: () => Promise<void>) {
  simulatedAdPresenter = fn;
}

/** Player audio settings persisted alongside the best score. */
export interface AudioSettings {
  sfx: boolean;
  music: boolean;
  ambient: boolean;
}
export const DEFAULT_SETTINGS: AudioSettings = { sfx: true, music: true, ambient: true };
const SETTINGS_KEY = 'glass-breaker-settings';

// Best score and settings share ONE save blob ({best, settings}); we mirror
// both in memory so writing either persists the current pair without a
// read-modify-write race.
let loadDone = false;
let pendingSave = false;
let currentBest = 0;
let currentSettings: AudioSettings = { ...DEFAULT_SETTINGS };

function coerceSettings(v: unknown): AudioSettings {
  const s = (v ?? {}) as Partial<Record<keyof AudioSettings, unknown>>;
  return {
    sfx: typeof s.sfx === 'boolean' ? s.sfx : DEFAULT_SETTINGS.sfx,
    music: typeof s.music === 'boolean' ? s.music : DEFAULT_SETTINGS.music,
    ambient: typeof s.ambient === 'boolean' ? s.ambient : DEFAULT_SETTINGS.ambient,
  };
}

/** Write the combined {best, settings} blob (cloud in-env, localStorage else). */
function persist() {
  if (!loadDone) {
    pendingSave = true;
    return;
  }
  if (!inPlayablesEnv) {
    try {
      localStorage.setItem(BEST_SCORE_KEY, String(currentBest));
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(currentSettings));
    } catch {
      // storage may be unavailable in some embeds — just won't persist
    }
    return;
  }
  sdk!.game
    .saveData(JSON.stringify({ best: currentBest, settings: currentSettings }))
    .catch(() => sdk!.health.logError());
}

// Everything below is gated on IN_PLAYABLES_ENV, not just on the global
// existing: the real SDK script still loads on external hosting (Vercel),
// where it self-identifies as outside the env but can still fire callbacks
// (e.g. audioEnabled=false, which would silently hard-mute the game).

/** Signal that rendering has begun (first frame drawn). MUST be called. */
export function firstFrameReady() {
  if (inPlayablesEnv) sdk!.game.firstFrameReady();
}

/** Signal the game is interactive — YouTube hides its spinner on this. */
export function gameReady() {
  if (inPlayablesEnv) sdk!.game.gameReady();
}

/** Load the saved blob (best score + audio settings). Resolves both; read
 *  settings via loadedSettings(). */
export async function loadSaveData(): Promise<{ best: number; settings: AudioSettings }> {
  let best = 0;
  let settings: AudioSettings = { ...DEFAULT_SETTINGS };
  if (!inPlayablesEnv) {
    try {
      best = Number(localStorage.getItem(BEST_SCORE_KEY)) || 0;
      const rawS = localStorage.getItem(SETTINGS_KEY);
      if (rawS) settings = coerceSettings(JSON.parse(rawS));
    } catch {
      // storage unavailable — defaults
    }
  } else {
    try {
      const raw = await sdk!.game.loadData();
      if (raw) {
        const parsed = JSON.parse(raw) as { best?: unknown; settings?: unknown };
        if (typeof parsed.best === 'number' && Number.isFinite(parsed.best)) best = parsed.best;
        settings = coerceSettings(parsed.settings);
      }
    } catch {
      // corrupt or unavailable save — start fresh rather than break the game
      sdk!.health.logWarning();
    }
  }
  currentBest = best;
  currentSettings = settings;
  loadDone = true;
  // flush a save that raced ahead of the load (defensive; save order per cert)
  if (pendingSave) {
    pendingSave = false;
    persist();
  }
  return { best, settings };
}

/** Update the persisted best score (writes the combined blob). */
export function saveBestScore(best: number) {
  currentBest = Math.max(currentBest, best);
  persist();
}

/** Update the persisted audio settings (writes the combined blob). */
export function saveSettings(settings: AudioSettings) {
  currentSettings = { ...settings };
  persist();
}

/** True when rewarded ads can be offered — real ads in the Playables env, a
 *  simulated ad break everywhere else. */
export const adsAvailable = inPlayablesEnv || simulateAds;

/**
 * Show a rewarded ad and resolve to whether the reward was earned. Inside the
 * Playables env this runs a genuine YouTube ad; on Vercel/local it plays the
 * simulated ad-break placeholder and grants the reward. Resolves false only on
 * a real SDK failure — the caller should not revive on false.
 */
export async function requestRewardedAd(rewardId: string): Promise<boolean> {
  if (!inPlayablesEnv) {
    if (!simulateAds) return false;
    // no real ad system here — run the placeholder ad break, then reward
    if (simulatedAdPresenter) await simulatedAdPresenter();
    else await new Promise((r) => setTimeout(r, 900));
    return true;
  }
  try {
    return await sdk!.ads.requestRewardedAd(rewardId);
  } catch {
    sdk!.health.logError();
    return false;
  }
}

/** Report the finished run's score to YouTube leaderboards/history. */
export function sendScore(value: number) {
  if (!inPlayablesEnv) return;
  sdk!.engagement.sendScore({ value: Math.max(0, Math.floor(value)) }).catch(() => sdk!.health.logError());
}

/** YouTube's audio toggle. Defaults to enabled outside the env. */
export function isAudioEnabled(): boolean {
  return inPlayablesEnv ? sdk!.system.isAudioEnabled() : true;
}

export function onAudioEnabledChange(callback: (enabled: boolean) => void) {
  if (inPlayablesEnv) sdk!.system.onAudioEnabledChange(callback);
}

export function onPause(callback: () => void) {
  if (inPlayablesEnv) sdk!.system.onPause(callback);
}

export function onResume(callback: () => void) {
  if (inPlayablesEnv) sdk!.system.onResume(callback);
}
