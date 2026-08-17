import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Percentages are shown to one decimal throughout: §5.4 forbids a bare
 *  rounded number that a manager cannot reconcile against the inputs. */
export const pct = (n: number, dp = 1) => `${n.toFixed(dp)}%`

export const num = (n: number) => n.toLocaleString('en-US')

export const bytes = (n: number) => {
  if (n < 1024) return `${n} B`
  if (n < 1_048_576) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1_073_741_824) return `${(n / 1_048_576).toFixed(1)} MB`
  return `${(n / 1_073_741_824).toFixed(2)} GB`
}

export const shortDate = (d?: string | null) => d ?? '—'

/** Days from today to an ISO date; negative once past. */
export function daysUntil(d: string): number {
  const now = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')
  return Math.round((Date.parse(`${d}T00:00:00Z`) - now) / 86_400_000)
}
