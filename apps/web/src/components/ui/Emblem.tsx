/** The CONTRACT ZERO mark: a broken zero cut by a downward chevron. Original artwork. */
export function Emblem({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <path d="M24 4a20 20 0 1 0 14.1 34.1" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="square" />
      <path d="M42 30.5A20 20 0 0 0 33 7" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="square" opacity="0.45" />
      <path d="M14 17l10 10 10-10" fill="none" stroke="var(--color-amber)" strokeWidth="3.6" strokeLinecap="square" />
      <path d="M14 25l10 10 10-10" fill="none" stroke="var(--color-amber)" strokeWidth="3.6" strokeLinecap="square" opacity="0.55" />
    </svg>
  )
}
