import { describe, expect, it } from 'vitest'

import { looksLikeWhisperHallucination } from './hallucination-filter'

describe('looksLikeWhisperHallucination', () => {
  it.each([
    '[BLANK_AUDIO]',
    '[Silence]',
    '[ Silence ]',
    '[Music]',
    '[Applause]',
    '[♪]',
    '(slams door)',
    '(coughs)',
    '(laughs)',
    '(applause)',
    'Thanks for watching!',
    'thank you.',
    'Thank you for watching',
    'you',
    'You.',
    'Bye.',
    'mm.',
    'mhm.',
    '...',
    '.',
    '♪',
    '   ',
    '',
  ])('drops hallucination %j', (text) => {
    expect(looksLikeWhisperHallucination(text)).toBe(true)
  })

  it.each([
    'Hello there.',
    'What is the weather today?',
    'She said (laughs) and walked away.',
    'I just saw [the report] on my desk.',
    'Thanks for watching the meeting recording with me.',
    'Okay, let me think about that.',
  ])('passes real speech %j', (text) => {
    expect(looksLikeWhisperHallucination(text)).toBe(false)
  })
})
