# Glass Breaker

A fast, portrait-first 3D glass-smashing arcade runner built with [Babylon.js](https://www.babylonjs.com/) —
inspired by the satisfying arcade feel of Smash Hit, with an original identity: neon prism zones,
combo scoring, danger crystals, power-ups and a procedural adaptive soundtrack (zero audio files).

**Break the path. Save your spheres. Survive the rush.**

## Play locally

```bash
npm install
npm run dev
```

Open the printed URL — best experienced in a portrait viewport (use device emulation in DevTools on desktop).

## Build

```bash
npm run build    # type-checks + bundles to dist/
npm run preview  # serve the production build locally
```

## Playgama Bridge (cross-platform publishing)

The game integrates the [Playgama Bridge SDK](https://wiki.playgama.com/playgama/bridge-sdk) —
one integration that publishes to many HTML5 portals (Playgama, Poki, CrazyGames, Yandex,
YouTube, …). `src/playables.ts` wraps every `bridge` call:

- The Bridge script loads in `index.html` before the game bundle; `main.ts` `await`s
  `bridge.initialize()` before constructing the game (all SDK calls require init first).
- `gameReady()` sends `platform.sendMessage('game_ready')` once shaders are prewarmed and the
  start screen is interactive, so the host hides its loading screen. (Bridge has no separate
  first-frame signal, so `firstFrameReady()` is a no-op kept for API parity.)
- Best score **and** the audio settings persist as one `{best, settings}` blob via
  `bridge.storage` (platform cloud where available, `local_storage` otherwise).
- Run scores are reported with `bridge.leaderboards.setScore('glass-breaker', …)` at game over
  (a safe no-op on platforms without leaderboards).
- **Ending a run:** spheres double as health — a run ends either by crashing into a hazard or by
  spending your last sphere. Both show the score screen and offer the Continue revive below.
- **Continue (rewarded-ad revive):** on death, a Continue button offers a rewarded ad
  (`bridge.advertisement.showRewarded()`); the revive is granted **only** on the `rewarded`
  state (never on `closed`/`failed`). On reward the player revives in place — spheres refilled,
  score/distance kept, the killing hazard cleared — after a 3·2·1 resume countdown. Unlimited
  per run. On a real host a genuine ad plays; off-host (Vercel/local/mock) a short placeholder
  "ad break" plays instead, then grants the revive.
- The platform's mute toggle (`AUDIO_STATE_CHANGED`) hard-mutes the WebAudio master bus;
  `PAUSE_STATE_CHANGED` freezes the entire game (updates, rendering and audio).
- **In-game settings** (gear button, bottom-left): independent SFX / Music / Ambient toggles,
  saved in the same storage blob as the best score. They sit *below* the master bus, so the
  platform mute always overrides them and the two never conflict — the panel shows
  "Muted by platform" when the host has muted.

Outside a real host, Bridge falls back to a built-in **mock** platform whose calls return safe
defaults (never throw), so local dev and Vercel previews behave exactly as before — no stubbing.

**Config:** `public/playgama-bridge-config.json` declares the ad units and the `glass-breaker`
leaderboard; Vite copies it to the `dist/` root. Refine it in the
[Bridge config editor](https://playgama.github.io/bridge-config-editor/) (add per-platform
placement/leaderboard ids) before submission.

**Ship it:** `npm run build`, then zip the *contents* of `dist/` (so `index.html` and
`playgama-bridge-config.json` sit at the zip root) and submit through the Playgama flow.

## Deploy to Vercel

The repo is pre-configured via `vercel.json` (Vite preset, `dist/` output, immutable caching
for hashed assets). Two ways to ship it:

**Option A — Vercel CLI**

```bash
npm i -g vercel
vercel        # first run: link/create the project, deploys a preview
vercel --prod # production deploy
```

**Option B — Git import**

1. Push this folder to a GitHub/GitLab/Bitbucket repo.
2. In the [Vercel dashboard](https://vercel.com/new), import the repo.
3. Vercel auto-detects Vite — no settings needed. Every push deploys.

## Handy dev/QA URLs

- `/?dist=750` — start the run 750 m in (jump straight to a later zone).
- `/?qa` — exposes `__qaPower('multishot' | 'slowrift' | 'shield')` in the console to trigger power-ups.
- Console: `__fps` and `__quality` report the adaptive-quality state while playing.

## Tech notes

- TypeScript + Vite + `@babylonjs/core` (tree-shaken); no physics engine — custom collision.
- All art is procedural geometry + canvas-painted textures; all audio is synthesized WebAudio.
- Adaptive quality steps render resolution/glow to hold frame rate on weaker devices.
