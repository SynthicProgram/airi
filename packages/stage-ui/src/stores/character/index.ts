import type { IntentHandle } from '@proj-airi/pipelines-audio'

import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { computed, reactive, ref } from 'vue'

import { useLlmmarkerParser } from '../../composables/llm-marker-parser'
import { useAiriCardStore } from '../modules'
import { useSpeechRuntimeStore } from '../speech-runtime'

export * from './notebook'
export * from './orchestrator'

export interface CharacterSparkNotifyReaction {
  id: string
  message: string
  createdAt: number
  sourceEventId?: string
  metadata?: Record<string, unknown>
}

interface StreamingReactionState {
  reaction: CharacterSparkNotifyReaction
  intent: IntentHandle
  parser: ReturnType<ParserFactory>
  stripper: ReturnType<typeof createTtsTimestampStripper>
}

// Bracketed timestamps like `[2026-05-05 22:32]` are prepended to chat history
// for prefix-cache stability (see chat/datetime-prefix.ts). Weak local models
// often echo them back into replies; we strip them before TTS so they're never
// spoken. Streaming-safe: holds back an unmatched trailing `[` until either a
// closing `]` arrives or enough chars elapse to rule out a timestamp.
const TTS_TIMESTAMP_RE = /\[\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?\]\s?/g
const TTS_MAX_BRACKET_LOOKAHEAD = 24

function createTtsTimestampStripper(emit: (value: string) => void) {
  let buffer = ''
  return {
    consume(text: string) {
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

const MAX_REACTIONS = 200
type ParserFactory = typeof useLlmmarkerParser
let parserFactory: ParserFactory = useLlmmarkerParser

export function setCharacterLlmMarkerParserFactoryForTest(factory: ParserFactory | null) {
  parserFactory = factory ?? useLlmmarkerParser
}

export const useCharacterStore = defineStore('character', () => {
  const { activeCard, systemPrompt } = storeToRefs(useAiriCardStore())

  const name = computed(() => activeCard.value?.name ?? '')
  const ownerId = computed(() => activeCard.value?.name ?? 'default')

  const reactions = ref<CharacterSparkNotifyReaction[]>([])
  const streamingReactions = ref<Map<string, StreamingReactionState>>(new Map())
  const speechRuntimeStore = useSpeechRuntimeStore()

  async function emitTextOutput(text: string) {
    const intent = speechRuntimeStore.openIntent({
      ownerId: ownerId.value,
      priority: 'normal',
      behavior: 'queue',
    })

    const stripper = createTtsTimestampStripper(value => intent.writeLiteral(value))
    const parser = parserFactory({
      onLiteral: async (literal) => {
        if (literal)
          stripper.consume(literal)
      },
      onSpecial: async (special) => {
        if (special)
          intent.writeSpecial(special)
      },
    })

    await parser.consume(text)
    await parser.end()
    stripper.flush()

    intent.writeFlush()
    intent.end()
  }

  function onSparkNotifyReactionStreamEvent(sparkEventId: string, chunk: string, options?: { metadata?: Record<string, unknown> }) {
    if (!streamingReactions.value.has(sparkEventId)) {
      const newReaction = reactive({
        id: nanoid(),
        message: '',
        createdAt: Date.now(),
        sourceEventId: sparkEventId,
        metadata: options?.metadata,
      }) satisfies CharacterSparkNotifyReaction

      const intent = speechRuntimeStore.openIntent({
        intentId: `spark:${sparkEventId}`,
        ownerId: ownerId.value,
        priority: 'high',
        behavior: 'interrupt',
      })

      const stripper = createTtsTimestampStripper(value => intent.writeLiteral(value))
      const parser = parserFactory({
        onLiteral: async (literal) => {
          if (literal)
            stripper.consume(literal)
        },
        onSpecial: async (special) => {
          if (special)
            intent.writeSpecial(special)
        },
      })

      streamingReactions.value.set(sparkEventId, { reaction: newReaction, intent, parser, stripper })
    }

    const state = streamingReactions.value.get(sparkEventId)!
    state.reaction.message += chunk
    void state.parser.consume(chunk)
  }

  function onSparkNotifyReactionStreamEnd(sparkEventId: string, fullText: string, options?: { metadata?: Record<string, unknown> }) {
    const state = streamingReactions.value.get(sparkEventId)
    if (!state)
      return

    state.reaction.message = fullText
    recordSparkNotifyReaction(sparkEventId, fullText, { metadata: options?.metadata })

    void state.parser.end().then(() => {
      state.stripper.flush()
      state.intent.writeFlush()
      state.intent.end()
      streamingReactions.value.delete(sparkEventId)
    })
  }

  function recordSparkNotifyReaction(sparkEventId: string, message: string, options?: { metadata?: Record<string, unknown> }) {
    const newReaction = {
      id: nanoid(),
      message,
      createdAt: Date.now(),
      sourceEventId: sparkEventId,
      metadata: options?.metadata,
    } satisfies CharacterSparkNotifyReaction

    reactions.value.push(newReaction)

    if (reactions.value.length > MAX_REACTIONS) {
      reactions.value.splice(0, reactions.value.length - MAX_REACTIONS)
    }
  }

  function clearReactions() {
    reactions.value = []
  }

  return {
    name,
    reactions,
    systemPrompt,

    recordSparkNotifyReaction,
    onSparkNotifyReactionStreamEvent,
    onSparkNotifyReactionStreamEnd,
    clearReactions,

    emitTextOutput,
  }
})
