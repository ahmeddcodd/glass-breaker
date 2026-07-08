---
name: verify
description: Build, launch and drive Glass Breaker in headless Chrome to verify changes end-to-end (including YouTube Playables SDK behavior).
---

# Verifying Glass Breaker

## Build + serve
```bash
npm run build        # tsc + vite build → dist/
npm run preview &    # serves the production build at http://localhost:4173
```
(`npm run dev` at :5173 works too, but verify the production bundle when the change
touches index.html, vite.config.ts, or playables.ts.)

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

## Playables SDK stubbing — two gotchas
- Inject a `window.ytgame` stub via `Page.addScriptToEvaluateOnNewDocument`, but define
  it with `Object.defineProperty(window, 'ytgame', { value: stub, writable: false })`
  AND block the real SDK with `Network.setBlockedURLs({ urls: ['*game_api*'] })` —
  otherwise the real script from youtube.com throws trying to overwrite the stub.
- To prove pause freezes rendering, hide the DOM overlay first
  (`#ui.style.display='none'`) — CSS pulse animations otherwise make screenshots differ
  even when the canvas is frozen. Paused screenshots must be byte-identical.

## Useful hooks + flows
- `?dist=750` starts the run 750 m in; `?qa` exposes `__qaPower('multishot'|'slowrift'|'shield')`;
  `__fps` / `__quality` report adaptive quality (after ~4 s warmup).
- Start screen tap = tap anywhere; DOM ids: `start-screen`, `hud`, `gameover-screen`
  (check `.classList.contains('visible')`), `score-value`, `ammo-value`, `final-score`, `stat-best`.
- Fastest game over: just don't shoot — collisions drain the 25 starting spheres in
  ~60-120 s of waiting (poll `gameover-screen` every few seconds).
- Non-Playables fallback: best score lives in `localStorage['glass-breaker-best']`.
- Rewarded-ad revive: stub `ytgame.ads.requestRewardedAd` to resolve true/false. Tap the
  Continue button by its measured `getBoundingClientRect()` center, not hardcoded coords
  (its Y shifts with screen layout). After a true reward the run resumes via a `countdown`
  game state (3·2·1) — assert `#countdown` text, spheres back to 25, score kept, and that
  `#distance-value` keeps climbing to prove the run actually restarted. The button is
  hidden when `IN_PLAYABLES_ENV` is false (Vercel/local).
