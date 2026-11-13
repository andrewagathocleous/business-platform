/**
 * Most code points a 100 × 150 mm card can show.
 *
 * The default card is the Zebra preset: 5 mm margins, so the text area is
 * 90 × 140 mm. At the minimum 9 pt and line height 1.25, 35 lines fit
 * (the 36th ends past the text area). Wrapping keeps a 2 pt safety inset,
 * and the narrowest Noto Sans advance is U+200A at 0.9 pt, so 281 of those
 * fit on a line. 35 × 281 = 9835. A longer message cannot be shown, even as
 * nothing but that glyph. The import still stores it byte-for-byte and sends
 * the order to review. The gift card is refused at print time because it
 * does not fit. The text is not cut.
 *
 * Import, print, the glyph check and the renderer share this limit, and they
 * consult it before shaping. fontkit on an unbounded string exhausts the
 * worker heap, and a retry repeats the crash. The stored message is unchanged.
 */
export const GIFT_MESSAGE_MAX_CODE_POINTS = 35 * 281;

/**
 * True when `text` has more code points than the card can show.
 * The scan stops at the limit, so a million-character message is not walked.
 */
export function giftMessageTooLong(text: string): boolean {
  // Each code point uses at least one code unit, so this string cannot be over
  // the limit. A longer string may still fit when it contains surrogate pairs.
  if (text.length <= GIFT_MESSAGE_MAX_CODE_POINTS) {
    return false;
  }
  let count = 0;
  for (let index = 0; index < text.length;) {
    const code = text.codePointAt(index);
    index += code !== undefined && code > 0xffff ? 2 : 1;
    count += 1;
    if (count > GIFT_MESSAGE_MAX_CODE_POINTS) {
      return true;
    }
  }
  return false;
}
