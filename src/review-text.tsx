import './review-text.css';

// One pass, one text node: even an all-control 64 KiB preview cannot create
// thousands of DOM elements. These strings are for display only, never paths.
export const REVIEW_TEXT_LIMIT = 65_536;
const hidden = /[\p{Bidi_Control}\p{Default_Ignorable_Code_Point}\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/gu;
const identityHidden = new RegExp(`${hidden.source}|[\\t\\n ]`, 'gu');
export type ReviewTextMode = 'text' | 'identity';
const variationSelector = /^[\u180B-\u180D\u180F\uFE00-\uFE0F\u{E0100}-\u{E01EF}]$/u;
const emojiBefore = /\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?$/u;
const emojiAfter = /^\p{Extended_Pictographic}/u;
// Joiners are ordinary orthography in these scripts. Preserve joining inside
// those words, but expose isolated joiners and joiners hidden in Latin names.
const joiningBefore = /[\u0600-\u08FF\u0900-\u0DFF]$/u;
const joiningAfter = /^[\u0600-\u08FF\u0900-\u0DFF]/u;
export function formatReviewText(value: string, mode: ReviewTextMode = 'text') {
  const bounded = value.slice(0, REVIEW_TEXT_LIMIT);
  let suspicious = false;
  const text = bounded.replace(mode === 'identity' ? identityHidden : hidden, (character: string, offset: number) => {
    // A single interior space is readable; edge/repeated spaces can conceal
    // identity when names appear in HTML elements that collapse whitespace.
    if (character === ' ' && offset > 0 && offset < bounded.length - 1 && bounded[offset - 1] !== ' ' && bounded[offset + 1] !== ' ') return character;
    if (variationSelector.test(character)) {
      const before = bounded.slice(Math.max(0, offset - 2), offset);
      if (/[\p{Extended_Pictographic}\p{Script=Han}\p{Script=Mongolian}]$/u.test(before)) return character;
    }
    if (character === '\u200C' || character === '\u200D') {
      const before = bounded.slice(Math.max(0, offset - 8), offset), after = bounded.slice(offset + 1, offset + 9);
      if ((joiningBefore.test(before) && joiningAfter.test(after)) ||
        (character === '\u200D' && emojiBefore.test(before) && emojiAfter.test(after))) return character;
    }
    // Ordinary source formatting is preserved. CR used alone can conceal text.
    if (mode === 'text' && character === '\r' && bounded[offset + 1] === '\n') return character;
    suspicious = true;
    return `⟦U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟧`;
  });
  return { text, suspicious, truncated: bounded.length !== value.length };
}

/** React text interpolation escapes HTML; Unicode markers never become markup. */
export function ReviewText({ text, mode = 'text' }: { text: string; mode?: ReviewTextMode }) {
  const display = formatReviewText(text, mode);
  return <>{display.suspicious && <span className="review-text-warning">Unicode review warning: hidden, spacing or bidirectional characters are shown as ⟦U+XXXX⟧. </span>}{display.text}{display.truncated && <span className="review-text-warning"> Display truncated at the review limit.</span>}</>;
}
