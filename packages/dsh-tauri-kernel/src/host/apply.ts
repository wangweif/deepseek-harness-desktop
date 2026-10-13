import type { Config } from './config/options'
import type { HostContext } from './types'
import { PLUGIN_ID } from '../shared/constants'
import { runtime } from './config/runtime'
import { server } from './server'
import { adapter } from './service/adapter'
import { checkpoint } from './service/checkpoint'
import { identity } from './service/identity'
import { model } from './service/model'
import { session } from './service/session'
import { sink } from './service/sink'

export function apply(ctx: HostContext, config: Config = {}): void {
  ctx.effect(async function* () {
    runtime.lifetime = new AbortController()
    yield server(ctx, config)
    yield () => session.dispose()
    yield await identity.register()
    yield await model.register()
    yield await checkpoint.register()
    yield ctx.provide('nativeSessionBridge', { create: session.createInherited, prepare: session.prepare })
    yield ctx.on('agent/pre-step', adapter.admit, { global: true, prepend: true })
    yield ctx.on('agent/request', adapter.request, { global: true, prepend: true })
    yield ctx.on('llm/stream', adapter.capture, { global: true, prepend: true })
    yield ctx.on('tools/pre-execute', sink.admitTool, { global: true, prepend: true })
    yield ctx.on('tools/execute', sink.executeTool, { global: true, prepend: true })
    yield ctx.on('tools/post-execute', sink.finishTool, { global: true, prepend: true })
    yield ctx.on('tools/result', sink.acceptTool, { global: true })
    yield ctx.on('agent/turn-stopping', ({ agent, turn }) => session.finish(agent, turn), { global: true })
    yield ctx.on('session/event', adapter.end, { global: true })
    yield ctx.on('agent/disposed', ({ agent }) => {
      void adapter.remove(agent).catch((error: unknown) => ctx.logger.warn('dsh-tauri-kernel: native session disposal failed', error))
    }, { global: true })
    yield await adapter.register()
    yield () => session.dispose()
  }, `${PLUGIN_ID}: official native adapter`)
}
