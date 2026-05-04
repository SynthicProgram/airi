export interface WhisperLocalInferenceInput {
  audioFloat32: Float32Array
  language?: string
}

export interface WhisperLocalInferenceOutput {
  text: string[]
}
