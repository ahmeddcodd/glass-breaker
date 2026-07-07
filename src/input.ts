// Touch-first input: every pointerdown becomes a tap callback with
// stage-relative CSS pixels. These feed both Babylon's createPickingRay
// (which expects client/CSS pixels and applies hardware scaling itself —
// passing render pixels double-counts DPR and breaks aim on mobile) and
// DOM feedback like the tap ripple.
export class InputManager {
  onTap: (cssX: number, cssY: number) => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    canvas.addEventListener('pointerdown', (e) => {
      const rect = canvas.getBoundingClientRect();
      this.onTap(e.clientX - rect.left, e.clientY - rect.top);
    });
  }
}
