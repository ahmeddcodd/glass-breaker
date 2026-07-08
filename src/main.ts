import './style.css';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Game } from './game';
import { initializeBridge } from './playables';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;

const engine = new Engine(canvas, true, {
  stencil: false,
  doNotHandleContextLost: true,
  powerPreference: 'high-performance',
  // Retain the last drawn frame when the render loop stops (platform pause
  // freezes rendering). Without this the canvas composites as black while
  // paused; the small per-frame copy cost is absorbed by adaptive quality.
  preserveDrawingBuffer: true,
});

// Cap the pixel ratio: crisp on phones without paying 3x-DPR fill cost (doc §39).
engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 2));

window.addEventListener('resize', () => engine.resize());

// Playgama Bridge must finish initializing before any SDK call (storage, mute
// state, ads). The Game constructor reads those on construction, so we await
// init first. The engine is already created, so the canvas is ready to paint
// the instant the render loop starts. On a bare page / mock the init resolves
// immediately and every SDK call degrades to a safe no-op.
void initializeBridge().then(() => {
  const game = new Game(engine, canvas);
  engine.runRenderLoop(() => game.tick());
});
