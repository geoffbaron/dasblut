import { MAX_FRAME_DT, SIM_DT } from "./constants.ts";

// Fixed-timestep accumulator loop. The simulation always advances in equal SIM_DT
// slices (deterministic, pause-friendly, MP-ready); rendering interpolates between
// the last two sim states using `alpha`. Game speed multiplies how many sim slices
// run per real second; pausing simply runs zero.
export class GameLoop {
  paused = false;
  speed = 1;
  private accumulator = 0;
  private last = 0;
  private raf = 0;

  constructor(
    private readonly onStep: () => void,
    private readonly onRender: (alpha: number) => void,
  ) {}

  start(): void {
    this.last = performance.now();
    const frame = (now: number) => {
      let dt = (now - this.last) / 1000;
      this.last = now;
      if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;

      if (!this.paused) this.accumulator += dt * this.speed;
      while (this.accumulator >= SIM_DT) {
        this.onStep();
        this.accumulator -= SIM_DT;
      }
      const alpha = this.paused ? 1 : this.accumulator / SIM_DT;
      this.onRender(alpha);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }
}
