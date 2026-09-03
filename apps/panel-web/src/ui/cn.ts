import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Łączenie klas: clsx (warunki) + tailwind-merge (konflikty utilities). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
