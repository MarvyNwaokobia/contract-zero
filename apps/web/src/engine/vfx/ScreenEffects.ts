export interface ScreenFlash {
  color: string;
  opacity: number;
  duration: number;
  timer: number;
}

export interface ChromaticAberrationState {
  intensity: number;
  timer: number;
  decay: number;
}

export interface MotionBlurState {
  intensity: number;
  angle: number;
  timer: number;
}

export interface ScreenEffectsState {
  flash: ScreenFlash | null;
  chromaticAberration: ChromaticAberrationState;
  motionBlur: MotionBlurState;
  vignetteIntensity: number;
  vignetteTarget: number;
  colorTint: { r: number; g: number; b: number; a: number };
  colorTintTarget: { r: number; g: number; b: number; a: number };
}

export class ScreenEffects {
  private vignetteResetTimer = 0;
  private killResetTimer = 0;

  state: ScreenEffectsState = {
    flash: null,
    chromaticAberration: { intensity: 0, timer: 0, decay: 8 },
    motionBlur: { intensity: 0, angle: 0, timer: 0 },
    vignetteIntensity: 0.3,
    vignetteTarget: 0.3,
    colorTint: { r: 0, g: 0, b: 0, a: 0 },
    colorTintTarget: { r: 0, g: 0, b: 0, a: 0 },
  };

  flash(color = '#ffffff', opacity = 0.7, duration = 0.08) {
    this.state.flash = { color, opacity, duration, timer: duration };
  }

  chromaticAberration(intensity: number, duration = 0.15) {
    this.state.chromaticAberration.intensity = intensity;
    this.state.chromaticAberration.timer = duration;
  }

  motionBlur(intensity: number, angle: number, duration = 0.2) {
    this.state.motionBlur.intensity = intensity;
    this.state.motionBlur.angle = angle;
    this.state.motionBlur.timer = duration;
  }

  vignette(intensity: number) {
    this.state.vignetteTarget = intensity;
  }

  tint(r: number, g: number, b: number, a: number) {
    this.state.colorTintTarget = { r, g, b, a };
  }

  clearTint() {
    this.state.colorTintTarget = { r: 0, g: 0, b: 0, a: 0 };
  }

  onLightHit() {
    this.flash('#ffffff', 0.3, 0.04);
    this.chromaticAberration(0.003, 0.1);
  }

  onHeavyHit() {
    this.flash('#ffffff', 0.6, 0.06);
    this.chromaticAberration(0.008, 0.15);
    this.motionBlur(0.5, 0, 0.12);
  }

  onSpecialHit() {
    this.flash('#ffffff', 0.8, 0.08);
    this.chromaticAberration(0.015, 0.2);
    this.motionBlur(0.8, 0, 0.18);
    this.vignette(0.6);
    this.vignetteResetTimer = 0.4;
  }

  onCriticalHit() {
    this.flash('#ffcc00', 0.9, 0.1);
    this.chromaticAberration(0.02, 0.25);
    this.motionBlur(1, 0, 0.2);
  }

  onKill(classColor: string) {
    this.flash(classColor, 0.5, 0.3);
    this.chromaticAberration(0.025, 0.5);
    this.vignette(0.7);
    this.tint(
      parseInt(classColor.slice(1, 3), 16) / 255,
      parseInt(classColor.slice(3, 5), 16) / 255,
      parseInt(classColor.slice(5, 7), 16) / 255,
      0.15
    );
    this.killResetTimer = 1.5;
  }

  onBlock() {
    this.flash('#4488ff', 0.25, 0.04);
    this.chromaticAberration(0.002, 0.08);
  }

  onLowHealth() {
    this.vignette(0.55);
    this.tint(0.3, 0, 0, 0.08);
  }

  onHealthRecovered() {
    this.vignette(0.3);
    this.clearTint();
  }

  update(dt: number) {
    if (this.vignetteResetTimer > 0) {
      this.vignetteResetTimer -= dt;
      if (this.vignetteResetTimer <= 0) this.vignette(0.3);
    }

    if (this.killResetTimer > 0) {
      this.killResetTimer -= dt;
      if (this.killResetTimer <= 0) {
        this.vignette(0.3);
        this.clearTint();
      }
    }

    if (this.state.flash) {
      this.state.flash.timer -= dt;
      if (this.state.flash.timer <= 0) {
        this.state.flash = null;
      }
    }

    const ca = this.state.chromaticAberration;
    if (ca.timer > 0) {
      ca.timer -= dt;
      if (ca.timer <= 0) {
        ca.intensity = 0;
      }
    } else {
      ca.intensity *= 1 - ca.decay * dt;
      if (ca.intensity < 0.0001) ca.intensity = 0;
    }

    const mb = this.state.motionBlur;
    if (mb.timer > 0) {
      mb.timer -= dt;
      if (mb.timer <= 0) {
        mb.intensity = 0;
      }
    }

    this.state.vignetteIntensity += (this.state.vignetteTarget - this.state.vignetteIntensity) * dt * 5;

    const t = this.state.colorTint;
    const tt = this.state.colorTintTarget;
    t.r += (tt.r - t.r) * dt * 4;
    t.g += (tt.g - t.g) * dt * 4;
    t.b += (tt.b - t.b) * dt * 4;
    t.a += (tt.a - t.a) * dt * 4;
  }
}
