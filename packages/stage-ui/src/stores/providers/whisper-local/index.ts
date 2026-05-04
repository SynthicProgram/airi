import type { TranscriptionProviderWithExtraOptions } from '@xsai-ext/providers/utils'
import type { StreamTranscriptionDelta, StreamTranscriptionResult } from '@xsai/stream-transcription'

import type {
  ErrorResponse,
  InferenceResultResponse,
  ModelReadyResponse,
  ProgressResponse,
  WorkerOutboundMessage,
} from '../../../libs/inference/protocol'
import type { WhisperLocalInferenceInput, WhisperLocalInferenceOutput } from '../../../workers/whisper/types'

import vadWorkletUrl from '../../../workers/vad/process.worklet?worker&url'
import whisperWorkerUrl from '../../../workers/whisper/worker?worker&url'

import { removeInferenceStatus, updateInferenceStatus } from '../../../composables/use-inference-status'
import { createRequestId, InferenceAbortError } from '../../../libs/inference/protocol'
import { looksLikeWhisperHallucination } from './hallucination-filter'

const DEFAULT_MODEL_ID = 'onnx-community/whisper-base'
const STATUS_KEY = 'whisper-local'

const TARGET_SAMPLE_RATE = 16_000
const FRAME_SIZE = 512 // matches the existing VAD worklet's MIN_CHUNK_SIZE
const SILENCE_RMS_THRESHOLD = 0.015
const MIN_UTTERANCE_FRAMES = Math.floor((TARGET_SAMPLE_RATE * 0.4) / FRAME_SIZE) // ~400 ms of voiced speech
const SILENCE_FRAMES_TO_END = Math.floor((TARGET_SAMPLE_RATE * 0.7) / FRAME_SIZE) // ~700 ms of silence
const PRE_ROLL_FRAMES = Math.floor((TARGET_SAMPLE_RATE * 0.2) / FRAME_SIZE) // ~200 ms preserved before speech
const MAX_UTTERANCE_FRAMES = Math.floor((TARGET_SAMPLE_RATE * 25) / FRAME_SIZE) // safety cap ~25 s
const SPEECH_ENTRY_FRAMES = Math.max(1, Math.floor((TARGET_SAMPLE_RATE * 0.12) / FRAME_SIZE)) // ~120 ms of consecutive voiced frames before opening an utterance

export interface WhisperLocalExtraOptions {
  language?: string
  modelId?: string
  abortSignal?: AbortSignal
}

interface DeferredText {
  promise: Promise<string>
  resolve: (text: string) => void
  reject: (err: unknown) => void
  isResolved: boolean
  isRejected: boolean
}

function createDeferredText(): DeferredText {
  let resolve!: (text: string) => void
  let reject!: (err: unknown) => void
  let isResolved = false
  let isRejected = false
  const promise = new Promise<string>((res, rej) => {
    resolve = (value) => {
      isResolved = true
      res(value)
    }
    reject = (reason) => {
      isRejected = true
      rej(reason)
    }
  })
  return {
    promise,
    resolve,
    reject,
    get isResolved() { return isResolved },
    get isRejected() { return isRejected },
    set isResolved(v: boolean) { isResolved = v },
    set isRejected(v: boolean) { isRejected = v },
  }
}

interface WhisperWorkerHandle {
  worker: Worker
  modelId: string
  ready: Promise<void>
  transcribe: (audio: Float32Array, language: string | undefined, signal?: AbortSignal) => Promise<string>
  terminate: () => void
}

let workerHandle: WhisperWorkerHandle | null = null

function getWorker(modelId: string): WhisperWorkerHandle {
  if (workerHandle && workerHandle.modelId === modelId)
    return workerHandle

  if (workerHandle) {
    workerHandle.terminate()
    workerHandle = null
  }

  const worker = new Worker(whisperWorkerUrl, { type: 'module' })

  const ready = new Promise<void>((resolve, reject) => {
    const requestId = createRequestId()
    const onMessage = (event: MessageEvent<WorkerOutboundMessage<WhisperLocalInferenceOutput>>) => {
      const data = event.data
      if (data.requestId !== requestId)
        return

      if (data.type === 'progress') {
        const payload = (data as ProgressResponse).payload
        updateInferenceStatus(STATUS_KEY, {
          state: 'downloading',
          progress: payload,
        })
        return
      }

      if (data.type === 'model-ready') {
        const ready = data as ModelReadyResponse
        updateInferenceStatus(STATUS_KEY, {
          state: 'ready',
          device: ready.device,
        })
        worker.removeEventListener('message', onMessage)
        resolve()
        return
      }

      if (data.type === 'error') {
        const err = data as ErrorResponse
        updateInferenceStatus(STATUS_KEY, { state: 'error', error: err.payload })
        worker.removeEventListener('message', onMessage)
        reject(new Error(err.payload.message))
      }
    }

    worker.addEventListener('message', onMessage)

    updateInferenceStatus(STATUS_KEY, { state: 'downloading', device: 'webgpu' })
    worker.postMessage({
      type: 'load-model',
      requestId,
      modelId,
      device: 'webgpu',
    })
  })

  const handle: WhisperWorkerHandle = {
    worker,
    modelId,
    ready,
    transcribe(audio, language, signal) {
      return new Promise<string>((resolve, reject) => {
        const requestId = createRequestId()

        const onMessage = (event: MessageEvent<WorkerOutboundMessage<WhisperLocalInferenceOutput>>) => {
          const data = event.data
          if (data.requestId !== requestId)
            return

          if (data.type === 'inference-result') {
            const result = data as InferenceResultResponse<WhisperLocalInferenceOutput>
            cleanup()
            resolve(result.output.text.join(' ').trim())
            return
          }

          if (data.type === 'error') {
            const err = data as ErrorResponse
            cleanup()
            if (err.payload.code === 'CANCELLED')
              reject(new InferenceAbortError(err.payload.message))
            else
              reject(new Error(err.payload.message))
          }
        }

        const cleanup = () => {
          worker.removeEventListener('message', onMessage)
          if (signal && abortHandler)
            signal.removeEventListener('abort', abortHandler)
        }

        const abortHandler = signal
          ? () => {
              worker.postMessage({ type: 'cancel', requestId: createRequestId(), targetRequestId: requestId })
              cleanup()
              const reason = signal.reason
              reject(reason instanceof Error ? reason : new InferenceAbortError(typeof reason === 'string' ? reason : undefined))
            }
          : null

        worker.addEventListener('message', onMessage)
        if (signal) {
          if (signal.aborted) {
            cleanup()
            const reason = signal.reason
            reject(reason instanceof Error ? reason : new InferenceAbortError(typeof reason === 'string' ? reason : undefined))
            return
          }
          signal.addEventListener('abort', abortHandler!)
        }

        const input: WhisperLocalInferenceInput = { audioFloat32: audio, language }
        worker.postMessage(
          { type: 'run-inference', requestId, input },
          [audio.buffer],
        )
      })
    },
    terminate() {
      worker.terminate()
      removeInferenceStatus(STATUS_KEY)
    },
  }

  workerHandle = handle
  return handle
}

export function disposeWhisperLocalProvider(): void {
  if (workerHandle) {
    workerHandle.terminate()
    workerHandle = null
  }
}

/**
 * Push-to-talk (file) path. Decodes the WAV/audio File into a Float32Array
 * at 16 kHz mono and runs Whisper inference. Returned as a fake `Response`
 * shaped to match what `@xsai/generate-transcription` expects.
 */
async function transcribeFileViaWorker(file: Blob, modelId: string, language?: string, signal?: AbortSignal): Promise<{ text: string }> {
  const handle = getWorker(modelId)
  await handle.ready

  const arrayBuffer = await file.arrayBuffer()
  const audioCtx = new (globalThis.OfflineAudioContext
    ? OfflineAudioContext
    : (globalThis as any).webkitOfflineAudioContext)(1, 1, TARGET_SAMPLE_RATE)
  const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0))

  let audioFloat32: Float32Array
  if (decoded.sampleRate === TARGET_SAMPLE_RATE && decoded.numberOfChannels === 1) {
    audioFloat32 = decoded.getChannelData(0).slice()
  }
  else {
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    const rendered = await offline.startRendering()
    audioFloat32 = rendered.getChannelData(0).slice()
  }

  const text = await handle.transcribe(audioFloat32, language, signal)
  return { text }
}

export function createWhisperLocalProvider(config: Record<string, unknown>): TranscriptionProviderWithExtraOptions<string, WhisperLocalExtraOptions> & { dispose?: () => Promise<void> } {
  const configuredModel = (config.modelId as string) || DEFAULT_MODEL_ID
  const configuredLanguage = (config.language as string) || 'en'

  return {
    transcription: (model: string, extraOptions?: WhisperLocalExtraOptions) => {
      const modelId = model || extraOptions?.modelId || configuredModel
      const language = extraOptions?.language || configuredLanguage

      return {
        baseURL: 'about:blank',
        model: modelId,
        fetch: async (_request: RequestInfo | URL, init?: RequestInit) => {
          const body = init?.body
          let file: Blob | null = null
          if (body instanceof FormData) {
            const entry = body.get('file')
            if (entry instanceof Blob)
              file = entry
          }
          else if (body instanceof Blob) {
            file = body
          }

          if (!file)
            throw new Error('whisper-local: no audio file provided in request body')

          const { text } = await transcribeFileViaWorker(file, modelId, language, extraOptions?.abortSignal)
          return new Response(JSON.stringify({ text }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }) as unknown as Response
        },
      }
    },
    dispose: async () => disposeWhisperLocalProvider(),
  }
}

interface RingBuffer {
  push: (frame: Float32Array) => void
  drain: () => Float32Array[]
  reset: () => void
}

function createRingBuffer(capacity: number): RingBuffer {
  const items: Float32Array[] = []
  return {
    push(frame) {
      items.push(frame)
      if (items.length > capacity)
        items.shift()
    },
    drain() {
      const out = items.slice()
      items.length = 0
      return out
    },
    reset() {
      items.length = 0
    },
  }
}

function rms(frame: Float32Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++)
    sum += frame[i] * frame[i]
  return Math.sqrt(sum / frame.length)
}

function concatFrames(frames: Float32Array[]): Float32Array {
  let total = 0
  for (const f of frames) total += f.length
  const out = new Float32Array(total)
  let offset = 0
  for (const f of frames) {
    out.set(f, offset)
    offset += f.length
  }
  return out
}

/**
 * Live-mic streaming path. Captures audio at 16 kHz via the existing VAD
 * AudioWorklet, segments it into utterances using a simple energy-based VAD,
 * and runs each utterance through the Whisper worker. Emits decoded text into
 * `textStream` in the same shape as the Web Speech API provider.
 */
export function streamWhisperLocalTranscription(
  mediaStream: MediaStream,
  options?: WhisperLocalExtraOptions & {
    onSentenceEnd?: (delta: string) => void
    onSpeechEnd?: (text: string) => void
  },
): StreamTranscriptionResult & { stop?: () => Promise<void> } {
  const modelId = options?.modelId || DEFAULT_MODEL_ID
  const language = options?.language || 'en'
  const abortSignal = options?.abortSignal

  const deferredText = createDeferredText()
  let fullText = ''
  let textStreamCtrl: ReadableStreamDefaultController<string> | undefined
  let fullStreamCtrl: ReadableStreamDefaultController<StreamTranscriptionDelta> | undefined

  const fullStream = new ReadableStream<StreamTranscriptionDelta>({
    start(controller) { fullStreamCtrl = controller },
  })

  const textStream = new ReadableStream<string>({
    start(controller) { textStreamCtrl = controller },
  })

  let audioContext: AudioContext | null = null
  let workletNode: AudioWorkletNode | null = null
  let mediaSource: MediaStreamAudioSourceNode | null = null
  let stopped = false
  const preRoll = createRingBuffer(PRE_ROLL_FRAMES)
  let activeFrames: Float32Array[] = []
  let inSpeech = false
  let silenceFrames = 0
  let pendingSpeechFrames = 0
  let voicedFrameCount = 0

  const handle = getWorker(modelId)

  const stop = async (err?: unknown) => {
    if (stopped)
      return
    stopped = true
    try { workletNode?.disconnect() }
    catch {}
    try { mediaSource?.disconnect() }
    catch {}
    try { await audioContext?.close() }
    catch {}

    if (err) {
      textStreamCtrl?.error(err)
      fullStreamCtrl?.error(err)
      if (!deferredText.isResolved && !deferredText.isRejected)
        deferredText.reject(err)
    }
    else {
      textStreamCtrl?.close()
      fullStreamCtrl?.close()
      if (!deferredText.isResolved && !deferredText.isRejected) {
        deferredText.resolve(fullText)
        options?.onSpeechEnd?.(fullText)
      }
    }
  }

  if (abortSignal) {
    if (abortSignal.aborted) {
      stop(abortSignal.reason instanceof Error ? abortSignal.reason : new DOMException('Aborted', 'AbortError'))
      return { fullStream, text: deferredText.promise, textStream, stop }
    }
    abortSignal.addEventListener('abort', () => {
      stop(abortSignal.reason instanceof Error ? abortSignal.reason : new DOMException('Aborted', 'AbortError'))
    })
  }

  // NOTICE: utterance dispatch runs sequentially — we serialize into a single
  // chain so two utterances cannot be transcribed in parallel on the same
  // worker (the worker only holds one pipeline at a time).
  let dispatchChain: Promise<void> = Promise.resolve()

  function dispatchUtterance(frames: Float32Array[], voicedCount: number) {
    if (voicedCount < MIN_UTTERANCE_FRAMES)
      return

    const audio = concatFrames(frames)
    dispatchChain = dispatchChain.then(async () => {
      try {
        await handle.ready
        if (stopped)
          return
        const text = await handle.transcribe(audio, language, abortSignal)
        const trimmed = text.trim()
        if (looksLikeWhisperHallucination(trimmed))
          return
        fullText += (fullText ? ' ' : '') + trimmed
        textStreamCtrl?.enqueue(trimmed)
        fullStreamCtrl?.enqueue({ type: 'transcript.text.delta', delta: trimmed })
        options?.onSentenceEnd?.(trimmed)
      }
      catch (err) {
        if (err instanceof InferenceAbortError || (err instanceof DOMException && err.name === 'AbortError'))
          return
        console.error('[whisper-local] transcription failed:', err)
      }
    })
  }

  function processFrame(frame: Float32Array) {
    const energy = rms(frame)
    const isSpeech = energy >= SILENCE_RMS_THRESHOLD

    if (!inSpeech) {
      preRoll.push(frame)
      if (isSpeech) {
        pendingSpeechFrames++
        if (pendingSpeechFrames >= SPEECH_ENTRY_FRAMES) {
          inSpeech = true
          silenceFrames = 0
          activeFrames = preRoll.drain()
          // The recent consecutive voiced frames (already in activeFrames via
          // preRoll) are what cleared the entry threshold.
          voicedFrameCount = pendingSpeechFrames
          pendingSpeechFrames = 0
        }
      }
      else {
        pendingSpeechFrames = 0
      }
    }
    else {
      activeFrames.push(frame)
      if (isSpeech) {
        silenceFrames = 0
        voicedFrameCount++
      }
      else {
        silenceFrames++
        if (silenceFrames >= SILENCE_FRAMES_TO_END || activeFrames.length >= MAX_UTTERANCE_FRAMES) {
          const utterance = activeFrames
          const voiced = voicedFrameCount
          activeFrames = []
          inSpeech = false
          silenceFrames = 0
          voicedFrameCount = 0
          pendingSpeechFrames = 0
          preRoll.reset()
          dispatchUtterance(utterance, voiced)
        }
      }
    }
  }

  ;(async () => {
    try {
      audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE, latencyHint: 'interactive' })
      await audioContext.audioWorklet.addModule(vadWorkletUrl)
      workletNode = new AudioWorkletNode(audioContext, 'vad-audio-worklet-processor')

      workletNode.port.onmessage = ({ data }: MessageEvent<{ buffer?: Float32Array }>) => {
        const buffer = data?.buffer
        if (!buffer || stopped)
          return
        // Clone — the worklet reuses the underlying Float32Array
        processFrame(new Float32Array(buffer))
      }

      mediaSource = audioContext.createMediaStreamSource(mediaStream)
      mediaSource.connect(workletNode)

      // Sink to avoid feedback
      const silentGain = audioContext.createGain()
      silentGain.gain.value = 0
      workletNode.connect(silentGain)
      silentGain.connect(audioContext.destination)

      if (audioContext.state === 'suspended')
        await audioContext.resume()
    }
    catch (err) {
      stop(err)
    }
  })()

  return {
    fullStream,
    text: deferredText.promise,
    textStream,
    stop,
  }
}
