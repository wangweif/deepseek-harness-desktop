import type { ImageBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { NativeModelCatalog, NativeTurnOptions } from '../../shared/native-model'

export type { NativeModelCatalog, NativeModelInfo, NativeTurnOptions } from '../../shared/native-model'

export interface NativePermission {
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  approval?: 'ask' | 'never'
}

export interface NativeSessionOpenOptions {
  forkFrom?: string
  permission?: NativePermission
}

export interface NativeCommand {
  file: string
  args: string[]
  env?: Record<string, string | undefined>
}

/** One official image resolved for a native kernel prompt. */
export interface NativeImageSource {
  mediaType: string
  /** Absolute host path when the mounted provider is host-file-backed. */
  path?: string
  /** Verified base64 bytes, used by kernels that inline the image. */
  base64?: string
}

/** Durable official image reference, as carried by one user-message block. */
export type NativeImageRef = ImageBlock['attachment']

/**
 * Official attachment access for native prompts. `path` is a non-reading host
 * lookup; `read` verifies stored bytes for kernels that must inline the image.
 * Absent when the deployment mounts no image provider.
 */
export interface NativeAttachments {
  path: (ref: NativeImageRef) => string | undefined
  read: (ref: NativeImageRef, signal: AbortSignal) => Promise<NativeImageSource>
}

export type NativeContent
  = | { type: 'text', text: string }
    | { type: 'thinking', text: string }
    | { type: 'tool-call', id: string, name: string, arguments: string }

export interface NativeQuestion {
  id: string
  question: string
  options?: { label: string, description?: string }[]
  multiSelect?: boolean
}

export interface NativeSink {
  text: (id: string, delta: string) => void
  thinking: (id: string, delta: string) => void
  assistant: (id: string, content: readonly NativeContent[]) => void
  toolStart: (id: string, name: string, arguments_: string) => void
  toolEnd: (id: string, output: string, error?: boolean) => void
  approval: (
    id: string,
    request: { kind: 'command' | 'file' | 'tool', title: string, details: string },
    signal?: AbortSignal,
  ) => Promise<boolean>
  questions: (id: string, questions: NativeQuestion[], signal?: AbortSignal) => Promise<Record<string, string | string[]>>
}

export interface NativeSession {
  readonly id: string
  models?: (signal: AbortSignal) => Promise<NativeModelCatalog>
  submit: (messages: readonly UserMessage[], signal: AbortSignal, options?: NativeTurnOptions, permission?: NativePermission) => Promise<void>
  dispose: () => Promise<void>
}
