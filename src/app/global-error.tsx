'use client'

/**
 * The last resort: a failure in the root layout itself.
 *
 * `error.tsx` renders inside the layout, so it cannot catch a layout
 * that is itself broken. This one replaces the whole document, which is
 * why it carries its own `html` and `body` and cannot use any of the
 * application's styling or components — none of it is mounted.
 *
 * Inline styles for the same reason, and dark to match the application
 * so this does not arrive as a white flash on a phone in a field.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string }
}) {
  return (
    <html lang="en">
      <body style={{
        margin: 0,
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0C0F14',
        color: '#E6EAF0',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
        padding: '24px',
      }}>
        <div style={{ maxWidth: '34rem' }}>
          <div style={{
            fontSize: '11px', letterSpacing: '0.18em', textTransform: 'uppercase',
            color: '#B8730F', fontWeight: 700,
          }}>
            Fortress Job Book Tracker
          </div>

          <h1 style={{
            margin: '12px 0 0', fontSize: '21px', fontWeight: 700, lineHeight: 1.25,
          }}>
            The application could not start.
          </h1>

          <p style={{ margin: '12px 0 0', fontSize: '14px', lineHeight: 1.6, color: '#9AA7B8' }}>
            This is a failure in the application itself rather than in one page, so there is
            nothing useful to retry from here.{' '}
            <span style={{ color: '#E6EAF0' }}>No job book data has been changed.</span>
          </p>

          <div style={{
            margin: '18px 0 0', padding: '12px 16px',
            border: '1px solid #20283A', borderRadius: '8px', background: '#131824',
          }}>
            <div style={{
              fontSize: '10px', letterSpacing: '0.12em', textTransform: 'uppercase',
              color: '#6C7B91',
            }}>
              Reference
            </div>
            <div style={{
              marginTop: '4px', fontFamily: 'ui-monospace, SFMono-Regular, monospace',
              fontSize: '17px', letterSpacing: '0.18em',
            }}>
              {error.digest ?? 'not recorded'}
            </div>
          </div>

          <p style={{ margin: '16px 0 0', fontSize: '13px', lineHeight: 1.6, color: '#9AA7B8' }}>
            Report it to David Devitt with that reference. Reloading is worth one attempt;
            if it happens again the application needs attention.
          </p>

          <a
            href="/"
            style={{
              display: 'inline-block', marginTop: '18px', padding: '8px 14px',
              borderRadius: '6px', background: '#5B4BE0', color: '#fff',
              textDecoration: 'none', fontSize: '13px', fontWeight: 600,
            }}
          >
            Reload
          </a>
        </div>
      </body>
    </html>
  )
}
