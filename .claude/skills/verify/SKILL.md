---
name: verify
description: Build, launch and drive Glass Breaker in headless Chrome to verify changes end-to-end (including Playgama Bridge SDK behavior).
---

# Verifying Glass Breaker

## Build + serve
```bash
npm run build        # tsc + vite build → dist/
npm run preview &    # serves the production build at http://localhost:4173
```
(`npm run dev` at :5173 works too, but verify the production bundle when the change
touches index.html, vite.config.ts, playables.ts, or playgama-bridge-config.json —
the config only ships via the build, so mock-storage/ad behavior is bundle-specific.)

## Drive it headless (no test framework needed)
Launch Chrome with CDP and drive it with a plain Node script (Node ≥21 has global
`fetch` + `WebSocket`, so no dependencies):

```bash
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new \
  --remote-debugging-port=9222 --window-size=450,800 --no-first-run \
  --user-data-dir=<scratch>/chrome-profile about:blank &
```

Connect: `GET http://127.0.0.1:9222/json` → page `webSocketDebuggerUrl` → send
`Page.enable`, `Runtime.enable`, `Page.navigate`, `Runtime.evaluate`,
`Page.captureScreenshot`, `Input.dispatchMouseEvent` (mousePressed+mouseReleased = tap;
the game listens for `pointerdown` on the canvas).

## Playgama Bridge SDK — no stubbing needed
- Off a real host (localhost, Vercel, headless), Bridge falls back to a built-in **mock**
  platform: `bridge.platform.id === 'mock'`, and every call returns a safe default (false /
  rejected promise) instead of throwing. So you do **not** stub anything — just load the page.
  (You can block the CDN with `Network.setBlockedURLs({ urls: ['*playgama-bridge*'] })` to force
  the "no SDK" path; the wrapper resolves init anyway and runs against no-ops.)
- Under mock, `requestRewardedAd` takes the simulated path (plays `#fake-ad`, then grants), so
  the Continue/revive flow is fully exercisable headless with no ad system.
- To prove pause freezes rendering, hide the DOM overlay first
  (`#ui.style.display='none'`) — CSS pulse animations otherwise make screenshots differ
  even when the canvas is frozen. Paused screenshots must be byte-identical. (Pause/mute come
  from `bridge` `PAUSE_STATE_CHANGED`/`AUDIO_STATE_CHANGED` events; the mock does not emit them,
  so live pause/mute checks belong in the Playgama QA tool, not headless.)

## Useful hooks + flows
- `?dist=750` starts the run 750 m in; `?qa` exposes `__qaPower('multishot'|'slowrift'|'shield')`;
  `__fps` / `__quality` report adaptive quality (after ~4 s warmup).
- Start screen tap = tap anywhere; DOM ids: `start-screen`, `hud`, `gameover-screen`
  (check `.classList.contains('visible')`), `score-value`, `ammo-value`, `final-score`, `stat-best`.
- Fastest game over: just don't shoot — collisions drain the 25 starting spheres in
  ~60-120 s of waiting (poll `gameover-screen` every few seconds).
- Persistence: the combined `{best, settings}` blob is saved via `bridge.storage` under the
  `glass-breaker-best` key. Under mock it round-trips through the browser's local storage, so a
  best set in one run survives a reload.
- Rewarded-ad revive: **no stub** — under mock, `requestRewardedAd` plays the `#fake-ad` break
  and grants the reward. Tap the Continue button by its measured `getBoundingClientRect()`
  center, not hardcoded coords (its Y shifts with screen layout). After the reward the run
  resumes via a `countdown` game state (3·2·1) — assert `#countdown` text, spheres back to 25,
  score kept, and that `#distance-value` keeps climbing to prove the run actually restarted.
  The Continue button is shown off-host too (it drives the simulated ad break).
