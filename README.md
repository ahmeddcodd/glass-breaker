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

## YouTube Playables

The game integrates the [YouTube Playables SDK](https://developers.google.com/youtube/gaming/playables)
(`src/playables.ts` wraps every `ytgame` call):

- `firstFrameReady()` fires after the first rendered frame, `gameReady()` once shaders are
  prewarmed and the start screen is interactive.
- Best score persists via `saveData`/`loadData` cloud saves in the Playables environment,
  falling back to `localStorage` everywhere else.
- Run scores are reported with `sendScore` at game over.
- **Continue (rewarded-ad revive):** on death, a Continue button offers a rewarded ad
  (`ads.requestRewardedAd`); on reward the player revives in place — spheres refilled,
  score/distance kept, the killing hazard cleared — after a 3·2·1 resume countdown.
  Unlimited per run. Inside the Playables env a genuine YouTube ad plays; on Vercel/local
  (no ad system) a short placeholder "ad break" plays instead, then grants the revive.
- YouTube's mute toggle hard-mutes the WebAudio master bus; `onPause`/`onResume` freeze the
  entire game (updates, rendering and audio).

Outside the Playables environment the SDK is absent and every call is a safe no-op, so local
dev and Vercel previews behave exactly as before.

**Ship it:** `npm run build`, then zip the *contents* of `dist/` (so `index.html` sits at the
zip root) and upload it through the YouTube Playables partner flow. Validate first with the
[Playables test suite](https://developers.google.com/youtube/gaming/playables/reference/test_suite_guide).

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
