import type { MetadataRoute } from 'next'

/**
 * What a phone reads when somebody saves this to their home screen.
 *
 * Techs work off a phone in a yard. Saved to the home screen this opens
 * without browser chrome, which is worth more than it sounds: the address
 * bar and tab strip are half the vertical space on a phone, and a
 * checklist is a long scroll.
 *
 * `short_name` is what fits under an icon on a home screen — roughly
 * twelve characters before iOS truncates it — so it is the initials on the
 * mark rather than the full title.
 *
 * Two 512s on purpose. `any` is the icon as drawn, framed and complete.
 * `maskable` is the same art inset on the app's own canvas colour, because
 * Android crops an icon to whatever shape the launcher uses and would
 * otherwise cut the frame off this one.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Fortress Job Book Tracker',
    short_name: 'JBT',
    description:
      'QA/QC turnover documentation tracking for flowline, facility and maintenance construction.',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0B0B0F',
    theme_color: '#0B0B0F',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
