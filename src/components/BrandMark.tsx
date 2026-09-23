import Image from 'next/image'

/**
 * The JBT mark.
 *
 * One component rather than an `<Image>` repeated in three places, because
 * the corner radius and the rendered file are the sort of thing that gets
 * changed in two of them and forgotten in the third.
 *
 * `alt=""` is deliberate and not an oversight. Everywhere this appears it
 * sits beside the words "Fortress Job Book Tracker", and a screen reader
 * announcing the name twice is worse than announcing it once. Where the
 * mark ever stands alone, give it a real alt.
 *
 * The file is 128px square and rendered no larger than 44, so it stays
 * sharp on the phone screens this is read on in the field.
 */
export function BrandMark({
  size = 32, className = '',
}: { size?: number; className?: string }) {
  return (
    <Image
      src="/brand-mark.png"
      alt=""
      width={size}
      height={size}
      // The header mark is above the fold on every page; letting it arrive
      // late makes the whole bar shift.
      priority
      className={`shrink-0 rounded-[22%] ${className}`}
    />
  )
}
