import './style.css';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Game } from './game';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;

const engine = new Engine(canvas, true, {
  stencil: false,
  doNotHandleContextLost: true,
  powerPreference: 'high-performance',
  // Retain the last drawn frame when the render loop stops (YouTube pause
  // freezes rendering). Without this the canvas composites as black while
  // paused; the small per-frame copy cost is absorbed by adaptive quality.
  preserveDrawingBuffer: true,
});

// Cap the pixel ratio: crisp on phones without paying 3x-DPR fill cost (doc §39).
engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 2));

const game = new Game(engine, canvas);
engine.runRenderLoop(() => game.tick());

window.addEventListener('resize', () => engine.resize());
