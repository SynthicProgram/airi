// Whisper hallucinates non-speech tokens (e.g. "[BLANK_AUDIO]", "(slams door)",
// "Thanks for watching!") when fed silence or near-silent audio — a known
// failure mode rooted in its caption-heavy training data. We drop only
// whole-utterance matches so real speech containing a parenthetical aside
// still passes through.
const HALLUCINATION_PHRASES: ReadonlySet<string> = new Set([
  'thanks for watching',
  'thank you',
  'thank you for watching',
  'you',
  'bye',
  'okay',
  'mm',
  'mhm',
  'uh',
  'um',
  'subscribe to my channel',
  'please subscribe',
])

const PURE_BRACKET = /^\[[^\]]*\]$/
const PURE_PAREN = /^\([^)]*\)$/
const PURE_PUNCT = /^[\s\p{P}\p{S}]+$/u
const TRAILING_NOISE = /[\s\p{P}\p{S}]+$/u
const LEADING_NOISE = /^[\s\p{P}\p{S}]+/u

export function looksLikeWhisperHallucination(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed)
    return true
  if (PURE_BRACKET.test(trimmed))
    return true
  if (PURE_PAREN.test(trimmed))
    return true
  if (PURE_PUNCT.test(trimmed))
    return true
  const normalized = trimmed.toLowerCase().replace(TRAILING_NOISE, '').replace(LEADING_NOISE, '')
  if (HALLUCINATION_PHRASES.has(normalized))
    return true
  return false
}
