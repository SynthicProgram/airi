// Bracketed timestamps like `[2026-05-05 22:32]` are prepended to chat history
// for prefix-cache stability (see stores/chat/datetime-prefix.ts). Weak local
// models often echo them back into replies; we strip them before TTS so they
// are never spoken.
//
// Streaming-safe: when an unmatched `[` lands near the end of the buffer, we
// hold back from `[` onward until either a closing `]` arrives or enough chars
// elapse to rule out a timestamp. This catches the case where a chunk boundary
// splits the pattern, e.g. `[2026-05-05 ` + `22:32]`.

const TTS_TIMESTAMP_RE = /\[\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?\]\s?/g
// `[YYYY-MM-DD HH:MM:SS]` is 21 chars; with a trailing space, 22. We use 24 to
// leave a small margin and to bound how far ahead we're willing to wait.
const TTS_MAX_BRACKET_LOOKAHEAD = 24

export interface TtsTimestampStripper {
  consume: (text: string) => void
  flush: () => void
}

export function createTtsTimestampStripper(emit: (value: string) => void): TtsTimestampStripper {
  let buffer = ''
  return {
    consume(text) {
      if (!text)
        return
      buffer += text
      let safeUpTo = buffer.length
      const lastOpen = buffer.lastIndexOf('[')
      const lastClose = buffer.lastIndexOf(']')
      if (lastOpen > lastClose && buffer.length - lastOpen < TTS_MAX_BRACKET_LOOKAHEAD)
        safeUpTo = lastOpen
      const safePart = buffer.slice(0, safeUpTo).replace(TTS_TIMESTAMP_RE, '')
      buffer = buffer.slice(safeUpTo)
      if (safePart)
        emit(safePart)
    },
    flush() {
      if (!buffer)
        return
      const out = buffer.replace(TTS_TIMESTAMP_RE, '')
      buffer = ''
      if (out)
        emit(out)
    },
  }
}
