import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn';
import { Spinner } from './spinner';

/** Wspólne klasy wariantów kolorystycznych (Button + IconButton). */
const variantClasses = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-active',
  secondary: 'bg-surface text-text border border-border-strong shadow-xs hover:bg-surface-2 active:bg-surface-3',
  ghost: 'text-text hover:bg-surface-2 active:bg-surface-3',
  outline: 'border border-border-strong text-text hover:bg-surface-2 active:bg-surface-3',
  danger: 'bg-fail text-white hover:opacity-90 active:opacity-80',
} as const;

export const buttonVariants = cva(
  'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: variantClasses,
      size: {
        sm: 'h-7 px-2.5',
        md: 'h-8 px-3',
        lg: 'h-9 px-4',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps extends ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  /** Spinner zamiast iconLeft + aria-busy + disabled. */
  loading?: boolean;
  /** Ikona lucide 16px po lewej. */
  iconLeft?: ReactNode;
  /** Ikona lucide 16px po prawej. */
  iconRight?: ReactNode;
}

export function Button({
  variant,
  size,
  loading = false,
  iconLeft,
  iconRight,
  disabled,
  className,
  type,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled === true || loading}
      {...(loading ? { 'aria-busy': true } : {})}
      {...rest}
    >
      {loading ? <Spinner size={16} /> : iconLeft}
      {children}
      {iconRight}
    </button>
  );
}

export const iconButtonVariants = cva(
  'inline-flex shrink-0 select-none items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: variantClasses,
      size: {
        'icon-sm': 'size-7',
        'icon-md': 'size-8',
      },
    },
    defaultVariants: { variant: 'ghost', size: 'icon-md' },
  },
);

export interface IconButtonProps
  extends ComponentProps<'button'>,
    VariantProps<typeof iconButtonVariants> {
  /** Wymagane — przycisk bez tekstu musi mieć etykietę dla czytników. */
  'aria-label': string;
  loading?: boolean;
}

/** Przycisk-ikona (dziecko: ikona lucide 16px). Domyślnie ghost 32px. */
export function IconButton({
  variant,
  size,
  loading = false,
  disabled,
  className,
  type,
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={cn(iconButtonVariants({ variant, size }), className)}
      disabled={disabled === true || loading}
      {...(loading ? { 'aria-busy': true } : {})}
      {...rest}
    >
      {loading ? <Spinner size={16} /> : children}
    </button>
  );
}
