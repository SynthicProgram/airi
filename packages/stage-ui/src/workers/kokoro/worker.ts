/**
 * Kokoro TTS Web Worker Entry Point
 *
 * Uses the unified inference protocol from protocol.ts.
 * Domain-specific messages (getVoices) are handled via RunInferenceRequest.
 */

import type {
  ErrorResponse,
  InferenceResultResponse,
  LoadModelRequest,
  ModelReadyResponse,
  ProgressResponse,
  RunInferenceRequest,
  WorkerInboundMessage,
} from '../../libs/inference/protocol'
import type { VoiceKey, Voices } from './types'

import { KokoroTTS } from 'kokoro-js'
// @ts-expect-error — soundtouchjs ships without type declarations
import { SoundTouch } from 'soundtouchjs'

import { MODEL_IDS, MODEL_NAMES } from '../../libs/inference/constants'
import { classifyError, isRecoverable } from '../../libs/inference/protocol'

// ---------------------------------------------------------------------------
// Inference-specific input/output types
// ---------------------------------------------------------------------------

export interface KokoroGenerateInput {
  action: 'generate'
  text: string
  voice: VoiceKey
  // -100..+100 (UI percent). Mapped linearly to ±12 semitones. Applied as DSP
  // post-processing because kokoro-js has no native pitch parameter.
  pitch?: number
  // kokoro-js native speed multiplier (1 = normal). Honored by the model itself.
  speed?: number
}

export interface KokoroGetVoicesInput {
  action: 'getVoices'
}

export type KokoroInferenceInput = KokoroGenerateInput | KokoroGetVoicesInput

export interface KokoroGenerateOutput {
  action: 'generate'
  samples: Float32Array
  samplingRate: number
}

export interface KokoroVoicesOutput {
  action: 'getVoices'
  voices: Voices
}

export type KokoroInferenceOutput = KokoroGenerateOutput | KokoroVoicesOutput

// ---------------------------------------------------------------------------
// Pitch shift (DSP)
// ---------------------------------------------------------------------------

// kokoro-js has no native pitch parameter, so we post-process its mono PCM
// output through soundtouchjs (TDHS overlap-add) to shift pitch while
// preserving duration. Mapping: pitchPercent * 12 / 100 → semitones, so the
// -100..+100 slider covers ±1 octave symmetrically.
//
// We drive SoundTouch directly instead of via SimpleFilter: SimpleFilter holds
// the last 22050 output frames as a seek-history window, so a forward-only
// consumer never gets the tail (cut-off at low pitch) and stale history reads
// produce echo/choppiness at high pitch.
function shiftPitchSemitones(samples: Float32Array, semitones: number): Float32Array {
  const numFrames = samples.length

  // Up-mix mono Float32 to stereo interleaved (soundtouchjs is stereo-only).
  const stereo = new Float32Array(numFrames * 2)
  for (let i = 0; i < numFrames; i++) {
    stereo[i * 2] = samples[i]
    stereo[i * 2 + 1] = samples[i]
  }

  const st = new SoundTouch()
  st.pitchSemitones = semitones

  const collected: Float32Array[] = []

  function drain(): void {
    while (st.outputBuffer.frameCount > 0) {
      const have = st.outputBuffer.frameCount
      const buf = new Float32Array(have * 2)
      st.outputBuffer.receiveSamples(buf, have)
      const mono = new Float32Array(have)
      for (let i = 0; i < have; i++)
        mono[i] = buf[i * 2]
      collected.push(mono)
    }
  }

  // Push input in chunks, processing incrementally so the inputBuffer never
  // grows huge for long clips.
  const CHUNK = 4096
  for (let pos = 0; pos < numFrames; pos += CHUNK) {
    const len = Math.min(CHUNK, numFrames - pos)
    st.inputBuffer.putSamples(stereo, pos, len)
    st.process()
    drain()
  }

  // Stretch.process() only emits when inputBuffer >= sampleReq frames, so any
  // residual real samples below that threshold are stranded. Pad with silence
  // to push the residual past the threshold, then trim the trailing silence
  // off the output (pitch shift preserves duration → output length == input).
  const FLUSH = 16384
  const silence = new Float32Array(FLUSH * 2)
  st.inputBuffer.putSamples(silence, 0, FLUSH)
  st.process()
  drain()

  let total = 0
  for (const c of collected) total += c.length
  const out = new Float32Array(total)
  let offset = 0
  for (const c of collected) {
    out.set(c, offset)
    offset += c.length
  }
  return out.length > numFrames ? out.slice(0, numFrames) : out
}

// ---------------------------------------------------------------------------
// Model singleton
// ---------------------------------------------------------------------------

let ttsModel: KokoroTTS | null = null
let currentQuantization: string | null = null
let currentDevice: string | null = null

// NOTICE: Fallback chains for dtype/device when the requested format is
// unsupported at runtime. Tries progressively lower precision before giving up.
const DTYPE_FALLBACK: Record<string, string[]> = {
  fp16: ['fp32', 'q8', 'q4'],
  fp32: ['q8', 'q4'],
  q8: ['q4', 'fp32'],
  q4: ['q4f16', 'fp32'],
  q4f16: ['q4', 'fp32'],
}

const DEVICE_FALLBACK: Record<string, string[]> = {
  webgpu: ['wasm'],
  wasm: [],
  cpu: [],
}

// NOTICE: Cancellation tracking — see Whisper worker for the full rationale.
// We cannot interrupt a transformers.js call synchronously; this set lets us
// drop stale results when they arrive.
const cancelledRequestIds = new Set<string>()

function markCancelled(targetRequestId: string): void {
  cancelledRequestIds.add(targetRequestId)
  const msg: ErrorResponse = {
    type: 'error',
    requestId: targetRequestId,
    payload: {
      code: 'CANCELLED',
      message: 'Operation cancelled by caller',
      recoverable: false,
    },
  }
  globalThis.postMessage(msg)
}

function isCancelled(requestId: string): boolean {
  return cancelledRequestIds.has(requestId)
}

function clearCancelled(requestId: string): void {
  cancelledRequestIds.delete(requestId)
}

function sendError(requestId: string, error: unknown, phase?: 'load' | 'inference'): void {
  const message = error instanceof Error ? error.message : String(error)
  const code = classifyError(error, phase)
  const msg: ErrorResponse = {
    type: 'error',
    requestId,
    payload: {
      code,
      message,
      recoverable: isRecoverable(code),
    },
  }
  globalThis.postMessage(msg)
}

async function loadModel(request: LoadModelRequest): Promise<void> {
  const { requestId, device, dtype } = request
  const quantization = dtype ?? 'fp32'

  try {
    // Check if we already have the correct model loaded
    if (ttsModel && currentQuantization === quantization && currentDevice === device) {
      if (isCancelled(requestId)) {
        clearCancelled(requestId)
        return
      }
      const ready: ModelReadyResponse = {
        type: 'model-ready',
        requestId,
        modelId: MODEL_NAMES.KOKORO,
        device: device as 'webgpu' | 'wasm' | 'cpu',
        metadata: { voices: ttsModel.voices },
      }
      globalThis.postMessage(ready)
      return
    }

    // Map webgpu variants to their base dtype (e.g., 'fp16-webgpu' → 'fp16', 'fp32-webgpu' → 'fp32')
    const modelQuantization = quantization.endsWith('-webgpu')
      ? quantization.slice(0, -'-webgpu'.length)
      : quantization

    // Build ordered list of (dtype, device) pairs to attempt
    const attempts: Array<{ dtype: string, device: string }> = [
      { dtype: modelQuantization, device },
    ]
    for (const fallbackDtype of (DTYPE_FALLBACK[modelQuantization] ?? []))
      attempts.push({ dtype: fallbackDtype, device })
    for (const fallbackDevice of (DEVICE_FALLBACK[device] ?? []))
      attempts.push({ dtype: modelQuantization, device: fallbackDevice })

    let lastError: unknown
    for (const attempt of attempts) {
      try {
        ttsModel = await KokoroTTS.from_pretrained(
          MODEL_IDS.KOKORO,
          {
            dtype: attempt.dtype as 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16',
            device: attempt.device as 'wasm' | 'webgpu' | 'cpu',
            progress_callback: (progress: any) => {
              const msg: ProgressResponse = {
                type: 'progress',
                requestId,
                payload: {
                  phase: 'download',
                  // NOTICE: raw.progress from kokoro-js/@huggingface/transformers is already 0-100
                  percent: progress?.progress ?? -1,
                  message: progress?.status,
                  file: progress?.file,
                  loaded: progress?.loaded,
                  total: progress?.total,
                },
              }
              globalThis.postMessage(msg)
            },
          },
        )

        currentQuantization = quantization
        currentDevice = attempt.device

        if (isCancelled(requestId)) {
          clearCancelled(requestId)
          return
        }
        const ready: ModelReadyResponse = {
          type: 'model-ready',
          requestId,
          modelId: MODEL_NAMES.KOKORO,
          device: attempt.device as 'webgpu' | 'wasm' | 'cpu',
          metadata: {
            voices: ttsModel.voices,
            actualDtype: attempt.dtype,
            actualDevice: attempt.device,
          },
        }
        globalThis.postMessage(ready)
        return
      }
      catch (error) {
        lastError = error
        console.warn(
          `[Kokoro Worker] Failed with dtype=${attempt.dtype} device=${attempt.device}, trying next fallback...`,
          error instanceof Error ? error.message : error,
        )
      }
    }

    // All attempts exhausted
    if (isCancelled(requestId))
      clearCancelled(requestId)
    else
      sendError(requestId, lastError ?? new Error('All dtype/device combinations failed'), 'load')
  }
  catch (error) {
    if (isCancelled(requestId))
      clearCancelled(requestId)
    else
      sendError(requestId, error, 'load')
  }
}

async function runInference(request: RunInferenceRequest<KokoroInferenceInput>): Promise<void> {
  const { requestId, input } = request

  try {
    if (input.action === 'getVoices') {
      if (!ttsModel)
        throw new Error('Model not loaded. Send load-model first.')

      if (isCancelled(requestId)) {
        clearCancelled(requestId)
        return
      }

      const result: InferenceResultResponse<KokoroVoicesOutput> = {
        type: 'inference-result',
        requestId,
        output: { action: 'getVoices', voices: ttsModel.voices },
      }
      globalThis.postMessage(result)
      return
    }

    // action === 'generate'
    if (!ttsModel)
      throw new Error('Kokoro TTS generation failed: No model loaded.')

    const { text, voice, pitch, speed } = input
    // kokoro-js ignores undefined options, so spreading raw values is safe.
    const audioResult = await ttsModel.generate(text, { voice, speed })

    if (isCancelled(requestId)) {
      clearCancelled(requestId)
      return
    }

    let samples = audioResult.audio
    if (pitch != null && pitch !== 0)
      samples = shiftPitchSemitones(samples, pitch * 12 / 100)

    // Transfer raw PCM Float32Array directly — avoids WAV blob encode/decode overhead.
    const result: InferenceResultResponse<KokoroGenerateOutput> = {
      type: 'inference-result',
      requestId,
      output: { action: 'generate', samples, samplingRate: audioResult.sampling_rate },
    }
    ;(globalThis as any).postMessage(result, [samples.buffer])
  }
  catch (error) {
    if (isCancelled(requestId))
      clearCancelled(requestId)
    else
      sendError(requestId, error, 'inference')
  }
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

globalThis.addEventListener('message', async (event: MessageEvent<WorkerInboundMessage<KokoroInferenceInput>>) => {
  const message = event.data

  switch (message.type) {
    case 'load-model':
      await loadModel(message)
      break
    case 'run-inference':
      await runInference(message as RunInferenceRequest<KokoroInferenceInput>)
      break
    case 'unload-model':
      ttsModel = null
      currentQuantization = null
      currentDevice = null
      globalThis.postMessage({ type: 'model-unloaded', requestId: message.requestId })
      break
    case 'cancel':
      markCancelled(message.targetRequestId)
      break
    default:
      console.warn('[Kokoro Worker] Unknown message type:', (message as any).type)
  }
})
