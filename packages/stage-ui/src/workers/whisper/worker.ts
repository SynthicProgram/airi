/**
 * Whisper ASR Web Worker entry point.
 *
 * Loads a `@huggingface/transformers` automatic-speech-recognition pipeline
 * for the requested HuggingFace model id and runs it against Float32Array
 * PCM input at 16 kHz. Uses the unified inference protocol from protocol.ts.
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
import type { WhisperLocalInferenceInput, WhisperLocalInferenceOutput } from './types'

import { pipeline } from '@huggingface/transformers'

import { classifyError, isRecoverable } from '../../libs/inference/protocol'

// NOTICE: pipeline()'s return is a discriminated union over every task type and
// surfaces TS2590 when aliased — keep this loosely typed and call it directly.
let asr: any = null
let currentModelId: string | null = null
let currentDevice: string | null = null

const cancelledRequestIds = new Set<string>()

const DEVICE_FALLBACK: Record<string, string[]> = {
  webgpu: ['wasm'],
  wasm: [],
  cpu: [],
}

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
    payload: { code, message, recoverable: isRecoverable(code) },
  }
  globalThis.postMessage(msg)
}

async function loadModel(request: LoadModelRequest): Promise<void> {
  const { requestId, modelId, device } = request

  try {
    if (asr && currentModelId === modelId && currentDevice === device) {
      if (isCancelled(requestId)) {
        clearCancelled(requestId)
        return
      }
      const ready: ModelReadyResponse = {
        type: 'model-ready',
        requestId,
        modelId,
        device: device as 'webgpu' | 'wasm' | 'cpu',
      }
      globalThis.postMessage(ready)
      return
    }

    const attempts: string[] = [device, ...(DEVICE_FALLBACK[device] ?? [])]
    let lastError: unknown
    for (const attempt of attempts) {
      try {
        asr = await pipeline('automatic-speech-recognition', modelId, {
          device: attempt as 'wasm' | 'webgpu' | 'cpu',
          progress_callback: (progress: any) => {
            const msg: ProgressResponse = {
              type: 'progress',
              requestId,
              payload: {
                phase: 'download',
                percent: progress?.progress ?? -1,
                message: progress?.status,
                file: progress?.file,
                loaded: progress?.loaded,
                total: progress?.total,
              },
            }
            globalThis.postMessage(msg)
          },
        })

        currentModelId = modelId
        currentDevice = attempt

        if (isCancelled(requestId)) {
          clearCancelled(requestId)
          return
        }

        const ready: ModelReadyResponse = {
          type: 'model-ready',
          requestId,
          modelId,
          device: attempt as 'webgpu' | 'wasm' | 'cpu',
          metadata: { actualDevice: attempt },
        }
        globalThis.postMessage(ready)
        return
      }
      catch (error) {
        lastError = error
        console.warn(
          `[Whisper Local Worker] Failed with device=${attempt}, trying next fallback...`,
          error instanceof Error ? error.message : error,
        )
      }
    }

    if (isCancelled(requestId))
      clearCancelled(requestId)
    else
      sendError(requestId, lastError ?? new Error('All device fallbacks failed'), 'load')
  }
  catch (error) {
    if (isCancelled(requestId))
      clearCancelled(requestId)
    else
      sendError(requestId, error, 'load')
  }
}

async function runInference(request: RunInferenceRequest<WhisperLocalInferenceInput>): Promise<void> {
  const { requestId, input } = request

  try {
    if (!asr)
      throw new Error('Model not loaded. Send load-model first.')

    const { audioFloat32, language } = input

    const result = await asr(audioFloat32, {
      language: language || undefined,
      task: 'transcribe',
      return_timestamps: false,
    })

    if (isCancelled(requestId)) {
      clearCancelled(requestId)
      return
    }

    const text = Array.isArray(result)
      ? result.map(r => r?.text ?? '').filter(Boolean)
      : [result?.text ?? '']

    const response: InferenceResultResponse<WhisperLocalInferenceOutput> = {
      type: 'inference-result',
      requestId,
      output: { text },
    }
    globalThis.postMessage(response)
  }
  catch (error) {
    if (isCancelled(requestId))
      clearCancelled(requestId)
    else
      sendError(requestId, error, 'inference')
  }
}

globalThis.addEventListener('message', async (event: MessageEvent<WorkerInboundMessage<WhisperLocalInferenceInput>>) => {
  const message = event.data

  switch (message.type) {
    case 'load-model':
      await loadModel(message)
      break
    case 'run-inference':
      await runInference(message as RunInferenceRequest<WhisperLocalInferenceInput>)
      break
    case 'unload-model':
      asr = null
      currentModelId = null
      currentDevice = null
      globalThis.postMessage({ type: 'model-unloaded', requestId: message.requestId })
      break
    case 'cancel':
      markCancelled(message.targetRequestId)
      break
    default:
      console.warn('[Whisper Local Worker] Unknown message type:', (message as any).type)
  }
})
