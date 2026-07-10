// Playgama Bridge SDK wrapper — the only module allowed to touch the `bridge`
// global. Bridge is a unified cross-platform HTML5 publishing SDK (Poki,
// CrazyGames, Yandex, Playgama, YouTube, …). Outside a real host (local dev,
// Vercel preview, headless tests) Bridge falls back to a built-in "mock"
// platform whose calls return safe defaults (false / rejected promises) and
// never throw — so every call here degrades gracefully with no stubbing.
// SDK reference: https://wiki.playgama.com/playgama/bridge-sdk
//
// NOTE: the file keeps its historical name (`playables.ts`) and its exported
// API surface (incl. `inPlayablesEnv`) so the rest of the game is unchanged;
// only the internals now speak Bridge instead of the old YouTube `ytgame` SDK.

import { BEST_SCORE_KEY } from './config';

// Minimal typing of the Bridge surface we use (plain-JS build, Promise-based).
type RewardedState = 'loading' | 'opened' | 'closed' | 'rewarded' | 'failed';

/** Bridge's LEADERBOARD_TYPE constants (verified against the shipped SDK). */
export type LeaderboardType = 'not_available' | 'in_game' | 'native' | 'native_popup';

/** One normalized leaderboard row, whatever shape the platform hands back. */
export interface LeaderboardEntry {
  rank: number;
  name: string;
  score: number;
  /** True for the signed-in player's own row, when the platform marks it. */
  isPlayer: boolean;
}

interface BridgeSdk {
  initialize(): Promise<void>;
  platform: {
    id: string;
    isAudioEnabled: boolean;
    sendMessage(message: string): void;
    on(event: string, callback: (state: unknown) => void): void;
  };
  storage: {
    defaultType: string;
    // Resolves a JSON string on most hosts, but the local mock resolves an
    // already-parsed value — hence `unknown`; loadSaveData handles both.
    get(key: string): Promise<unknown>;
    set(key: string, value: string): Promise<void>;
  };
  advertisement: {
    showRewarded(placement?: string): void;
    on(event: string, callback: (state: RewardedState) => void): void;
  };
  leaderboards: {
    type: LeaderboardType;
    setScore(leaderboardId: string, score: number): Promise<void>;
    /** 'in_game' platforms: fetch rows so the game can render them itself. */
    getEntries(leaderboardId: string): Promise<unknown>;
    /** 'native_popup' platforms: the host draws its own leaderboard overlay. */
    showNativePopup(leaderboardId: string): Promise<void>;
  };
  EVENT_NAME: {
    PAUSE_STATE_CHANGED: string;
    AUDIO_STATE_CHANGED: string;
    REWARDED_STATE_CHANGED: string;
    [k: string]: string;
  };
}

declare global {
  // eslint-disable-next-line no-var
  var bridge: BridgeSdk | undefined;
}

const sdk = typeof bridge !== 'undefined' ? bridge : undefined;

// Leaderboard id — must match `playgama-bridge-config.json`.
const LEADERBOARD_ID = 'glass-breaker';
// Rewarded ad safety net: if no terminal state arrives, resolve `false`.
const REWARDED_TIMEOUT_MS = 30000;

// `ready` gates every SDK call: Bridge throws if used before initialize()
// (reading even bridge.platform.id early logs "you must initialize it first").
let ready = false;

/**
 * On a real Playgama host (not the local/mock fallback). Kept under the
 * historical name `inPlayablesEnv` so game.ts is unchanged: it still means
 * "a genuine host with real ads / cloud storage" vs. dev/preview.
 *
 * A mutable live binding, not a load-time const: `platform.id` may only be read
 * after `initializeBridge()`, so it is resolved there. `game.ts` reads this via
 * the namespace import (`playables.inPlayablesEnv`) at game-over — well after
 * init — so it always sees the resolved value.
 */
export let inPlayablesEnv = false;

// Off a real host there is no ad system, so the rewarded-ad Continue flow is
// simulated: a short placeholder "ad break" plays, then the reward is granted.
// Resolved alongside inPlayablesEnv in initializeBridge().
let simulateAds = true;

// True when rewarded ads can be offered — real ads on a host, a simulated ad
// break everywhere else. Resolved in initializeBridge() (default true so the
// Continue button is available even before init / under the mock fallback).
export let adsAvailable = true;

/**
 * Presenter for the simulated ad break (set by the game to a UI method). Shows
 * the placeholder ad screen and resolves when it finishes. If unset, the
 * simulation just waits briefly and grants the reward.
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

// Best score and settings share ONE Bridge storage key ({best, settings}); we
// mirror both in memory so writing either persists the current pair without a
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

/**
 * Initialize the Bridge SDK. MUST resolve before any other Bridge call.
 * Guarded so a bare page without the SDK script (or a rejected init) still
 * resolves — the game then runs against safe no-ops.
 */
export async function initializeBridge(): Promise<void> {
  if (!sdk) return; // no script present (e.g. isolated unit test) — no-op
  try {
    await sdk.initialize();
    ready = true;
    // Safe to read platform.id only now that init has completed.
    inPlayablesEnv = !!sdk.platform?.id && sdk.platform.id !== 'mock';
    simulateAds = !inPlayablesEnv;
    adsAvailable = inPlayablesEnv || simulateAds; // effectively always true
  } catch {
    // init failed — leave `ready` false; every wrapper below is a safe no-op.
    // inPlayablesEnv stays false, so the simulated ad path applies.
  }
}

/** Write the combined {best, settings} blob to Bridge storage (default type).
 *  Off a real host / under mock this either writes local_storage or resolves
 *  as a no-op; either way it never throws. */
function persist() {
  if (!loadDone) {
    pendingSave = true;
    return;
  }
  if (!ready || !sdk) return;
  try {
    void sdk.storage
      .set(BEST_SCORE_KEY, JSON.stringify({ best: currentBest, settings: currentSettings }))
      .catch(() => {});
  } catch {
    // storage unavailable — just won't persist
  }
}

/** Signal that rendering has begun. Playgama has no separate first-frame
 *  signal (it's folded into game_ready), so this is a no-op — kept for API
 *  parity with the caller's one-shot firstFrame guard. */
export function firstFrameReady() {
  /* no-op under Bridge */
}

/** Signal the game is interactive — the host hides its loading screen on this. */
export function gameReady() {
  if (!ready || !sdk) return;
  try {
    sdk.platform.sendMessage('game_ready');
  } catch {
    /* safe no-op */
  }
}

/** Load the saved blob (best score + audio settings). Resolves both. */
export async function loadSaveData(): Promise<{ best: number; settings: AudioSettings }> {
  let best = 0;
  let settings: AudioSettings = { ...DEFAULT_SETTINGS };
  if (ready && sdk) {
    try {
      const raw = await sdk.storage.get(BEST_SCORE_KEY);
      // Bridge storage may hand back a JSON string (per the docs / most hosts)
      // OR an already-parsed object (the local mock does this). Accept both.
      let parsed: { best?: unknown; settings?: unknown } | null = null;
      if (typeof raw === 'string' && raw) parsed = JSON.parse(raw);
      else if (raw && typeof raw === 'object') parsed = raw as { best?: unknown; settings?: unknown };
      if (parsed) {
        if (typeof parsed.best === 'number' && Number.isFinite(parsed.best)) best = parsed.best;
        settings = coerceSettings(parsed.settings);
      }
    } catch {
      // missing / corrupt / unavailable save — start fresh rather than break
    }
  }
  currentBest = best;
  currentSettings = settings;
  loadDone = true;
  // flush a save that raced ahead of the load
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

/**
 * Show a rewarded ad and resolve to whether the reward was earned. On a real
 * host this runs a genuine ad and resolves via the REWARDED_STATE_CHANGED
 * event (true only on 'rewarded'); off-host it plays the simulated ad-break
 * placeholder and grants the reward. Resolves false on failure/decline — the
 * caller must not revive on false.
 */
export async function requestRewardedAd(_rewardId: string): Promise<boolean> {
  void _rewardId; // Bridge uses a config placement, not a per-call reward id
  if (!inPlayablesEnv || !ready || !sdk) {
    if (!simulateAds) return false;
    // no real ad system here — run the placeholder ad break, then reward
    if (simulatedAdPresenter) await simulatedAdPresenter();
    else await new Promise((r) => setTimeout(r, 900));
    return true;
  }

  // Wrap Bridge's event-based rewarded flow in the Promise the caller expects.
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (rewarded: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(rewarded);
    };
    // Safety net: some placements never fire a terminal state (no fill, etc.).
    const timer = setTimeout(() => finish(false), REWARDED_TIMEOUT_MS);

    try {
      sdk.advertisement.on(sdk.EVENT_NAME.REWARDED_STATE_CHANGED, (state: RewardedState) => {
        // Grant ONLY on 'rewarded'. 'closed' without a reward = declined/skipped.
        if (state === 'rewarded') finish(true);
        else if (state === 'closed' || state === 'failed') finish(false);
      });
      sdk.advertisement.showRewarded();
    } catch {
      finish(false);
    }
  });
}

/** Report the finished run's score to the platform leaderboard (if supported). */
export function sendScore(value: number) {
  if (!ready || !sdk) return;
  try {
    if (sdk.leaderboards.type === 'not_available') return;
    void sdk.leaderboards.setScore(LEADERBOARD_ID, Math.max(0, Math.floor(value))).catch(() => {});
  } catch {
    /* leaderboards unsupported — safe no-op */
  }
}

// ------------------------------------------------------------- leaderboard

/**
 * How this platform surfaces its leaderboard:
 *  - 'native_popup' → call showLeaderboard(); the host draws its own overlay
 *  - 'in_game'      → call fetchLeaderboard(); we render the rows ourselves
 *  - 'native'       → the host shows it in its own chrome; no in-game entry point
 *  - 'not_available'→ nothing to show
 */
export function leaderboardType(): LeaderboardType {
  if (!ready || !sdk) return 'not_available';
  try {
    return sdk.leaderboards.type ?? 'not_available';
  } catch {
    return 'not_available';
  }
}

/**
 * True when the game should offer a "Leaderboard" button. Any type other than
 * 'not_available' gets one: platform QA expects a leaderboard button in-game,
 * and `openLeaderboard()` handles every type (native popup, or our own panel
 * fed by getEntries) — so the button is never a dead end.
 */
export function leaderboardAvailable(): boolean {
  return leaderboardType() !== 'not_available';
}

/** Ask the host to display its own leaderboard overlay ('native_popup'). */
export async function showLeaderboard(): Promise<boolean> {
  if (!ready || !sdk) return false;
  try {
    await sdk.leaderboards.showNativePopup(LEADERBOARD_ID);
    return true;
  } catch {
    return false; // declined / unsupported — caller keeps its own UI closed
  }
}

/**
 * Coerce one platform row into our shape. Bridge does not normalize this — each
 * platform returns its own field names — so accept the common spellings and
 * fall back rather than throw on an unexpected payload.
 */
function coerceEntry(raw: unknown, index: number): LeaderboardEntry {
  const e = (raw ?? {}) as Record<string, unknown>;
  const num = (...keys: string[]): number | null => {
    for (const k of keys) {
      const v = e[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    }
    return null;
  };
  const str = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = e[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  };
  return {
    rank: num('rank', 'position', 'place') ?? index + 1,
    name: str('name', 'playerName', 'userName', 'nickname', 'title') ?? 'Player',
    score: num('score', 'value', 'points') ?? 0,
    isPlayer: e.isPlayer === true || e.isCurrentPlayer === true || e.self === true,
  };
}

/**
 * Fetch leaderboard rows for 'in_game' platforms. Resolves `null` when the
 * platform can't provide them (unsupported, offline, rejected) so the caller
 * can show an honest "unavailable" state rather than an empty board.
 */
export async function fetchLeaderboard(): Promise<LeaderboardEntry[] | null> {
  if (!ready || !sdk) return null;
  try {
    const raw = await sdk.leaderboards.getEntries(LEADERBOARD_ID);
    // Platforms return either an array, or an object wrapping one.
    let rows: unknown[] | null = null;
    if (Array.isArray(raw)) rows = raw;
    else if (raw && typeof raw === 'object') {
      for (const key of ['entries', 'players', 'items', 'leaderboard']) {
        const v = (raw as Record<string, unknown>)[key];
        if (Array.isArray(v)) {
          rows = v;
          break;
        }
      }
    }
    if (!rows) return null;
    return rows.map(coerceEntry).sort((a, b) => a.rank - b.rank);
  } catch {
    return null;
  }
}

/** The platform's audio toggle. Defaults to enabled off-host / before init. */
export function isAudioEnabled(): boolean {
  return sdk?.platform?.isAudioEnabled ?? true;
}

export function onAudioEnabledChange(callback: (enabled: boolean) => void) {
  if (!ready || !sdk) return;
  try {
    sdk.platform.on(sdk.EVENT_NAME.AUDIO_STATE_CHANGED, (enabled) => callback(!!enabled));
  } catch {
    /* safe no-op */
  }
}

// Playgama exposes a single PAUSE_STATE_CHANGED event carrying a boolean.
// The game wires pause/resume as two callbacks, so we subscribe once and fan
// the boolean out to whichever handler(s) have been registered.
let pauseCb: (() => void) | null = null;
let resumeCb: (() => void) | null = null;
let pauseSubscribed = false;

function ensurePauseSubscription() {
  if (pauseSubscribed || !ready || !sdk) return;
  pauseSubscribed = true;
  try {
    sdk.platform.on(sdk.EVENT_NAME.PAUSE_STATE_CHANGED, (isPaused) => {
      if (isPaused) pauseCb?.();
      else resumeCb?.();
    });
  } catch {
    /* safe no-op */
  }
}

export function onPause(callback: () => void) {
  pauseCb = callback;
  ensurePauseSubscription();
}

export function onResume(callback: () => void) {
  resumeCb = callback;
  ensurePauseSubscription();
}
