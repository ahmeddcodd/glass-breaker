import './style.css';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Game } from './game';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;

const engine = new Engine(canvas, true, {
  stencil: false,
  doNotHandleContextLost: true,
  powerPreference: 'high-performance',
});

// Cap the pixel ratio: crisp on phones without paying 3x-DPR fill cost (doc §39).
engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 2));

const game = new Game(engine, canvas);
engine.runRenderLoop(() => game.tick());

window.addEventListener('resize', () => engine.resize());
