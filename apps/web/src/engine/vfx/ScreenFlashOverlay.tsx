'use client';

import { useEffect, useRef } from 'react';
import type { ScreenEffects } from './ScreenEffects';

interface ScreenFlashOverlayProps {
  screenEffects: ScreenEffects;
}

export function ScreenFlashOverlay({ screenEffects }: ScreenFlashOverlayProps) {
  const ref = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const update = () => {
      if (!ref.current) {
        rafRef.current = requestAnimationFrame(update);
        return;
      }
      const state = screenEffects.state;

      if (state.flash) {
        const progress = state.flash.timer / state.flash.duration;
        ref.current.style.backgroundColor = state.flash.color;
        ref.current.style.opacity = String(state.flash.opacity * Math.max(0, progress));
        ref.current.style.display = 'block';
      } else if (state.colorTint.a > 0.01) {
        const tint = state.colorTint;
        ref.current.style.display = 'block';
        ref.current.style.backgroundColor = `rgba(${Math.round(tint.r * 255)}, ${Math.round(tint.g * 255)}, ${Math.round(tint.b * 255)}, ${tint.a})`;
        ref.current.style.opacity = '1';
      } else {
        ref.current.style.display = 'none';
      }

      rafRef.current = requestAnimationFrame(update);
    };
    rafRef.current = requestAnimationFrame(update);
    return () => cancelAnimationFrame(rafRef.current);
  }, [screenEffects]);

  return (
    <div
      ref={ref}
      className="fixed inset-0 pointer-events-none z-40"
      style={{ display: 'none', mixBlendMode: 'screen' }}
    />
  );
}
