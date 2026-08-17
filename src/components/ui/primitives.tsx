/**
 * Component primitives, styled to the §8 tokens.
 *
 * These follow the shadcn/ui API shape (a `cn`-merged className, variant
 * props, forwarded refs) so the project can adopt shadcn components
 * wholesale later without a rewrite — but they are hand-written here to
 * keep the dependency surface small and the theme in one place.
 */
import * as React from 'react'
import { cn } from '@/lib/utils'

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-card border border-hairline bg-surface',
        className,
      )}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('border-b border-hairline px-5 py-3.5', className)} {...props} />
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-sm font-semibold tracking-tight text-ink', className)} {...props} />
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-4', className)} {...props} />
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand-bright text-white hover:bg-brand-bright/90',
  secondary: 'border border-hairline bg-surface-raised text-ink hover:bg-hairline',
  ghost: 'text-ink-secondary hover:bg-surface-raised hover:text-ink',
  danger: 'bg-status-critical/15 text-status-critical hover:bg-status-critical/25',
}

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }
>(function Button({ className, variant = 'secondary', ...props }, ref) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5',
        'text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...props}
    />
  )
})

/**
 * Status chip. Colour is never the only carrier of meaning (§8) — every
 * chip renders its label, and callers pass an icon where one helps.
 */
export type ChipTone = 'complete' | 'progress' | 'idle' | 'critical' | 'info' | 'brand'

const CHIP_TONES: Record<ChipTone, string> = {
  complete: 'bg-status-complete/15 text-status-complete',
  progress: 'bg-status-progress/15 text-status-progress',
  idle: 'bg-status-idle/15 text-ink-secondary',
  critical: 'bg-status-critical/15 text-status-critical',
  info: 'bg-status-info/15 text-status-info',
  brand: 'bg-brand-bright/12 text-brand-bright',
}

export function Chip({
  tone = 'idle', icon, className, children, ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: ChipTone; icon?: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium',
        'whitespace-nowrap',
        CHIP_TONES[tone],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </span>
  )
}

/** Slim horizontal bar for a section's score. */
export function ProgressBar({
  value, tone, className,
}: { value: number; tone?: ChipTone; className?: string }) {
  const resolved = tone ?? bandTone(value)
  const fill = {
    complete: 'bg-status-complete', progress: 'bg-status-progress',
    idle: 'bg-status-idle', critical: 'bg-status-critical',
    info: 'bg-status-info', brand: 'bg-brand-bright',
  }[resolved]
  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-hairline', className)}
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={cn('h-full rounded-full transition-[width]', fill)}
           style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  )
}

/** Red below 50, amber 50–89, green at 90 and above (§8). */
export function bandTone(pct: number): ChipTone {
  if (pct >= 90) return 'complete'
  if (pct >= 50) return 'progress'
  return 'critical'
}

/**
 * Circular completion ring. The numeric value is always rendered inside it
 * — §8 forbids relying on the band colour alone.
 */
export function Ring({
  value, size = 148, stroke = 12, label, sublabel,
}: { value: number; size?: number; stroke?: number; label?: string; sublabel?: string }) {
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(100, value))
  const tone = bandTone(clamped)
  const color = {
    complete: 'rgb(34 197 94)', progress: 'rgb(245 158 11)',
    critical: 'rgb(239 68 68)', idle: 'rgb(108 108 128)',
    info: 'rgb(56 189 248)', brand: 'rgb(124 77 255)',
  }[tone]

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" role="img"
           aria-label={`${label ?? 'Completion'}: ${clamped.toFixed(1)} percent`}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none"
                stroke="rgb(42 42 56)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none"
                stroke={color} strokeWidth={stroke} strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - clamped / 100)} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="tnum text-3xl font-semibold tracking-tight">{clamped.toFixed(1)}%</span>
        {sublabel && <span className="mt-0.5 text-2xs text-ink-muted">{sublabel}</span>}
      </div>
    </div>
  )
}

/** Metric tile for the overview screen. */
export function Metric({
  label, value, sub, tone,
}: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: ChipTone }) {
  const accent = tone
    ? { complete: 'text-status-complete', progress: 'text-status-progress',
        critical: 'text-status-critical', info: 'text-status-info',
        idle: 'text-ink', brand: 'text-brand-bright' }[tone]
    : 'text-ink'
  return (
    <Card className="px-4 py-3">
      <div className="text-2xs uppercase tracking-wide text-ink-muted">{label}</div>
      <div className={cn('tnum mt-1 text-2xl font-semibold tracking-tight', accent)}>{value}</div>
      {sub && <div className="mt-0.5 text-2xs text-ink-secondary">{sub}</div>}
    </Card>
  )
}

/** Data table shell: sticky header, hairline row separators, no zebra. */
export function Table({ className, ...props }: React.HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full border-collapse text-xs', className)} {...props} />
    </div>
  )
}

export function Th({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'sticky top-0 z-10 whitespace-nowrap border-b border-hairline bg-surface',
        'px-3 py-2 text-left text-2xs font-medium uppercase tracking-wide text-ink-muted',
        className,
      )}
      {...props}
    />
  )
}

export function Td({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('border-b border-hairline/60 px-3 py-2 align-top', className)} {...props} />
}

export function Tr({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('transition-colors hover:bg-brand-bright/[0.06]', className)} {...props} />
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-hairline px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink-secondary">{title}</p>
      {detail && <p className="mt-1 max-w-md text-xs text-ink-muted">{detail}</p>}
    </div>
  )
}

export function SectionHeading({
  title, subtitle, actions,
}: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-0.5 text-xs text-ink-secondary">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
