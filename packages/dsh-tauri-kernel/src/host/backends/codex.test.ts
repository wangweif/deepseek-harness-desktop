import type { Frame } from './process.fixture'
import type { NativeAttachments, NativePermission, NativeSession, NativeSessionOpenOptions } from './types'
import { spawn } from 'node:child_process'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCodexSession } from './codex'
import { createSink, ProcessFixture } from './process.fixture'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

const command = { file: 'C:/fixture/codex.exe', args: [], env: {} }
const sessions: NativeSession[] = []

interface Terminal {
  itemId: string
  processId: string
}

function codexProcess(options: {
  threadId?: string
  model?: string
  modelProvider?: string
  reasoningEffort?: string | null
  config?: Frame
  models?: Frame[]
  catalog?: { config?: Frame, models?: Frame[] }
  terminals?: Terminal[]
  intercept?: (frame: Frame, fixture: ProcessFixture) => boolean
} = {}) {
  const terminals = options.terminals ?? []
  const catalogs: ProcessFixture[] = []
  function process(catalog = false) {
    const source = catalog ? options.catalog ?? options : options
    const fixture = new ProcessFixture((frame) => {
      if (options.intercept?.(frame, fixture))
        return
      switch (frame.method) {
        case 'initialize':
          fixture.send({ id: frame.id, result: { userAgent: 'codex-cli/fixture' } })
          break
        case 'thread/start':
        case 'thread/resume':
        case 'thread/fork':
          fixture.send({ id: frame.id, result: { thread: { id: options.threadId ?? 'thread-1' }, model: options.model, modelProvider: options.modelProvider, reasoningEffort: options.reasoningEffort } })
          break
        case 'config/read':
          fixture.send({ id: frame.id, result: { config: source.config ?? {} } })
          break
        case 'model/list':
          fixture.send({ id: frame.id, result: { data: source.models ?? [], nextCursor: null } })
          break
        case 'thread/backgroundTerminals/list':
          fixture.send({ id: frame.id, result: { data: [...terminals], nextCursor: null } })
          break
        case 'thread/backgroundTerminals/terminate': {
          const params = frame.params as Frame
          const index = terminals.findIndex(terminal => terminal.processId === params.processId)
          if (index >= 0)
            terminals.splice(index, 1)
          fixture.send({ id: frame.id, result: { terminated: index >= 0 } })
          break
        }
        case 'turn/start':
          fixture.send({ id: frame.id, result: { turn: { id: 'turn-1' } } })
          break
        case 'turn/interrupt':
          fixture.send({ id: frame.id, result: {} })
      }
    })
    return fixture
  }
  const fixture = process()
  vi.mocked(spawn).mockImplementation(() => {
    if (vi.mocked(spawn).mock.calls.length === 1)
      return fixture.child
    const catalog = process(true)
    catalogs.push(catalog)
    return catalog.child
  })
  return { fixture, catalogs, terminals }
}

async function open(storedId: string | null = null, sink = createSink(), options?: NativeSessionOpenOptions, attachments?: NativeAttachments) {
  const session = await createCodexSession(command, 'C:/fixture/workspace', storedId, sink, new AbortController().signal, options, attachments)
  sessions.push(session)
  return session
}

/** Official image block; the attachment brand is opaque to this package. */
const image = (attachment: { id: string, mediaType: string, bytes: number }) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment } as never] })

const modelInfo = (id: string, levels: string[] = ['low', 'high'], defaultEffort = 'low') => ({ id: `catalog:${id}`, model: id, displayName: `Native ${id}`, description: `${id} description`, supportedReasoningEfforts: levels.map(reasoningEffort => ({ reasoningEffort, description: `${reasoningEffort} reasoning` })), defaultReasoningEffort: defaultEffort, isDefault: false })
const user = () => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'inspect the workspace' }] })
const completed = (fixture: ProcessFixture, status = 'completed') => fixture.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status } } })
const notify = (fixture: ProcessFixture, method: string, params: Frame) => fixture.send({ method, params: { threadId: 'thread-1', turnId: 'turn-1', ...params } })

beforeEach(() => vi.mocked(spawn).mockReset())
afterEach(async () => {
  for (const session of sessions.splice(0))
    await session.dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('codex native app-server contract', () => {
  it('creates one native thread without a prompt or DSH tool injection', async () => {
    const { fixture } = codexProcess()
    const session = await open()
    expect(session.id).toBe('thread-1')
    expect(spawn).toHaveBeenCalledWith('C:/fixture/codex.exe', ['app-server', '--listen', 'stdio://'], {
      cwd: 'C:/fixture/workspace',
      env: {},
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    expect(fixture.frames.map(frame => frame.method)).toEqual(['initialize', 'initialized', 'thread/start', 'thread/backgroundTerminals/list'])
    expect(fixture.frames[2]).toEqual({ id: 2, method: 'thread/start', params: { cwd: 'C:/fixture/workspace' } })
  })

  describe.each(['start', 'resume', 'fork'] as const)('thread/%s permissions', (mode) => {
    it.each((['read-only', 'workspace-write', 'danger-full-access'] as const).flatMap(sandbox => (['ask', 'never'] as const).map(approval => ({ sandbox, approval }))))('sends SandboxMode $sandbox and approval $approval on the native wire', async (permission) => {
      const { fixture } = codexProcess()
      await open(mode === 'resume' ? 'thread-1' : null, createSink(), { ...mode === 'fork' ? { forkFrom: 'source-thread' } : {}, permission })
      expect(fixture.frames[2]).toEqual({ id: 2, method: `thread/${mode}`, params: {
        ...mode === 'start' ? {} : { threadId: mode === 'resume' ? 'thread-1' : 'source-thread' },
        cwd: 'C:/fixture/workspace',
        approvalPolicy: permission.approval === 'ask' ? 'on-request' : 'never',
        sandbox: permission.sandbox,
      } })
    })
  })

  it.each(['start', 'resume', 'fork'] as const)('applies each permission switch to the next turn of the cached %s thread', async (mode) => {
    const { fixture } = codexProcess()
    const session = await open(mode === 'resume' ? 'thread-1' : null, createSink(), { ...mode === 'fork' ? { forkFrom: 'source-thread' } : {}, permission: { sandbox: 'read-only', approval: 'ask' } })
    const permissions: { permission: NativePermission, approvalPolicy: string, sandboxPolicy: Frame }[] = [
      { permission: { sandbox: 'read-only', approval: 'ask' }, approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } },
      { permission: { sandbox: 'danger-full-access', approval: 'never' }, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } },
      { permission: { sandbox: 'danger-full-access', approval: 'ask' }, approvalPolicy: 'on-request', sandboxPolicy: { type: 'dangerFullAccess' } },
      { permission: { sandbox: 'workspace-write', approval: 'never' }, approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['C:/fixture/workspace'], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } },
      { permission: { sandbox: 'workspace-write', approval: 'ask' }, approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['C:/fixture/workspace'], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } },
      { permission: { sandbox: 'read-only', approval: 'never' }, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } },
    ]
    for (const { permission, approvalPolicy, sandboxPolicy } of permissions) {
      const started = fixture.next(frame => frame.method === 'turn/start')
      const submitted = session.submit([user()], new AbortController().signal, undefined, permission)
      const request = await started
      completed(fixture)
      await submitted
      expect(request.params).toEqual({ threadId: 'thread-1', input: [{ type: 'text', text: 'inspect the workspace', text_elements: [] }], approvalPolicy, sandboxPolicy })
    }
    expect(fixture.frames.filter(frame => frame.method === `thread/${mode}`)).toHaveLength(1)
    expect(fixture.frames.filter(frame => frame.method === 'turn/start')).toHaveLength(permissions.length)
    expect(spawn).toHaveBeenCalledOnce()
    expect(session.id).toBe('thread-1')
  })

  it.each([
    { permission: { approval: 'never' } as NativePermission, policy: { approvalPolicy: 'never' } },
    { permission: { sandbox: 'read-only' } as NativePermission, policy: { sandboxPolicy: { type: 'readOnly', networkAccess: false } } },
  ])('leaves missing permission fields to the native defaults: $permission', async ({ permission, policy }) => {
    const { fixture } = codexProcess()
    const session = await open(null, createSink(), { permission })
    expect(fixture.frames[2]?.params).toEqual({ cwd: 'C:/fixture/workspace', ...permission.approval ? { approvalPolicy: 'never' } : {}, ...permission.sandbox ? { sandbox: 'read-only' } : {} })
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal, undefined, permission)
    const request = await started
    completed(fixture)
    await submitted
    expect(request.params).toEqual({ threadId: 'thread-1', input: [{ type: 'text', text: 'inspect the workspace', text_elements: [] }], ...policy })
  })

  it('snapshots permission before waiting for native turn preparation', async () => {
    const { fixture } = codexProcess()
    const session = await open()
    const permission: NativePermission = { sandbox: 'danger-full-access', approval: 'never' }
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal, undefined, permission)
    permission.sandbox = 'read-only'
    permission.approval = 'ask'
    const request = await started
    completed(fixture)
    await submitted
    expect(request.params).toEqual({ threadId: 'thread-1', input: [{ type: 'text', text: 'inspect the workspace', text_elements: [] }], approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } })
  })

  it('never autoapproves a native request under never plus read-only', async () => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const permission: NativePermission = { sandbox: 'read-only', approval: 'never' }
    const session = await open(null, sink, { permission })
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal, undefined, permission)
    await started
    const answered = fixture.next(frame => frame.id === 'readonly-approval')
    fixture.send({ id: 'readonly-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'write-outside', command: 'write outside workspace' } })
    const response = await answered
    completed(fixture)
    await submitted
    expect(response).toEqual({ id: 'readonly-approval', result: { decision: 'decline' } })
    expect(sink.approval).toHaveBeenCalledOnce()
  })

  it('resumes exactly the stored native thread without starting a replacement', async () => {
    const { fixture } = codexProcess({ threadId: 'stored-thread' })
    const session = await open('stored-thread')
    expect(session.id).toBe('stored-thread')
    expect(fixture.frames[2]).toEqual({ id: 2, method: 'thread/resume', params: { threadId: 'stored-thread', cwd: 'C:/fixture/workspace' } })
    expect(fixture.frames.some(frame => frame.method === 'thread/start')).toBe(false)
  })

  it('refuses a changed resume id instead of silently binding a new thread', async () => {
    const { fixture } = codexProcess({ threadId: 'different-thread' })
    await expect(open('stored-thread')).rejects.toMatchObject({ code: 'BRIDGE_RESUME_MISMATCH' })
    expect(fixture.frames.map(frame => frame.method)).toEqual(['initialize', 'initialized', 'thread/resume'])
    expect(fixture.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('refuses an unavailable background cleanup capability before any native input', async () => {
    const { fixture } = codexProcess({ intercept: (frame, child) => {
      if (frame.method !== 'thread/backgroundTerminals/list')
        return false
      child.send({ id: frame.id, error: { code: -32601, message: 'Unknown method' } })
      return true
    } })
    await expect(open()).rejects.toMatchObject({ code: 'BRIDGE_NATIVE_REQUEST', message: 'Unknown method' })
    expect(fixture.frames.some(frame => frame.method === 'turn/start')).toBe(false)
    expect(fixture.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('forks into a newly acknowledged thread with the new cwd and no prompt fallback', async () => {
    const { fixture } = codexProcess({ threadId: 'child-thread' })
    const session = await open(null, createSink(), { forkFrom: 'source-thread' })
    expect(session.id).toBe('child-thread')
    expect(fixture.frames[2]).toEqual({ id: 2, method: 'thread/fork', params: { threadId: 'source-thread', cwd: 'C:/fixture/workspace' } })
    expect(fixture.frames.some(frame => frame.method === 'thread/start' || frame.method === 'thread/resume' || frame.method === 'turn/start')).toBe(false)
  })

  it('rejects a fork returning the source identity without starting a replacement', async () => {
    const { fixture } = codexProcess({ threadId: 'source-thread' })
    await expect(open(null, createSink(), { forkFrom: 'source-thread' })).rejects.toMatchObject({ code: 'BRIDGE_FORK_MISMATCH' })
    expect(fixture.frames.map(frame => frame.method)).toEqual(['initialize', 'initialized', 'thread/fork'])
    expect(fixture.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('rejects ambiguous resume and fork options before spawning', async () => {
    await expect(open('stored-thread', createSink(), { forkFrom: 'source-thread' })).rejects.toMatchObject({ code: 'BRIDGE_FORK_INVALID' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reads each model directory from a fresh app-server without replacing the native thread', async () => {
    const options = {
      model: 'fixture-alpha',
      reasoningEffort: 'high',
      config: { model: 'fixture-alpha' },
      models: [modelInfo('old-gpt')],
      catalog: { config: { model: 'fixture-alpha', model_reasoning_effort: 'high' }, models: [modelInfo('fixture-alpha'), modelInfo('fixture-beta')] },
    }
    const { fixture, catalogs } = codexProcess(options)
    const session = await open()
    const initialFrames = [...fixture.frames]
    const directory = await session.models!(new AbortController().signal)
    expect(directory.models.map(model => model.id)).toEqual(['fixture-alpha', 'fixture-beta'])
    expect(directory.defaultModel).toBe('fixture-alpha')
    expect(directory.defaultReasoningEffort).toBe('high')
    expect(catalogs).toHaveLength(1)
    expect(catalogs[0]!.frames.map(frame => frame.method)).toEqual(['initialize', 'initialized', 'config/read', 'model/list'])
    expect(catalogs[0]!.frames[0]).toEqual(initialFrames[0])
    expect(catalogs[0]!.stdin.end).toHaveBeenCalledOnce()
    expect(fixture.frames).toEqual(initialFrames)
    expect(fixture.kill).not.toHaveBeenCalled()
    options.catalog.models = [modelInfo('fixture-alpha'), modelInfo('fixture-gamma')]
    expect((await session.models!(new AbortController().signal)).models.map(model => model.id)).toEqual(['fixture-alpha', 'fixture-gamma'])
    expect(catalogs).toHaveLength(2)
    expect(catalogs.every(child => child.stdin.end.mock.calls.length === 1)).toBe(true)
    expect(session.id).toBe('thread-1')
    expect(spawn).toHaveBeenCalledTimes(3)
    expect(fixture.frames).toEqual(initialFrames)
  })

  it('refuses a changed native provider instead of applying its models to the bound thread', async () => {
    const options = {
      model: 'old-model',
      modelProvider: 'old-provider',
      catalog: { config: { model_provider: 'new-provider', model: 'new-model' }, models: [modelInfo('new-model')] },
    }
    const { fixture, catalogs } = codexProcess(options)
    const session = await open()
    await expect(session.models!(new AbortController().signal)).rejects.toMatchObject({ code: 'BRIDGE_PROVIDER_CHANGED' })
    expect(catalogs[0]!.frames.map(frame => frame.method)).toEqual(['initialize', 'initialized', 'config/read'])
    expect(catalogs[0]!.stdin.end).toHaveBeenCalledOnce()
    expect(fixture.kill).not.toHaveBeenCalled()
    expect(session.id).toBe('thread-1')
    options.catalog.config.model_provider = 'old-provider'
    expect((await session.models!(new AbortController().signal)).models.map(model => model.id)).toEqual(['new-model', 'old-model'])
    expect(fixture.frames.filter(frame => frame.method === 'thread/start')).toHaveLength(1)
    expect(fixture.frames.some(frame => frame.method === 'turn/start')).toBe(false)
  })

  it('keeps the effective native default effort distinct from the catalog preset', async () => {
    const { fixture } = codexProcess({ model: 'deepseek', reasoningEffort: 'high', config: { model: 'deepseek', model_reasoning_effort: 'high' }, models: [modelInfo('deepseek', ['low', 'high'], 'low')] })
    const session = await open()
    const catalog = await session.models!(new AbortController().signal)
    expect(catalog.defaultModel).toBe('deepseek')
    expect(catalog.defaultReasoningEffort).toBe('high')
    expect(catalog.models[0]?.reasoning?.defaultEffort).toBe('low')
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal, { model: null, reasoningEffort: null })
    expect((await started).params).toEqual({ threadId: 'thread-1', input: [{ type: 'text', text: 'inspect the workspace', text_elements: [] }] })
    completed(fixture)
    await submitted
    expect(session.id).toBe('thread-1')
  })

  it('closes a failed catalog reader without closing the bound thread and can retry', async () => {
    let fail = true
    const { fixture, catalogs } = codexProcess({ model: 'baseline', intercept: (frame, child) => {
      if (frame.method !== 'model/list' || !fail)
        return false
      child.send({ id: frame.id, error: { code: -32601, message: 'Catalog is unavailable' } })
      return true
    } })
    const session = await open()
    await expect(session.models!(new AbortController().signal)).rejects.toMatchObject({ code: 'BRIDGE_NATIVE_REQUEST', message: 'Catalog is unavailable' })
    expect(catalogs).toHaveLength(1)
    expect(catalogs[0]!.stdin.end).toHaveBeenCalledOnce()
    expect(fixture.kill).not.toHaveBeenCalled()
    fail = false
    expect((await session.models!(new AbortController().signal)).defaultModel).toBe('baseline')
    expect(catalogs).toHaveLength(2)
    expect(session.id).toBe('thread-1')
    expect(fixture.frames.filter(frame => frame.method === 'thread/start')).toHaveLength(1)
    expect(fixture.frames.some(frame => frame.method === 'turn/start')).toBe(false)
  })

  it('cancels a catalog reader before any native input without closing the thread', async () => {
    const { fixture, catalogs } = codexProcess({ intercept: frame => frame.method === 'config/read' })
    const session = await open()
    const controller = new AbortController()
    const listed = session.models!(controller.signal)
    const rejected = expect(listed).rejects.toThrow('cancel catalog')
    await vi.waitFor(() => expect(catalogs[0]?.frames.map(frame => frame.method)).toEqual(['initialize', 'initialized', 'config/read']))
    controller.abort(new Error('cancel catalog'))
    await rejected
    expect(catalogs[0]!.stdin.end).toHaveBeenCalledOnce()
    expect(fixture.kill).not.toHaveBeenCalled()
    expect(fixture.frames.some(frame => frame.method === 'turn/start')).toBe(false)
    expect(session.id).toBe('thread-1')
  })

  it('disposes every pending catalog reader with its native session', async () => {
    const { fixture, catalogs } = codexProcess({ intercept: frame => frame.method === 'config/read' })
    const session = await open()
    const listed = session.models!(new AbortController().signal)
    const rejected = expect(listed).rejects.toMatchObject({ code: 'BRIDGE_PROCESS_CLOSED' })
    await vi.waitFor(() => expect(catalogs[0]?.frames.map(frame => frame.method)).toEqual(['initialize', 'initialized', 'config/read']))
    await session.dispose()
    await rejected
    expect(catalogs[0]!.kill).toHaveBeenCalledWith('SIGTERM')
    expect(fixture.kill).toHaveBeenCalledWith('SIGTERM')
    expect(fixture.frames.some(frame => frame.method === 'turn/start')).toBe(false)
    expect(session.id).toBe('thread-1')
  })

  it.each(['abort', 'dispose'] as const)('does not publish a catalog %s during its graceful close', async (mode) => {
    const { fixture, catalogs } = codexProcess({ models: [modelInfo('chosen')], intercept: (frame, child) => {
      if (frame.method === 'model/list')
        child.stdin.end.mockImplementationOnce(() => {})
      return false
    } })
    const session = await open()
    const controller = new AbortController()
    const listed = session.models!(controller.signal)
    const rejected = mode === 'abort' ? expect(listed).rejects.toThrow('cancel while closing') : expect(listed).rejects.toMatchObject({ code: 'BRIDGE_PROCESS_CLOSED' })
    await vi.waitFor(() => expect(catalogs[0]?.stdin.end).toHaveBeenCalledOnce())
    const disposing = mode === 'dispose' ? session.dispose() : undefined
    if (mode === 'abort')
      controller.abort(new Error('cancel while closing'))
    catalogs[0]!.exit(0)
    await disposing
    await rejected
    expect(fixture.frames.filter(frame => frame.method === 'thread/start')).toHaveLength(1)
    expect(fixture.frames.some(frame => frame.method === 'turn/start')).toBe(false)
  })

  it('keeps the session usable when a reader close is interrupted', async () => {
    let hold = true
    const { fixture, catalogs } = codexProcess({ config: { model: 'chosen', model_reasoning_effort: 'low' }, models: [modelInfo('chosen')], intercept: (frame, child) => {
      if (frame.method === 'model/list' && hold)
        child.stdin.end.mockImplementationOnce(() => {})
      return false
    } })
    const session = await open()
    const listed = session.models!(new AbortController().signal)
    await vi.waitFor(() => expect(catalogs[0]?.stdin.end).toHaveBeenCalledOnce(), { timeout: 20_000 })
    hold = false
    catalogs[0]!.exit(0)
    expect((await listed).defaultModel).toBe('chosen')
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal, { model: 'chosen', reasoningEffort: 'low' })
    expect((await Promise.race([started, submitted]))?.params).toMatchObject({ model: 'chosen', effort: 'low' })
    completed(fixture)
    await submitted
    await session.dispose()
    expect(fixture.frames.filter(frame => frame.method === 'thread/start')).toHaveLength(1)
  })

  it('disposal survives a thread that refuses to terminate', async () => {
    const { fixture } = codexProcess()
    const session = await open()
    fixture.stdin.end.mockImplementationOnce(() => {})
    fixture.kill.mockImplementation(() => true)
    vi.useFakeTimers()
    const disposing = session.dispose()
    await vi.advanceTimersByTimeAsync(20_000)
    await disposing
    expect(fixture.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('keeps the newest successful catalog when an earlier reader closes late', async () => {
    let hold = true
    const options = { catalog: { config: { model: 'old', model_reasoning_effort: 'low' }, models: [modelInfo('old')] }, intercept: (frame: Frame, child: ProcessFixture) => {
      if (frame.method === 'model/list' && hold)
        child.stdin.end.mockImplementationOnce(() => {})
      return false
    } }
    const { fixture, catalogs } = codexProcess(options)
    const session = await open()
    const earlier = session.models!(new AbortController().signal)
    await vi.waitFor(() => expect(catalogs[0]?.stdin.end).toHaveBeenCalledOnce())
    hold = false
    options.catalog = { config: { model: 'new', model_reasoning_effort: 'high' }, models: [modelInfo('new')] }
    const latest = await session.models!(new AbortController().signal)
    catalogs[0]!.exit(0)
    expect((await earlier).defaultModel).toBe('old')
    expect(latest.defaultModel).toBe('new')
    expect(latest.defaultReasoningEffort).toBe('high')
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal, { model: 'new', reasoningEffort: 'high' })
    expect((await Promise.race([started, submitted]))?.params).toMatchObject({ model: 'new', effort: 'high' })
    completed(fixture)
    await submitted
    expect(catalogs).toHaveLength(2)
    expect(session.id).toBe('thread-1')
  })

  it('bounds the complete catalog operation across consecutive native requests', async () => {
    let delayed = false
    const { fixture, catalogs } = codexProcess({ intercept: frame => delayed && (frame.method === 'initialize' || frame.method === 'config/read') })
    const session = await open()
    delayed = true
    vi.useFakeTimers()
    const resolved = vi.fn()
    const rejected = vi.fn()
    const listed = session.models!(new AbortController().signal).then(resolved, rejected)
    await vi.advanceTimersByTimeAsync(30_000)
    catalogs[0]!.send({ id: catalogs[0]!.frames[0]!.id, result: { userAgent: 'codex-cli/fixture' } })
    await vi.advanceTimersByTimeAsync(29_999)
    expect(catalogs[0]!.frames.map(frame => frame.method)).toEqual(['initialize', 'initialized', 'config/read'])
    expect(rejected).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(rejected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'BRIDGE_REQUEST_TIMEOUT', message: 'Codex model discovery timed out' }))
    expect(resolved).not.toHaveBeenCalled()
    await listed
    expect(catalogs[0]!.stdin.end).toHaveBeenCalledOnce()
    expect(fixture.kill).not.toHaveBeenCalled()
    expect(fixture.frames.some(frame => frame.method === 'turn/start')).toBe(false)
  })

  it('bounds empty catalog pages even when every cursor is distinct', async () => {
    let pages = 0
    const { fixture, catalogs } = codexProcess({ intercept: (frame, child) => {
      if (frame.method !== 'model/list')
        return false
      pages++
      child.send({ id: frame.id, result: { data: [], nextCursor: pages <= 100 ? `cursor-${pages}` : null } })
      return true
    } })
    const session = await open()
    await expect(session.models!(new AbortController().signal)).rejects.toMatchObject({ code: 'BRIDGE_PROTOCOL_LIMIT' })
    expect(pages).toBe(100)
    expect(catalogs[0]!.stdin.end).toHaveBeenCalledOnce()
    expect(fixture.frames.some(frame => frame.method === 'turn/start')).toBe(false)
  })

  it('keeps a custom-provider configured model without inventing reasoning capabilities or exposing config', async () => {
    const { fixture, catalogs } = codexProcess({
      model: 'deepseek-flash',
      config: { model: 'deepseek-flash', model_provider: 'deepseek', model_reasoning_effort: null, auth: { token: 'secret-fixture' }, model_providers: { deepseek: { api_key: 'secret-fixture' } } },
      models: [modelInfo('gpt-fixture')],
    })
    const session = await open()
    const catalog = await session.models!(new AbortController().signal)
    expect(catalog.defaultModel).toBe('deepseek-flash')
    expect(catalog.models.find(model => model.id === 'deepseek-flash')).toEqual({ id: 'deepseek-flash', name: 'deepseek-flash' })
    expect(JSON.stringify(catalog)).not.toContain('secret-fixture')
    expect(catalogs[0]!.frames.filter(frame => frame.method === 'config/read').map(frame => frame.params)).toEqual([{ includeLayers: false, cwd: 'C:/fixture/workspace' }])
    expect(catalogs[0]!.frames.filter(frame => frame.method === 'model/list').map(frame => frame.params)).toEqual([{ cursor: null, limit: 100, includeHidden: false }])
    expect(fixture.frames.filter(frame => frame.method === 'thread/start')).toHaveLength(1)
    expect(fixture.frames.some(frame => frame.method === 'turn/start')).toBe(false)
  })

  it('preserves official display names and distinct advertised xhigh, max and ultra effort identities', async () => {
    codexProcess({
      model: 'gpt-6.1-sol',
      models: [{
        id: 'gpt-6.1-sol',
        model: 'gpt-6.1-sol',
        displayName: 'GPT-6.1-Sol',
        description: 'Latest workhorse model for coding and everyday work.',
        hidden: false,
        isDefault: true,
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' },
          { reasoningEffort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
          { reasoningEffort: 'high', description: 'Greater reasoning depth for complex problems' },
          { reasoningEffort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
          { reasoningEffort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
          { reasoningEffort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
        ],
        defaultReasoningEffort: 'low',
      }],
    })
    const session = await open()
    const catalog = await session.models!(new AbortController().signal)
    expect(catalog).toEqual({
      defaultModel: 'gpt-6.1-sol',
      models: [{
        id: 'gpt-6.1-sol',
        name: 'GPT-6.1-Sol',
        description: 'Latest workhorse model for coding and everyday work.',
        reasoning: {
          efforts: [
            { id: 'low', name: 'Low', description: 'Fast responses with lighter reasoning' },
            { id: 'medium', name: 'Medium', description: 'Balances speed and reasoning depth for everyday tasks' },
            { id: 'high', name: 'High', description: 'Greater reasoning depth for complex problems' },
            { id: 'xhigh', name: 'Extra High', description: 'Extra high reasoning depth for complex problems' },
            { id: 'max', name: 'Max', description: 'Maximum reasoning depth for the hardest problems' },
            { id: 'ultra', name: 'Ultra', description: 'Maximum reasoning with automatic task delegation' },
          ],
          defaultEffort: 'low',
        },
      }],
    })
  })

  it('labels advertised none as Off without changing vendor-specific reasoning ids', async () => {
    codexProcess({ models: [modelInfo('vendor-model', ['none', 'minimal', 'vendor-deep'], 'none')] })
    const session = await open()
    const catalog = await session.models!(new AbortController().signal)
    expect(catalog.models).toEqual([{
      id: 'vendor-model',
      name: 'Native vendor-model',
      description: 'vendor-model description',
      reasoning: {
        efforts: [
          { id: 'none', name: 'Off', description: 'none reasoning' },
          { id: 'minimal', name: 'Minimal', description: 'minimal reasoning' },
          { id: 'vendor-deep', name: 'vendor-deep', description: 'vendor-deep reasoning' },
        ],
        defaultEffort: 'none',
      },
    }])
  })

  it.each(['none', 'xhigh', 'max', 'ultra'])('submits advertised %s effort unchanged on the Codex wire', async (effort) => {
    const { fixture } = codexProcess({ model: 'chosen', reasoningEffort: 'low', models: [modelInfo('chosen', ['none', 'low', 'xhigh', 'max', 'ultra'])] })
    const session = await open()
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal, { model: 'chosen', reasoningEffort: effort })
    expect(await started).toMatchObject({ params: { model: 'chosen', effort } })
    completed(fixture)
    await submitted
    expect(fixture.frames.filter(frame => frame.method === 'turn/start')).toHaveLength(1)
  })

  it('rejects unadvertised Off before input instead of inferring it from other GPT models', async () => {
    const { fixture } = codexProcess({ model: 'chosen', reasoningEffort: 'low', models: [modelInfo('chosen', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])] })
    const session = await open()
    await expect(session.submit([user()], new AbortController().signal, { model: 'chosen', reasoningEffort: 'none' })).rejects.toMatchObject({ code: 'BRIDGE_EFFORT_UNSUPPORTED' })
    expect(fixture.frames.some(frame => frame.method === 'turn/start')).toBe(false)
  })

  it('paginates native models using wire model ids and rejects repeated cursors', async () => {
    let repeat = false
    const { fixture } = codexProcess({ intercept: (frame, child) => {
      if (frame.method !== 'model/list')
        return false
      const cursor = (frame.params as Frame).cursor
      child.send({ id: frame.id, result: { data: [modelInfo(cursor === null ? 'first' : 'second')], nextCursor: cursor === null || repeat ? 'page-2' : null } })
      return true
    } })
    const session = await open()
    expect((await session.models!(new AbortController().signal)).models.map(model => model.id)).toEqual(['first', 'second'])
    repeat = true
    await expect(session.models!(new AbortController().signal)).rejects.toMatchObject({ code: 'BRIDGE_PROTOCOL', message: 'Codex model listing repeated a cursor' })
    expect(fixture.frames.some(frame => frame.method === 'turn/start')).toBe(false)
  })

  it('reports unsupported model discovery rather than inventing a catalog', async () => {
    const { fixture } = codexProcess({ intercept: (frame, child) => {
      if (frame.method !== 'model/list')
        return false
      child.send({ id: frame.id, error: { code: -32601, message: 'Unknown method: model/list' } })
      return true
    } })
    const session = await open()
    await expect(session.models!(new AbortController().signal)).rejects.toMatchObject({ code: 'BRIDGE_NATIVE_REQUEST', message: 'Unknown method: model/list' })
    expect(fixture.frames.some(frame => frame.method === 'turn/start')).toBe(false)
  })

  it('submits snapshotted model and effort once without changing the native binding', async () => {
    const { fixture } = codexProcess({ model: 'baseline', reasoningEffort: 'low', models: [modelInfo('baseline'), modelInfo('chosen')] })
    const session = await open()
    const selection = { model: 'chosen', reasoningEffort: 'high' }
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal, selection)
    selection.model = 'baseline'
    selection.reasoningEffort = 'low'
    expect(await started).toMatchObject({ params: { threadId: session.id, model: 'chosen', effort: 'high' } })
    completed(fixture)
    await submitted
    expect(fixture.frames.filter(frame => frame.method === 'turn/start')).toHaveLength(1)
    expect(fixture.frames.filter(frame => frame.method === 'thread/start')).toHaveLength(1)
    expect(session.id).toBe('thread-1')
  })

  it('preserves CLI defaults on the first null selection and restores acknowledged defaults after an override', async () => {
    const { fixture } = codexProcess({ model: 'baseline', reasoningEffort: 'low', models: [modelInfo('baseline'), modelInfo('chosen')] })
    const session = await open()
    const signal = new AbortController().signal
    const first = fixture.next(frame => frame.method === 'turn/start')
    const unchanged = session.submit([user()], signal, { model: null, reasoningEffort: null })
    expect((await first).params).toEqual({ threadId: session.id, input: [{ type: 'text', text: 'inspect the workspace', text_elements: [] }] })
    completed(fixture)
    await unchanged
    expect(fixture.frames.some(frame => frame.method === 'config/read' || frame.method === 'model/list')).toBe(false)
    const changed = fixture.next(frame => frame.method === 'turn/start')
    const override = session.submit([user()], signal, { model: 'chosen', reasoningEffort: 'high' })
    await changed
    completed(fixture)
    await override
    const reset = fixture.next(frame => frame.method === 'turn/start')
    const restored = session.submit([user()], signal, { model: null, reasoningEffort: null })
    expect(await reset).toMatchObject({ params: { threadId: session.id, model: 'baseline', effort: 'low' } })
    completed(fixture)
    await restored
  })

  it.each(['resume', 'fork'] as const)('restores thread-agnostic defaults after an explicit override and reset following %s', async (mode) => {
    const { fixture } = codexProcess({
      model: 'persisted-override',
      reasoningEffort: 'high',
      config: { model: 'cli-default', model_reasoning_effort: 'low' },
      models: [modelInfo('cli-default'), modelInfo('persisted-override')],
    })
    const session = await open(mode === 'resume' ? 'thread-1' : null, createSink(), mode === 'fork' ? { forkFrom: 'source-thread' } : undefined)
    const signal = new AbortController().signal
    const first = fixture.next(frame => frame.method === 'turn/start')
    const inherited = session.submit([user()], signal, { model: null, reasoningEffort: null })
    expect((await first).params).toEqual({ threadId: 'thread-1', input: [{ type: 'text', text: 'inspect the workspace', text_elements: [] }] })
    completed(fixture)
    await inherited
    const changed = fixture.next(frame => frame.method === 'turn/start')
    const override = session.submit([user()], signal, { model: 'persisted-override', reasoningEffort: 'high' })
    expect((await changed).params).toMatchObject({ model: 'persisted-override', effort: 'high' })
    completed(fixture)
    await override
    const reset = fixture.next(frame => frame.method === 'turn/start')
    const restored = session.submit([user()], signal, { model: null, reasoningEffort: null })
    expect((await reset).params).toMatchObject({ threadId: 'thread-1', model: 'cli-default', effort: 'low' })
    completed(fixture)
    await restored
    expect((await session.models!(signal)).defaultModel).toBe('cli-default')
    expect(fixture.frames.filter(frame => frame.method === 'turn/start')).toHaveLength(3)
    expect(fixture.frames.some(frame => frame.method === 'thread/start')).toBe(false)
    expect(session.id).toBe('thread-1')
  })

  it('refuses an explicit reset to an unknown resumed CLI default instead of guessing from the catalog', async () => {
    const { fixture } = codexProcess({
      model: 'persisted-override',
      reasoningEffort: 'high',
      models: [{ ...modelInfo('catalog-default'), isDefault: true }],
      intercept: (frame, child) => {
        if (frame.method !== 'turn/start')
          return false
        child.send({ id: frame.id, result: { turn: { id: 'turn-1' } } })
        completed(child)
        return true
      },
    })
    const session = await open('thread-1')
    const signal = new AbortController().signal
    expect((await session.models!(signal)).defaultModel).toBeUndefined()
    await session.submit([user()], signal, { model: 'catalog-default', reasoningEffort: 'high' })
    await expect(session.submit([user()], signal, { model: null, reasoningEffort: null })).rejects.toMatchObject({ code: 'BRIDGE_DEFAULT_UNAVAILABLE' })
    expect(fixture.frames.filter(frame => frame.method === 'turn/start')).toHaveLength(1)
  })

  it('refuses an explicit resumed effort reset when only the persisted override is known', async () => {
    const { fixture } = codexProcess({
      model: 'persisted-override',
      reasoningEffort: 'high',
      config: { model: 'custom-default', model_reasoning_effort: null },
      models: [modelInfo('persisted-override')],
      intercept: (frame, child) => {
        if (frame.method !== 'turn/start')
          return false
        child.send({ id: frame.id, result: { turn: { id: 'turn-1' } } })
        completed(child)
        return true
      },
    })
    const session = await open('thread-1')
    const signal = new AbortController().signal
    await session.submit([user()], signal, { model: 'persisted-override', reasoningEffort: 'high' })
    await expect(session.submit([user()], signal, { model: null, reasoningEffort: null })).rejects.toMatchObject({ code: 'BRIDGE_DEFAULT_UNAVAILABLE' })
    expect(fixture.frames.filter(frame => frame.method === 'turn/start')).toHaveLength(1)
    expect(session.id).toBe('thread-1')
  })

  it('uses only the selected model advertised default effort when changing models', async () => {
    const { fixture } = codexProcess({ model: 'baseline', reasoningEffort: 'high', models: [modelInfo('baseline'), modelInfo('chosen', ['medium', 'high'], 'medium')] })
    const session = await open()
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal, { model: 'chosen', reasoningEffort: null })
    expect(await started).toMatchObject({ params: { model: 'chosen', effort: 'medium' } })
    completed(fixture)
    await submitted
  })

  it('rejects unsupported effort before native input and keeps the binding intact', async () => {
    const { fixture } = codexProcess({ model: 'deepseek-flash', config: { model: 'deepseek-flash' }, models: [modelInfo('gpt-fixture')] })
    const session = await open()
    await expect(session.submit([user()], new AbortController().signal, { model: 'deepseek-flash', reasoningEffort: 'high' })).rejects.toMatchObject({ code: 'BRIDGE_EFFORT_UNSUPPORTED' })
    expect(fixture.frames.some(frame => frame.method === 'turn/start')).toBe(false)
    expect(session.id).toBe('thread-1')
  })

  it('refuses an unknown effort reset instead of silently retaining a previous explicit effort', async () => {
    const { fixture } = codexProcess({ model: 'custom', reasoningEffort: null, models: [modelInfo('chosen')] })
    const session = await open()
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal, { model: 'chosen', reasoningEffort: 'high' })
    await started
    completed(fixture)
    await submitted
    await expect(session.submit([user()], new AbortController().signal, { model: null, reasoningEffort: null })).rejects.toMatchObject({ code: 'BRIDGE_DEFAULT_UNAVAILABLE' })
    expect(fixture.frames.filter(frame => frame.method === 'turn/start')).toHaveLength(1)
  })

  it('guards concurrent submissions while waiting for catalog discovery and cancels before input', async () => {
    const { fixture, catalogs } = codexProcess({ intercept: frame => frame.method === 'config/read' })
    const session = await open()
    const signal = new AbortController()
    const submitted = session.submit([user()], signal.signal, { model: 'chosen', reasoningEffort: null })
    const rejected = expect(submitted).rejects.toThrow('cancel discovery')
    await vi.waitFor(() => expect(catalogs[0]?.frames.map(frame => frame.method)).toEqual(['initialize', 'initialized', 'config/read']))
    await expect(session.submit([user()], new AbortController().signal)).rejects.toMatchObject({ code: 'BRIDGE_BUSY' })
    signal.abort(new Error('cancel discovery'))
    await rejected
    expect(fixture.frames.some(frame => frame.method === 'turn/start' || frame.method === 'turn/interrupt')).toBe(false)
  })

  it('records function-call outputs without inventing another native execution', async () => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    const item = { id: 'function-output', type: 'functionCallOutput', name: 'read_file', namespace: 'functions', output: [{ type: 'input_text', text: 'native text' }, { type: 'input_image', image_url: 'data:image/png;base64,fixture' }] }
    notify(fixture, 'item/completed', { item })
    notify(fixture, 'item/completed', { item })
    completed(fixture)
    await submitted
    expect(sink.assistant.mock.calls).toEqual([['function-output', [{ type: 'text', text: '{"id":"function-output","type":"functionCallOutput","name":"read_file","namespace":"functions","output":[{"type":"input_text","text":"native text"},{"type":"input_image","image_url":"data:image/png;base64,fixture"}]}' }]]])
    expect(sink.toolStart).not.toHaveBeenCalled()
    expect(sink.toolEnd).not.toHaveBeenCalled()
    expect(fixture.frames.some(frame => frame.method === 'turn/interrupt')).toBe(false)
    expect(fixture.kill).not.toHaveBeenCalled()
  })

  it('rejects a malformed completed item instead of treating it as an unknown read-only event', async () => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    const rejected = expect(submitted).rejects.toMatchObject({ code: 'BRIDGE_PROTOCOL', message: 'Missing native protocol field: type' })
    await started
    notify(fixture, 'item/completed', { item: { id: 'malformed-native-item', text: 'missing type' } })
    completed(fixture)
    await rejected
    expect(sink.assistant).not.toHaveBeenCalled()
    expect(sink.toolStart).not.toHaveBeenCalled()
  })

  it('records unrecognized completed native items without terminating the native turn', async () => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    notify(fixture, 'item/completed', { item: { id: 'future-native-item', type: 'futureNativeItem', details: { text: 'native event', count: 2 } } })
    completed(fixture)
    await submitted
    expect(sink.assistant.mock.calls).toEqual([['future-native-item', [{ type: 'text', text: '{"id":"future-native-item","type":"futureNativeItem","details":{"text":"native event","count":2}}' }]]])
    expect(sink.toolStart).not.toHaveBeenCalled()
    expect(sink.toolEnd).not.toHaveBeenCalled()
    expect(fixture.kill).not.toHaveBeenCalled()
  })

  it.each(['resume', 'fork'] as const)('preserves inherited native settings on the first null preference after %s without model discovery', async (mode) => {
    const { fixture } = codexProcess({
      model: 'inherited-native-model',
      reasoningEffort: 'high',
      intercept: (frame, child) => {
        if (frame.method === 'config/read' || frame.method === 'model/list') {
          child.send({ id: frame.id, error: { code: -32601, message: 'Native catalog is unavailable' } })
          return true
        }
        if (frame.method !== 'turn/start')
          return false
        child.send({ id: frame.id, result: { turn: { id: 'turn-1' } } })
        completed(child)
        return true
      },
    })
    const session = await open(mode === 'resume' ? 'thread-1' : null, createSink(), mode === 'fork' ? { forkFrom: 'source-thread' } : undefined)
    await session.submit([user()], new AbortController().signal, { model: null, reasoningEffort: null })
    expect(fixture.frames.filter(frame => frame.method === 'turn/start').map(frame => frame.params)).toEqual([{ threadId: 'thread-1', input: [{ type: 'text', text: 'inspect the workspace', text_elements: [] }] }])
    expect(fixture.frames.some(frame => frame.method === 'config/read' || frame.method === 'model/list')).toBe(false)
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('commits authoritative assistant content once after live text and reasoning deltas', async () => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    const request = await started
    expect(request.params).toEqual({ threadId: 'thread-1', input: [{ type: 'text', text: 'inspect the workspace', text_elements: [] }] })
    notify(fixture, 'item/agentMessage/delta', { itemId: 'assistant-1', delta: 'hel' })
    notify(fixture, 'item/agentMessage/delta', { itemId: 'assistant-1', delta: 'lo' })
    notify(fixture, 'item/reasoning/summaryTextDelta', { itemId: 'reasoning-1', delta: 'verify first' })
    const assistant = { itemId: 'assistant-1', item: { id: 'assistant-1', type: 'agentMessage', text: 'hello' } }
    notify(fixture, 'item/completed', assistant)
    notify(fixture, 'item/completed', assistant)
    notify(fixture, 'item/completed', { item: { id: 'reasoning-1', type: 'reasoning', summary: ['verify first'], content: [] } })
    completed(fixture)
    await submitted
    expect(sink.text.mock.calls).toEqual([['assistant-1', 'hel'], ['assistant-1', 'lo']])
    expect(sink.thinking.mock.calls).toEqual([['reasoning-1', 'verify first']])
    expect(sink.assistant.mock.calls).toEqual([
      ['assistant-1', [{ type: 'text', text: 'hello' }]],
      ['reasoning-1', [{ type: 'thinking', text: 'verify first' }]],
    ])
  })

  it.each(['raw', 'summary'] as const)('streams only the first %s reasoning track while settling the canonical summary', async (first) => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    const tracks = first === 'raw' ? ['raw', 'summary'] : ['summary', 'raw']
    for (const track of tracks)
      notify(fixture, track === 'raw' ? 'item/reasoning/textDelta' : 'item/reasoning/summaryTextDelta', { itemId: 'reasoning-2', delta: `${track} reasoning` })
    notify(fixture, 'item/completed', { item: { id: 'reasoning-2', type: 'reasoning', summary: ['summary reasoning'], content: ['raw reasoning'] } })
    completed(fixture)
    await submitted
    expect(sink.thinking.mock.calls).toEqual([['reasoning-2', `${first} reasoning`]])
    expect(sink.assistant.mock.calls).toEqual([['reasoning-2', [{ type: 'thinking', text: 'summary reasoning' }]]])
  })

  it('preserves native tool ids and error results without executing DSH tools', async () => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    const item = { id: 'command-1', type: 'commandExecution', command: 'git status', cwd: 'C:/fixture/workspace', status: 'inProgress' }
    notify(fixture, 'item/started', { item })
    notify(fixture, 'item/commandExecution/outputDelta', { itemId: 'command-1', delta: 'fatal:' })
    notify(fixture, 'item/completed', { item: { ...item, status: 'completed', aggregatedOutput: 'fatal: not a git repository', exitCode: 128 } })
    notify(fixture, 'item/completed', { item: { ...item, status: 'completed', aggregatedOutput: 'fatal: not a git repository', exitCode: 128 } })
    completed(fixture)
    await submitted
    const arguments_ = '{"command":"git status","cwd":"C:/fixture/workspace"}'
    expect(sink.assistant.mock.calls).toEqual([['command-1:call', [{ type: 'tool-call', id: 'command-1', name: 'commandExecution', arguments: arguments_ }]]])
    expect(sink.toolStart.mock.calls).toEqual([['command-1', 'commandExecution', arguments_]])
    expect(sink.toolEnd.mock.calls).toEqual([['command-1', 'fatal: not a git repository', true]])
  })

  it.each(['completed', 'failed'])('preserves a native Node REPL MCP text-image-text result with status %s exactly once', async (status) => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    const item = { id: 'node-repl-image', type: 'mcpToolCall', server: 'node_repl', tool: 'js', arguments: { code: 'await nodeRepl.emitImage(image)' }, status: 'inProgress', result: null, error: null }
    const result = { content: [
      { type: 'text', text: 'before image' },
      { type: 'image', data: 'cG5nLWZpeHR1cmU=', mimeType: 'image/png' },
      { type: 'text', text: 'after image' },
    ], isError: status === 'failed' }
    notify(fixture, 'item/started', { item })
    notify(fixture, 'item/completed', { item: { ...item, status, result } })
    notify(fixture, 'item/completed', { item: { ...item, status, result } })
    completed(fixture)
    await submitted
    const arguments_ = '{"code":"await nodeRepl.emitImage(image)"}'
    expect(sink.assistant.mock.calls).toEqual([['node-repl-image:call', [{ type: 'tool-call', id: 'node-repl-image', name: 'mcp::node_repl/js', arguments: arguments_ }]]])
    expect(sink.toolStart.mock.calls).toEqual([['node-repl-image', 'mcp::node_repl/js', arguments_]])
    expect(sink.toolEnd.mock.calls).toEqual([['node-repl-image', `{"content":[{"type":"text","text":"before image"},{"type":"image","data":"cG5nLWZpeHR1cmU=","mimeType":"image/png"},{"type":"text","text":"after image"}],"isError":${status === 'failed' ? 'true' : 'false'}}`, status === 'failed']])
    expect(fixture.frames.filter(frame => frame.method === 'turn/start')).toHaveLength(1)
  })

  it.each(['completed', 'failed', 'declined'])('settles an announced file change from native turn items with terminal status %s', async (status) => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal, undefined, { sandbox: 'workspace-write', approval: 'ask' })
    await started
    const item = { id: 'edit-terminal', type: 'fileChange', status: 'inProgress', changes: [
      { path: 'C:/fixture/workspace/probe.svg', kind: { type: 'add' }, diff: '<svg>probe</svg>\n' },
      { path: 'C:/fixture/workspace/probe.txt', kind: { type: 'add' }, diff: 'native-capability-probe\n' },
    ] }
    notify(fixture, 'item/started', { item })
    notify(fixture, 'item/started', { item })
    fixture.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [
      { ...item, status },
      { id: 'unannounced-history', type: 'fileChange', status: 'completed', changes: [] },
    ], itemsView: 'full' } } })
    await submitted
    expect(sink.toolStart).toHaveBeenCalledOnce()
    expect(sink.toolStart.mock.calls[0]?.slice(0, 2)).toEqual(['edit-terminal', 'fileChange'])
    expect(sink.toolEnd.mock.calls).toEqual([['edit-terminal', '[{"path":"C:/fixture/workspace/probe.svg","kind":{"type":"add"},"diff":"<svg>probe</svg>\\n"},{"path":"C:/fixture/workspace/probe.txt","kind":{"type":"add"},"diff":"native-capability-probe\\n"}]', status !== 'completed']])
    expect(sink.assistant).toHaveBeenCalledOnce()
  })

  it.each(['inProgress', 'unknown', undefined])('does not invent a file-change result from nonterminal turn items with status %s', async (status) => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    const item = { id: 'edit-unsettled', type: 'fileChange', changes: [], status }
    notify(fixture, 'item/started', { item })
    fixture.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [item], itemsView: 'summary' } } })
    await submitted
    expect(sink.toolStart).toHaveBeenCalledExactlyOnceWith('edit-unsettled', 'fileChange', '{"changes":[]}')
    expect(sink.toolEnd).not.toHaveBeenCalled()
  })

  it.each(['completed', 'failed', 'declined', undefined])('settles a completed file-change notification once with status %s', async (status) => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    const item = { id: 'edit-completed', type: 'fileChange', changes: [], status }
    notify(fixture, 'item/started', { item: { ...item, status: 'inProgress' } })
    notify(fixture, 'item/completed', { item })
    notify(fixture, 'item/completed', { item })
    fixture.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [{ ...item, status: 'failed' }], itemsView: 'full' } } })
    await submitted
    expect(sink.toolStart).toHaveBeenCalledOnce()
    expect(sink.toolEnd.mock.calls).toEqual([['edit-completed', '[]', status === 'failed' || status === 'declined']])
    expect(sink.assistant).toHaveBeenCalledOnce()
  })

  it('leaves an announced file change unsettled when the native turn contains no result', async () => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    notify(fixture, 'item/started', { item: { id: 'edit-missing', type: 'fileChange', changes: [], status: 'inProgress' } })
    completed(fixture)
    await submitted
    expect(sink.toolStart).toHaveBeenCalledExactlyOnceWith('edit-missing', 'fileChange', '{"changes":[]}')
    expect(sink.toolEnd).not.toHaveBeenCalled()
  })

  it.each(['thread', 'turn'])('ignores terminal file-change items from another native %s', async (scope) => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    const item = { id: 'edit-current', type: 'fileChange', changes: [], status: 'inProgress' }
    notify(fixture, 'item/started', { item })
    fixture.send({ method: 'turn/completed', params: { threadId: scope === 'thread' ? 'other-thread' : 'thread-1', turn: { id: scope === 'turn' ? 'other-turn' : 'turn-1', status: 'completed', items: [{ ...item, status: 'completed' }], itemsView: 'full' } } })
    completed(fixture)
    await submitted
    expect(sink.toolStart).toHaveBeenCalledOnce()
    expect(sink.toolEnd).not.toHaveBeenCalled()
  })

  it.each([true, false])('settles a native file change after approval returns %s without substituting the decision for a result', async (allowed) => {
    const { fixture } = codexProcess()
    const sink = createSink()
    sink.approval.mockResolvedValue(allowed)
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    const item = { id: 'edit-approval', type: 'fileChange', changes: [], status: 'inProgress' }
    notify(fixture, 'item/started', { item })
    const answered = fixture.next(frame => frame.id === 'patch-approval')
    fixture.send({ id: 'patch-approval', method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'edit-approval' } })
    expect(await answered).toEqual({ id: 'patch-approval', result: { decision: allowed ? 'accept' : 'decline' } })
    expect(sink.toolEnd).not.toHaveBeenCalled()
    notify(fixture, 'item/completed', { item: { ...item, status: allowed ? 'completed' : 'declined' } })
    completed(fixture)
    await submitted
    expect(sink.toolEnd.mock.calls).toEqual([['edit-approval', '[]', !allowed]])
  })

  it('does not present a streamed patch preview as a completed native file change', async () => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    notify(fixture, 'item/fileChange/patchUpdated', { itemId: 'edit-preview', changes: [{ path: 'C:/fixture/workspace/probe.txt', kind: { type: 'add' }, diff: 'partial patch' }] })
    completed(fixture)
    await submitted
    expect(sink.assistant).not.toHaveBeenCalled()
    expect(sink.toolStart).not.toHaveBeenCalled()
    expect(sink.toolEnd).not.toHaveBeenCalled()
  })

  it('preserves native file-change output deltas on a failed completion', async () => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    const item = { id: 'edit-denied', type: 'fileChange', status: 'inProgress', changes: [{ path: 'C:/fixture/workspace/probe.txt', kind: { type: 'delete' }, diff: 'probe\n' }] }
    notify(fixture, 'item/started', { item })
    notify(fixture, 'item/fileChange/outputDelta', { itemId: 'edit-denied', delta: 'AccessDenied: ' })
    notify(fixture, 'item/fileChange/outputDelta', { itemId: 'edit-denied', delta: 'delete denied by sandbox\n' })
    notify(fixture, 'item/completed', { item: { ...item, status: 'failed' } })
    completed(fixture)
    await submitted
    expect(sink.toolEnd.mock.calls).toEqual([['edit-denied', 'AccessDenied: delete denied by sandbox\n', true]])
  })

  it.each(['item/started', 'item/completed'] as const)('presents each tool before starting it when the first native notification is %s', async (first) => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const order: string[] = []
    sink.assistant.mockImplementation(id => order.push(`assistant:${id}`))
    sink.toolStart.mockImplementation(id => order.push(`start:${id}`))
    sink.toolEnd.mockImplementation(id => order.push(`end:${id}`))
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    const settled = vi.fn()
    void submitted.then(settled, settled)
    await started
    try {
      const firstTool = { id: 'parallel-command-1', type: 'commandExecution', command: 'git status', cwd: 'C:/fixture/workspace', status: first === 'item/completed' ? 'completed' : 'inProgress', aggregatedOutput: 'first output', exitCode: 0 }
      notify(fixture, first, { item: firstTool })
      if (first === 'item/started')
        notify(fixture, 'item/completed', { item: { ...firstTool, status: 'completed' } })
      await Promise.resolve()
      expect(order).toEqual(['assistant:parallel-command-1:call', 'start:parallel-command-1', 'end:parallel-command-1'])
      expect(settled).not.toHaveBeenCalled()
      await expect(session.submit([user()], new AbortController().signal)).rejects.toMatchObject({ code: 'BRIDGE_BUSY' })
      const secondTool = { id: 'parallel-command-2', type: 'commandExecution', command: 'git diff', cwd: 'C:/fixture/workspace', status: first === 'item/completed' ? 'completed' : 'inProgress', aggregatedOutput: 'second output', exitCode: 0 }
      notify(fixture, first, { item: secondTool })
      if (first === 'item/started')
        notify(fixture, 'item/completed', { item: { ...secondTool, status: 'completed' } })
      await Promise.resolve()
      expect(settled).not.toHaveBeenCalled()
      expect(order).toEqual([
        'assistant:parallel-command-1:call',
        'start:parallel-command-1',
        'end:parallel-command-1',
        'assistant:parallel-command-2:call',
        'start:parallel-command-2',
        'end:parallel-command-2',
      ])
      expect(sink.assistant.mock.calls).toEqual([
        ['parallel-command-1:call', [{ type: 'tool-call', id: 'parallel-command-1', name: 'commandExecution', arguments: '{"command":"git status","cwd":"C:/fixture/workspace"}' }]],
        ['parallel-command-2:call', [{ type: 'tool-call', id: 'parallel-command-2', name: 'commandExecution', arguments: '{"command":"git diff","cwd":"C:/fixture/workspace"}' }]],
      ])
      expect(sink.toolEnd.mock.calls).toEqual([['parallel-command-1', 'first output', false], ['parallel-command-2', 'second output', false]])
    }
    finally {
      completed(fixture)
      await submitted
    }
    expect(settled).toHaveBeenCalledTimes(1)
    expect(fixture.frames.filter(frame => frame.method === 'turn/start')).toHaveLength(1)
    expect(fixture.frames.some(frame => frame.method === 'turn/interrupt')).toBe(false)
    expect(fixture.kill).not.toHaveBeenCalled()
  })

  it('rejects unknown native server requests instead of granting or executing them', async () => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    const answered = fixture.next(frame => frame.id === 'unknown-control')
    fixture.send({ id: 'unknown-control', method: 'futureNative/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'future-tool' } })
    expect(await answered).toEqual({ id: 'unknown-control', error: { code: -32601, message: 'Unsupported native server request: futureNative/requestApproval' } })
    expect(sink.approval).not.toHaveBeenCalled()
    expect(sink.questions).not.toHaveBeenCalled()
    expect(sink.toolStart).not.toHaveBeenCalled()
    completed(fixture)
    await submitted
    expect(fixture.kill).not.toHaveBeenCalled()
  })

  it('routes a parked approval while RPC traffic continues and returns only allow-once', async () => {
    const { fixture } = codexProcess()
    const sink = createSink()
    let allow!: (value: boolean) => void
    const asked = Promise.withResolvers<void>()
    sink.approval.mockImplementation(() => {
      asked.resolve()
      return new Promise(resolve => allow = resolve)
    })
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    const answered = fixture.next(frame => frame.id === 77 && 'result' in frame)
    fixture.send({ id: 77, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-approval', command: 'git status', cwd: 'D:\\work', reason: 'command needs to read the repository', availableDecisions: ['accept', 'cancel'] } })
    await asked.promise
    notify(fixture, 'item/agentMessage/delta', { itemId: 'assistant-1', delta: 'awaiting your answer' })
    expect(sink.text).toHaveBeenCalledWith('assistant-1', 'awaiting your answer')
    allow(true)
    expect(await answered).toEqual({ id: 77, result: { decision: 'accept' } })
    expect(sink.approval.mock.calls[0]?.slice(0, 2)).toEqual(['command-approval', {
      kind: 'command',
      title: 'git status',
      details: 'command needs to read the repository\ncommand: git status\ncwd: D:\\work',
    }])
    expect(sink.approval.mock.calls[0]![1].details).not.toContain('threadId')
    completed(fixture)
    await submitted
  })

  it('names the proposed files in a file-change approval prompt', async () => {
    const { fixture } = codexProcess()
    const sink = createSink()
    sink.approval.mockResolvedValue(true)
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    notify(fixture, 'item/started', { item: { id: 'edit-1', type: 'fileChange', status: 'inProgress', changes: [
      { path: 'src/harness/session.ts', kind: { type: 'update' }, diff: '@@' },
      { path: 'src/harness/new.ts', kind: { type: 'add' }, diff: '@@' },
    ] } })
    const answered = fixture.next(frame => frame.id === 81 && 'result' in frame)
    fixture.send({ id: 81, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'edit-1', reason: 'edit the harness session' } })
    expect(await answered).toEqual({ id: 81, result: { decision: 'accept' } })
    expect(sink.approval.mock.calls[0]![1]).toEqual({
      kind: 'file',
      title: 'Codex file changes',
      details: 'edit the harness session\nsrc/harness/session.ts\nsrc/harness/new.ts',
    })
    completed(fixture)
    await submitted
  })

  it('cancels instead of answering accept when the native decision menu offers no one-shot grant', async () => {
    const { fixture } = codexProcess()
    const sink = createSink()
    sink.approval.mockResolvedValue(true)
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    const answered = fixture.next(frame => frame.id === 79 && 'result' in frame)
    fixture.send({ id: 79, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-approval', command: 'rm -rf build', availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['rm', '-rf', 'build'] } }, 'cancel'] } })
    expect(await answered).toEqual({ id: 79, result: { decision: 'cancel' } })
    completed(fixture)
    await submitted
  })

  it('reports requested permissions without the raw native envelope', async () => {
    const { fixture } = codexProcess()
    const sink = createSink()
    sink.approval.mockResolvedValue(true)
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    const answered = fixture.next(frame => frame.id === 80 && 'result' in frame)
    fixture.send({ id: 80, method: 'item/permissions/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'permissions-1', reason: 'write access is required', permissions: { network: { enabled: false }, fileSystem: { read: ['D:\\work'] } } } })
    expect(await answered).toEqual({ id: 80, result: { permissions: { network: { enabled: false }, fileSystem: { read: ['D:\\work'] } }, scope: 'turn' } })
    expect(sink.approval.mock.calls[0]![1]).toEqual({
      kind: 'tool',
      title: 'Codex additional permissions',
      details: 'write access is required\npermissions: {"network":{"enabled":false},"fileSystem":{"read":["D:\\\\work"]}}',
    })
    completed(fixture)
    await submitted
  })

  it('withdraws a resolved native approval without sending a late grant', async () => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const parked = Promise.withResolvers<boolean>()
    sink.approval.mockReturnValue(parked.promise)
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    fixture.send({ id: 78, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'edit-1' } })
    const signal = sink.approval.mock.calls[0]![2]!
    fixture.send({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 78 } })
    parked.resolve(true)
    await parked.promise
    completed(fixture)
    await submitted
    expect(signal.aborted).toBe(true)
    expect(fixture.frames.some(frame => frame.id === 78)).toBe(false)
  })

  it('maps native question identities to answer arrays in the official question sink', async () => {
    const { fixture } = codexProcess()
    const sink = createSink()
    sink.questions.mockResolvedValue({ language: 'TypeScript', focus: ['Events', 'Cancel'] })
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    const answered = fixture.next(frame => frame.id === 'question-1')
    fixture.send({ id: 'question-1', method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'question-tool', questions: [
      { id: 'language', question: 'Which language?', options: [{ label: 'TypeScript', description: 'Typed code' }] },
      { id: 'focus', question: 'Which areas?' },
    ] } })
    expect(await answered).toEqual({ id: 'question-1', result: { answers: { language: { answers: ['TypeScript'] }, focus: { answers: ['Events', 'Cancel'] } } } })
    expect(sink.questions.mock.calls[0]?.slice(0, 2)).toEqual(['question-tool', [
      { id: 'language', question: 'Which language?', options: [{ label: 'TypeScript', description: 'Typed code' }] },
      { id: 'focus', question: 'Which areas?' },
    ]])
    completed(fixture)
    await submitted
  })

  it('rejects secret questions without persisting their answers', async () => {
    const { fixture } = codexProcess()
    const sink = createSink()
    const session = await open(null, sink)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    await started
    const answered = fixture.next(frame => frame.id === 79)
    fixture.send({ id: 79, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'secret', questions: [{ id: 'password', question: 'Password?', isSecret: true }] } })
    expect(await answered).toMatchObject({ id: 79, error: { code: -32603, message: 'Secret native questions cannot be recorded in the official session log' } })
    expect(sink.questions).not.toHaveBeenCalled()
    completed(fixture)
    await submitted
  })

  it('cleans only interrupted turn terminals before declaring cancellation settled', async () => {
    const { fixture, terminals } = codexProcess({ terminals: [{ itemId: 'old-command', processId: 'old-process' }] })
    const session = await open()
    const signal = new AbortController()
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], signal.signal)
    const rejected = expect(submitted).rejects.toThrow('cancel this turn')
    await started
    terminals.push({ itemId: 'command-1', processId: 'new-process' })
    notify(fixture, 'item/started', { item: { id: 'command-1', type: 'commandExecution', command: 'watch', processId: 'new-process' } })
    const interrupted = fixture.next(frame => frame.method === 'turn/interrupt')
    signal.abort(new Error('cancel this turn'))
    expect(await interrupted).toMatchObject({ params: { threadId: 'thread-1', turnId: 'turn-1' } })
    completed(fixture, 'interrupted')
    await rejected
    expect(fixture.frames.filter(frame => frame.method === 'thread/backgroundTerminals/terminate').map(frame => frame.params)).toEqual([{ threadId: 'thread-1', processId: 'new-process' }])
    expect(terminals).toEqual([{ itemId: 'old-command', processId: 'old-process' }])
  })

  it('obtains the turn id and interrupts even when cancelled before turn/start replies', async () => {
    const { fixture } = codexProcess({ intercept: frame => frame.method === 'turn/start' })
    const session = await open()
    const signal = new AbortController()
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], signal.signal)
    const rejected = expect(submitted).rejects.toThrow('cancel early')
    const request = await started
    signal.abort(new Error('cancel early'))
    const interrupted = fixture.next(frame => frame.method === 'turn/interrupt')
    fixture.send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })
    fixture.send({ id: request.id, result: { turn: { id: 'turn-1' } } })
    await interrupted
    completed(fixture, 'interrupted')
    await rejected
    expect(fixture.frames.filter(frame => frame.method === 'turn/interrupt')).toHaveLength(1)
  })

  it('terminates late commands belonging to a cancelled native turn', async () => {
    const { fixture, terminals } = codexProcess()
    const session = await open()
    const signal = new AbortController()
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], signal.signal)
    const rejected = expect(submitted).rejects.toThrow('cancel late test')
    await started
    const interrupted = fixture.next(frame => frame.method === 'turn/interrupt')
    signal.abort(new Error('cancel late test'))
    await interrupted
    completed(fixture, 'interrupted')
    await rejected
    terminals.push({ itemId: 'late-command', processId: 'late-process' })
    const terminated = fixture.next(frame => frame.method === 'thread/backgroundTerminals/terminate')
    notify(fixture, 'item/started', { item: { id: 'late-command', type: 'commandExecution', command: 'watch', processId: 'late-process' } })
    expect(await terminated).toMatchObject({ params: { threadId: 'thread-1', processId: 'late-process' } })
    expect(terminals).toEqual([])
  })

  it('fails closed when interrupted background terminals remain after termination', async () => {
    const { fixture, terminals } = codexProcess({ intercept: (frame, child) => {
      if (frame.method !== 'thread/backgroundTerminals/terminate')
        return false
      child.send({ id: frame.id, result: { terminated: false } })
      return true
    } })
    const session = await open()
    const signal = new AbortController()
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], signal.signal)
    const rejected = expect(submitted).rejects.toMatchObject({ code: 'BRIDGE_INTERRUPT_CLEANUP_FAILED' })
    await started
    terminals.push({ itemId: 'stuck-command', processId: 'stuck-process' })
    signal.abort(new Error('cancel'))
    await rejected
    expect(fixture.kill).toHaveBeenCalledWith('SIGTERM')
    expect(fixture.frames.some(frame => frame.method === 'turn/interrupt')).toBe(false)
  })

  it('keeps the official text and image order in one mixed native prompt', async () => {
    const { fixture } = codexProcess()
    const attachments: NativeAttachments = { path: () => 'C:/fixture/native.png', read: vi.fn() }
    const session = await open(null, createSink(), undefined, attachments)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const mixed = createUserMessage({ source: { kind: 'user' }, content: [
      { type: 'text', text: 'before ' },
      { type: 'image', attachment: { id: 'image-1', mediaType: 'image/png', bytes: 3 } as never },
      { type: 'text', text: ' after' },
    ] })
    const submitted = session.submit([mixed], new AbortController().signal)
    expect((await started).params).toEqual({
      threadId: 'thread-1',
      input: [
        { type: 'text', text: 'before ', text_elements: [] },
        { type: 'localImage', path: 'C:/fixture/native.png' },
        { type: 'text', text: ' after', text_elements: [] },
      ],
    })
    completed(fixture)
    await submitted
  })

  it('forwards an official image as native input instead of rejecting the prompt', async () => {
    const { fixture } = codexProcess()
    const attachments: NativeAttachments = { path: () => 'C:/fixture/native.png', read: vi.fn() }
    const session = await open(null, createSink(), undefined, attachments)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user(), image({ id: 'image-1', mediaType: 'image/png', bytes: 3 })], new AbortController().signal)
    expect((await started).params).toEqual({
      threadId: 'thread-1',
      input: [
        { type: 'text', text: 'inspect the workspace', text_elements: [] },
        { type: 'localImage', path: 'C:/fixture/native.png' },
      ],
    })
    completed(fixture)
    await submitted
    expect(attachments.read).not.toHaveBeenCalled()
  })

  it('inlines an official image as a data URL when the provider stores no host file', async () => {
    const { fixture } = codexProcess()
    const attachments: NativeAttachments = { path: () => undefined, read: vi.fn(async () => ({ mediaType: 'image/png', base64: 'Zm FrZQ==' })) }
    const session = await open(null, createSink(), undefined, attachments)
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([image({ id: 'image-2', mediaType: 'image/png', bytes: 3 })], new AbortController().signal)
    expect((await started).params).toEqual({
      threadId: 'thread-1',
      input: [{ type: 'image', url: 'data:image/png;base64,Zm FrZQ==' }],
    })
    completed(fixture)
    await submitted
  })

  it('refuses nontext user content rather than submitting a partial native prompt', async () => {
    const { fixture } = codexProcess()
    const session = await open()
    const input = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'reasoning', text: 'not user text' }] })
    await expect(session.submit([input], new AbortController().signal)).rejects.toMatchObject({ code: 'BRIDGE_UNSUPPORTED_CONTENT' })
    expect(fixture.frames.some(frame => frame.method === 'turn/start')).toBe(false)
  })

  it('propagates a native crash and clears active control waits', async () => {
    const { fixture } = codexProcess()
    const session = await open()
    const started = fixture.next(frame => frame.method === 'turn/start')
    const submitted = session.submit([user()], new AbortController().signal)
    const rejected = expect(submitted).rejects.toMatchObject({ code: 'BRIDGE_PROCESS_EXIT', message: 'Native process exited (7): native crash' })
    await started
    fixture.stderr.write('native crash')
    fixture.exit(7)
    await rejected
    await expect(session.submit([user()], new AbortController().signal)).rejects.toMatchObject({ code: 'BRIDGE_PROCESS_EXIT' })
  })
})
