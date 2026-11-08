'use client';

import { useEffect, useRef } from 'react';
import { Crosshair, Wind, ChevronUp, type LucideIcon } from 'lucide-react';
import { Action, getInputSystem } from './InputSystem';

const GOLD = '#eab308';

interface TouchButtonProps {
  action: Action;
  label: string;
  icon?: LucideIcon;
  className?: string;
}

function TouchButton({ action, label, icon: Icon, className = '' }: TouchButtonProps) {
  const input = getInputSystem();

  return (
    <button
      className={`select-none touch-none rounded-full font-bold text-white active:scale-90 active:brightness-150 transition-all flex flex-col items-center justify-center ${className}`}
      onTouchStart={(e) => {
        e.preventDefault();
        e.stopPropagation();
        input.triggerAction(action);
      }}
      onTouchEnd={(e) => {
        e.preventDefault();
        e.stopPropagation();
        input.releaseAction(action);
      }}
      onMouseDown={(e) => {
        e.preventDefault();
        input.triggerAction(action);
      }}
      onMouseUp={(e) => {
        e.preventDefault();
        input.releaseAction(action);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {Icon && <Icon size={20} strokeWidth={2.5} className="leading-none" />}
      <span className="text-[9px] uppercase tracking-wide leading-none mt-0.5">{label}</span>
    </button>
  );
}

export function TouchControls() {
  const stickRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  // The four directional arrows — lit in proportion to how far you're pushing that way,
  // so the pad reads as "go up / left / right / back" while staying fully analog.
  const arrowUp = useRef<HTMLDivElement>(null);
  const arrowDown = useRef<HTMLDivElement>(null);
  const arrowLeft = useRef<HTMLDivElement>(null);
  const arrowRight = useRef<HTMLDivElement>(null);
  const input = getInputSystem();
  const touchIdRef = useRef<number | null>(null);

  useEffect(() => {
    const stick = stickRef.current;
    if (!stick) return;

    const radius = 56;

    // Light an arrow from a dim resting glow up to full as the stick pushes its way.
    const paintArrow = (el: HTMLDivElement | null, amount: number) => {
      if (!el) return;
      const a = Math.max(0, Math.min(1, amount));
      el.style.opacity = String(0.28 + a * 0.72);
      el.style.filter = a > 0.05 ? `drop-shadow(0 0 ${4 + a * 8}px ${GOLD})` : 'none';
    };

    const handleMove = (clientX: number, clientY: number) => {
      const rect = stick.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      let dx = clientX - cx;
      let dy = -(clientY - cy);
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > radius) {
        dx = (dx / dist) * radius;
        dy = (dy / dist) * radius;
      }
      const nx = dx / radius;
      const ny = dy / radius;
      input.setStick(nx, ny);
      if (knobRef.current) {
        knobRef.current.style.transform = `translate(${dx}px, ${-dy}px)`;
      }
      paintArrow(arrowUp.current, ny);
      paintArrow(arrowDown.current, -ny);
      paintArrow(arrowRight.current, nx);
      paintArrow(arrowLeft.current, -nx);
    };

    const reset = () => {
      input.setStick(0, 0);
      touchIdRef.current = null;
      if (knobRef.current) knobRef.current.style.transform = 'translate(0,0)';
      paintArrow(arrowUp.current, 0);
      paintArrow(arrowDown.current, 0);
      paintArrow(arrowLeft.current, 0);
      paintArrow(arrowRight.current, 0);
    };

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      touchIdRef.current = t.identifier;
      handleMove(t.clientX, t.clientY);
    };

    const onTouchMove = (e: TouchEvent) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === touchIdRef.current) {
          handleMove(e.changedTouches[i].clientX, e.changedTouches[i].clientY);
          break;
        }
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === touchIdRef.current) {
          reset();
          break;
        }
      }
    };

    stick.addEventListener('touchstart', onTouchStart, { passive: false });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      stick.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [input]);

  return (
    <div className="fixed inset-0 pointer-events-none z-50 md:hidden">
      {/* Movement pad — bottom left. Four directional arrows around an analog hub:
          reads as "go this way", but drag distance still sets speed + diagonals. */}
      <div
        ref={stickRef}
        className="pointer-events-auto absolute bottom-20 left-6 w-32 h-32 rounded-full flex items-center justify-center touch-none select-none"
        style={{
          background: 'radial-gradient(circle at 50% 45%, rgba(234,179,8,0.06), rgba(8,8,14,0.55))',
          border: '1px solid rgba(234,179,8,0.22)',
          boxShadow: 'inset 0 0 24px rgba(0,0,0,0.5), 0 4px 20px rgba(0,0,0,0.5)',
          backdropFilter: 'blur(2px)',
        }}
      >
        {/* Directional arrows (chevrons), lit toward the drag */}
        <div ref={arrowUp}    className="absolute top-1.5 left-1/2 -translate-x-1/2"                style={{ color: GOLD, opacity: 0.28 }}><ChevronUp size={20} strokeWidth={3} /></div>
        <div ref={arrowDown}  className="absolute bottom-1.5 left-1/2 -translate-x-1/2 rotate-180" style={{ color: GOLD, opacity: 0.28 }}><ChevronUp size={20} strokeWidth={3} /></div>
        <div ref={arrowLeft}  className="absolute left-1.5 top-1/2 -translate-y-1/2 -rotate-90"    style={{ color: GOLD, opacity: 0.28 }}><ChevronUp size={20} strokeWidth={3} /></div>
        <div ref={arrowRight} className="absolute right-1.5 top-1/2 -translate-y-1/2 rotate-90"    style={{ color: GOLD, opacity: 0.28 }}><ChevronUp size={20} strokeWidth={3} /></div>

        {/* Analog knob */}
        <div
          ref={knobRef}
          className="w-11 h-11 rounded-full transition-none"
          style={{
            background: 'radial-gradient(circle at 40% 35%, rgba(234,179,8,0.9), rgba(180,120,8,0.7))',
            border: '1px solid rgba(255,255,255,0.35)',
            boxShadow: '0 0 12px rgba(234,179,8,0.5), inset 0 1px 2px rgba(255,255,255,0.4)',
          }}
        />
      </div>

      {/* Shooter controls — bottom right: hold FIRE (auto-fires on the gun's
          cadence) + DODGE for i-frames. */}
      <div className="pointer-events-auto absolute bottom-16 right-6 flex items-end gap-3">
        <TouchButton
          action={Action.Dodge}
          icon={Wind}
          label="Dodge"
          className="w-16 h-16 bg-green-600/80 border border-green-400/40 mb-1"
        />
        <TouchButton
          action={Action.Fire}
          icon={Crosshair}
          label="Fire"
          className="w-24 h-24 bg-red-600/85 border-2 border-red-400/50"
        />
      </div>
    </div>
  );
}
