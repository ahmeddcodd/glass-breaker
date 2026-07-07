import type { Engine } from '@babylonjs/core/Engines/engine';

// Touch-first input: every pointerdown becomes a tap callback with
// coordinates in render-pixel space (for Babylon picking) plus
// stage-relative CSS pixels (for DOM feedback like the tap ripple).
export class InputManager {
  onTap: (renderX: number, renderY: number, cssX: number, cssY: number) => void = () => {};

  constructor(engine: Engine, canvas: HTMLCanvasElement) {
    canvas.addEventListener('pointerdown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      const x = (cssX / rect.width) * engine.getRenderWidth();
      const y = (cssY / rect.height) * engine.getRenderHeight();
      this.onTap(x, y, cssX, cssY);
    });
  }
}
