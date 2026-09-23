import type { Metadata, Viewport } from 'next'
import './globals.css'
import { AppShell } from '@/components/AppShell'

export const metadata: Metadata = {
  title: 'Fortress Job Book Tracker',
  description: 'QA/QC turnover documentation tracking for flowline and facility construction.',
  // iOS does not read the web manifest. Saving to the home screen takes
  // its icon from `apple-icon.png` and its name and full-screen behaviour
  // from here, so both have to be stated — the manifest alone would give
  // Android a proper app and iOS a browser shortcut.
  appleWebApp: {
    capable: true,
    title: 'JBT',
    statusBarStyle: 'black-translucent',
  },
}

export const viewport: Viewport = {
  // Matches --canvas. Without it the phone draws its own bar colour above
  // the app and the top of the screen does not belong to the page.
  themeColor: '#0B0B0F',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Next emits the standardised `mobile-web-app-capable`. iOS below
            16.4 reads only the apple-prefixed spelling, and a phone that
            lives in a truck is rarely the newest one — without this, saving
            to the home screen there gives a browser shortcut rather than
            something that opens like an app. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        {/* Inter for the UI, JetBrains Mono for numeric columns (§8). */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  )
}
