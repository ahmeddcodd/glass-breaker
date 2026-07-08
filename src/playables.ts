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

/** Certification: loadData must resolve before the first saveData call. */
let loadDone = false;
let pendingBest: number | null = null;

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

/** Best score from cloud save (in-env) or localStorage (everywhere else). */
export async function loadBestScore(): Promise<number> {
  let best = 0;
  if (!inPlayablesEnv) {
    try {
      best = Number(localStorage.getItem(BEST_SCORE_KEY)) || 0;
    } catch {
      best = 0;
    }
  } else {
    try {
      const raw = await sdk!.game.loadData();
      if (raw) {
        const saved = (JSON.parse(raw) as { best?: unknown }).best;
        if (typeof saved === 'number' && Number.isFinite(saved)) best = saved;
      }
    } catch {
      // corrupt or unavailable save — start fresh rather than break the game
      sdk!.health.logWarning();
    }
  }
  loadDone = true;
  // flush a save that raced ahead of the load (defensive; save order per cert)
  if (pendingBest !== null) {
    const queued = pendingBest;
    pendingBest = null;
    saveBestScore(Math.max(queued, best));
  }
  return best;
}

/** Persist the best score. Queued until loadBestScore has resolved. */
export function saveBestScore(best: number) {
  if (!loadDone) {
    pendingBest = best;
    return;
  }
  if (!inPlayablesEnv) {
    try {
      localStorage.setItem(BEST_SCORE_KEY, String(best));
    } catch {
      // localStorage may be unavailable in some embeds — best just won't persist
    }
    return;
  }
  sdk!.game.saveData(JSON.stringify({ best })).catch(() => sdk!.health.logError());
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
