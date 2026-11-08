// Drives the crowd's collective mood. Combat code pushes reactions in; the
// Crowd renderer and crowd audio read `energy`/`mood` out each frame. Kept as a
// plain shared object (like ScreenEffects) so it can be passed across components.

export type CrowdMood = 'idle' | 'cheer' | 'boo';

export class CrowdDirector {
  // 0..1 collective excitement — decays toward a low idle hum.
  energy = 0.15;
  mood: CrowdMood = 'idle';

  // Spikes when the crowd should physically pop (jump/surge) this frame.
  // Renderer reads then it decays away.
  surge = 0;

  private moodHold = 0;

  /** A clean hit landed — crowd pops with approval. */
  cheer(intensity = 0.6) {
    this.energy = Math.min(1, this.energy + intensity);
    this.surge = Math.max(this.surge, intensity);
    this.mood = 'cheer';
    this.moodHold = 1.2;
  }

  /** A block, whiff, or the player eating damage — crowd jeers. */
  boo(intensity = 0.4) {
    this.energy = Math.min(1, this.energy + intensity * 0.6);
    this.surge = Math.max(this.surge, intensity * 0.7);
    this.mood = 'boo';
    this.moodHold = 1.0;
  }

  /** A knockout — the whole arena erupts. */
  roar() {
    this.energy = 1;
    this.surge = 1;
    this.mood = 'cheer';
    this.moodHold = 3;
  }

  update(dt: number) {
    // Energy settles back toward an ambient idle murmur.
    const idle = 0.15;
    const decay = this.mood === 'cheer' ? 0.6 : 0.9;
    this.energy += (idle - this.energy) * Math.min(1, decay * dt);

    this.surge = Math.max(0, this.surge - dt * 3);

    if (this.moodHold > 0) {
      this.moodHold -= dt;
      if (this.moodHold <= 0) this.mood = 'idle';
    }
  }
}
