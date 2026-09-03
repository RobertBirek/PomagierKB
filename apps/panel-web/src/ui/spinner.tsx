import { cn } from './cn';

export interface SpinnerProps {
  /** Rozmiar w px (dopasowany do ikon lucide). */
  size?: 14 | 16 | 20;
  className?: string;
}

/** Kręcące się kółko (SVG, kolor dziedziczony z text-current). */
export function Spinner({ size = 16, className }: SpinnerProps) {
  return (
    <svg
      className={cn('animate-spin text-current', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      {/* Obwód r=10 ≈ 62.8 — dasharray zostawia przerwę tworzącą "ogon". */}
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray="46 17"
      />
    </svg>
  );
}
