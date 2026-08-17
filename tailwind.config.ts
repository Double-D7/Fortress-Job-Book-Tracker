import type { Config } from 'tailwindcss'

/**
 * Tokens per §8 — dark, high-contrast, industrial-professional, with deep
 * purple as the brand accent against near-black surfaces. Every colour is
 * exposed as a CSS variable in globals.css so a future themes table can
 * override them per client org without a rebuild.
 */
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: 'rgb(var(--canvas) / <alpha-value>)',
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          raised: 'rgb(var(--surface-raised) / <alpha-value>)',
        },
        hairline: 'rgb(var(--hairline) / <alpha-value>)',
        ink: {
          DEFAULT: 'rgb(var(--text-primary) / <alpha-value>)',
          secondary: 'rgb(var(--text-secondary) / <alpha-value>)',
          muted: 'rgb(var(--text-muted) / <alpha-value>)',
        },
        brand: {
          DEFAULT: 'rgb(var(--brand) / <alpha-value>)',
          bright: 'rgb(var(--brand-bright) / <alpha-value>)',
        },
        status: {
          complete: 'rgb(var(--status-complete) / <alpha-value>)',
          progress: 'rgb(var(--status-progress) / <alpha-value>)',
          idle: 'rgb(var(--status-idle) / <alpha-value>)',
          critical: 'rgb(var(--status-critical) / <alpha-value>)',
          info: 'rgb(var(--status-info) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        // Numeric columns — weld numbers, heat numbers, torque values,
        // percentages — must align vertically in the grids.
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: { card: '10px' },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
    },
  },
  plugins: [],
} satisfies Config
