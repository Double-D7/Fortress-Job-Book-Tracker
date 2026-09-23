/**
 * Build every icon the app serves from the one piece of source artwork.
 *
 *   npm run build:icons
 *
 * The generated PNGs are committed, so this does not run at build time.
 * It exists so that replacing the logo is one command against one file
 * rather than six hand-made exports that drift — the failure there is
 * subtle and long-lived, because a stale home-screen icon looks fine
 * until somebody compares two phones.
 *
 * Three jobs, three treatments:
 *
 * 1. Home screen and tab, full bleed. The art is framed and complete, and
 *    at 180px every part of it reads.
 *
 * 2. Maskable, for Android. Launchers crop an icon to a circle or a
 *    squircle of their choosing, so the art is inset on the app's own
 *    canvas colour and the frame survives whatever shape is imposed.
 *
 * 3. The in-app mark, cropped. This is the one that is not obvious: at
 *    30px the outer bezel and the sky take most of the pixels and the
 *    shield collapses into a dark smudge. Trimming the frame gives those
 *    pixels to the shield and the letters, which is all anyone can
 *    resolve at that size. It is only used in the header and the sign-in
 *    card — the icons above stay whole.
 */
import sharp from 'sharp'
import { mkdir } from 'node:fs/promises'

const SOURCE = 'assets/brand/jbt-icon.webp'

/** Matches --canvas in globals.css. */
const CANVAS = { r: 11, g: 11, b: 15, alpha: 1 }

/** How much of the source the in-app mark keeps, measured by eye against
 *  the header at 32px. Below about 0.8 the letters start touching the
 *  edge; above about 0.95 the bezel is back. */
const MARK_CROP = 0.88

/** Android's safe area for a maskable icon is the middle 80%. */
const MASKABLE_SAFE = 0.8

async function square(size: number, out: string, crop = 1) {
  const { width = 0 } = await sharp(SOURCE).metadata()
  const side = Math.round(width * crop)
  const off = (width - side) >> 1
  await sharp(SOURCE)
    .extract({ left: off, top: off, width: side, height: side })
    .resize(size, size, { fit: 'cover' })
    .png({ compressionLevel: 9 })
    .toFile(out)
}

async function maskable(size: number, out: string) {
  const inner = Math.round(size * MASKABLE_SAFE)
  const art = await sharp(SOURCE).resize(inner, inner, { fit: 'cover' }).png().toBuffer()
  const edge = (size - inner) >> 1
  await sharp({ create: { width: size, height: size, channels: 4, background: CANVAS } })
    .composite([{ input: art, top: edge, left: edge }])
    .png({ compressionLevel: 9 })
    .toFile(out)
}

async function main() {
  await mkdir('public', { recursive: true })

  // Next's file conventions: these become <link rel="icon"> and
  // <link rel="apple-touch-icon"> without any markup.
  await square(256, 'src/app/icon.png')
  await square(180, 'src/app/apple-icon.png')

  // Referenced by src/app/manifest.ts.
  await square(192, 'public/icon-192.png')
  await square(512, 'public/icon-512.png')
  await maskable(512, 'public/icon-maskable-512.png')

  // The header and sign-in mark. 128 for a 32px slot, so it holds up on a
  // phone at 3x.
  await square(128, 'public/brand-mark.png', MARK_CROP)

  console.log('Icons written from', SOURCE)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
