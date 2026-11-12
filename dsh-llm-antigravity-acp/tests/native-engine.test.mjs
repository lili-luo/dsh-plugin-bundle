// Contract and end-to-end tests for Native Agent Engine Mode (`engineMode: 'bridge' | 'native'`).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AntigravityAdapter } from '../lib/adapter.js'
import { asEngineMode, Config, current, ENGINE_MODES } from '../lib/config.js'
import {
  extractNativeSessionContext, nativeBridgeSystemPrompt, prepareNativeRequest,
} from '../lib/history.js'
import { prepareHome } from '../lib/preflight.js'
import {
  AntigravityRuntime, filterToolsForEngineMode, NATIVE_OVERLAPPING_DSH_TOOLS,
} from '../lib/runtime.js'
import { answerPermission, recordReportedToolCall } from '../lib/tool-bridge.js'

const here = dirname(fileURLToPath(import.meta.url))
const fake = join(here, 'fake-agy.mjs')
chmodSync(fake, 0o755)
const runtimes = []
const tempDirs = []

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeRuntime({ config: configExtra = {}, host = {}, plan, env: envExtra = {} } = {}) {
  const home = makeTempDir('agy-native-test-')
  const log = join(home, 'prompts.jsonl')
  const argvLog = join(home, 'argv.jsonl')
  const procCwdLog = join(home, 'proc-cwd.jsonl')
  const lifecycleLog = join(home, 'lifecycle.jsonl')
  const mcpLog = join(home, 'mcp.jsonl')
  const infoLogs = []
  const warnLogs = []
  const config = {
    provider: 'antigravity',
    displayName: 'Antigravity',
    command: fake,
    home,
    accounts: [{
      id: 'default', displayName: '', home: '', enabled: true, env: {},
      contextWindow: 0, system: true, visibleModels: [], priority: 1, weight: 1,
    }],
    contextWindow: 0,
    defaultEffort: 'high',
    autoPatch: false,
    patchScript: join(home, 'missing.py'),
    maxLiveSessions: 16,
    idleSessionTtlMs: 600_000,
    parkSettleMs: 80,
    keepAliveMs: 1_000,
    longDecodeContinuations: 3,
    warmup: false,
    quotaTtlMs: 60_000,
    ...configExtra,
  }
  const runtime = new AntigravityRuntime({
    config,
    spawnAcp: (argv, cwd) => {
      const child = spawn(process.execPath, [argv[0], ...argv.slice(1)], {
        cwd,
        env: {
          ...process.env,
          FAKE_AGY_LOG: log,
          FAKE_AGY_ARGV: argvLog,
          FAKE_AGY_PROC_CWD: procCwdLog,
          FAKE_AGY_LIFECYCLE: lifecycleLog,
          FAKE_AGY_MCP: mcpLog,
          ...(plan === undefined ? {} : { FAKE_AGY_PLAN: JSON.stringify(plan) }),
          ...envExtra,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', d => { stderr += d })
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        exited: new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal }))),
        terminate: () => child.kill(),
        stderrTail: () => stderr,
      }
    },
    runCommand: async argv => ({ code: 0, stdout: argv.includes('--version') ? 'fake-agy 1.5.5' : '{}', stderr: '' }),
    readImage: async () => ({ data: 'aW1n', mimeType: 'image/png' }),
    canReadImages: () => true,
    log: {
      info: msg => infoLogs.push(msg),
      warn: msg => warnLogs.push(msg),
    },
    onModelsChanged: () => undefined,
    ...host,
  })
  runtimes.push(runtime)
  const readJsonl = file => existsSync(file)
    ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
  return {
    home,
    runtime,
    adapter: new AntigravityAdapter(runtime, 'Antigravity', () => true),
    prompts: () => readJsonl(log),
    argvs: () => readJsonl(argvLog),
    procCwds: () => readJsonl(procCwdLog),
    lifecycle: () => readJsonl(lifecycleLog),
    mcps: () => readJsonl(mcpLog),
    infoLogs,
    warnLogs,
  }
}

after(async () => {
  for (const r of runtimes) await r.dispose()
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

const dshSysMsg = (id = 'sys-1') => ({
  id,
  role: 'system',
  content: [{ type: 'text', text: 'You are an AI agent powered by DeepSeek Harness.\nUse bash and read.' }],
  source: { kind: 'system-prompt' },
})

const runtimeCtxMsg = (id, { cwd, policy = 'workspace-write', workspaceRoot, additionalWritableRoots, teamIdentity, asSections = true }) => {
  const sections = []
  if (cwd !== undefined) {
    sections.push({ name: 'working-directory:current', text: `Current working directory: ${JSON.stringify(cwd)}.` })
  }
  if (policy === 'read-only') {
    sections.push({
      name: 'sandbox:policy',
      text: 'Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode.',
    })
  } else if (policy === 'workspace-write') {
    const root = workspaceRoot ?? cwd ?? '/workspace'
    const extra = additionalWritableRoots
      ? ` Additional writable directories: ${JSON.stringify(additionalWritableRoots)}.`
      : ''
    sections.push({
      name: 'sandbox:policy',
      text: `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(root)}.${extra} Some platform temporary areas may also be writable.`,
    })
  } else if (policy === 'danger-full-access') {
    sections.push({
      name: 'sandbox:policy',
      text: 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.',
    })
  }
  sections.push({
    name: 'subagent:identity',
    text: 'You are the root agent. Your name is "lead".',
  })
  if (teamIdentity !== undefined) {
    sections.push({ name: 'team:identity', text: teamIdentity })
  }
  const text = `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${sections.map(s => s.text).join('\n\n')}`
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: asSections ? { kind: 'runtime-context', form: 'snapshot', sections } : { kind: 'runtime-context' },
  }
}

const agentsMdMsg = (id, rules) => ({
  id,
  role: 'user',
  content: [{ type: 'text', text: `<system-reminder>\n${rules}\n</system-reminder>` }],
  source: { kind: 'agent-instructions' },
})

const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const assistant = (id, content, model = 'gemini-4-argon') => ({
  id, role: 'assistant', content, source: { kind: 'model', provider: 'antigravity', model },
})
const toolMsg = (id, callId, text) => ({
  id, role: 'tool', toolCallId: callId, content: [{ type: 'text', text }], source: { kind: 'tool', callId },
})

const schema = (name, description = `Tool ${name}`) => ({
  name,
  description,
  parameters: { type: 'object', properties: { input: { type: 'string' } } },
})

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}
const finishOf = chunks => chunks.at(-1)
const textOf = chunks => chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
const reasoningOf = chunks => chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('')
const callsOf = chunks => chunks.filter(c => c.type === 'block-end' && c.block.type === 'tool-call').map(c => c.block)
const assistantFrom = (id, chunks, model) => assistant(id, chunks.filter(c => c.type === 'block-end').map(c => c.block), model)

test('Config schema defaults engineMode to bridge and validates ENGINE_MODES', () => {
  assert.deepEqual(ENGINE_MODES, ['bridge', 'native'])
  assert.equal(current(Config({}).engineMode), 'bridge')
  assert.equal(current(Config({ engineMode: 'native' }).engineMode), 'native')
  assert.equal(asEngineMode('bridge'), 'bridge')
  assert.equal(asEngineMode('native'), 'native')
  assert.equal(asEngineMode('other'), undefined)
  assert.equal(asEngineMode(42), undefined)
})

test('prepareHome syncs userSettings.useAiCredits into isolated config.json and settings.json fallback', () => {
  const userHome = makeTempDir('agy-user-home-')
  const isolatedHome = makeTempDir('agy-isolated-home-')
  mkdirSync(join(userHome, '.gemini', 'config'), { recursive: true })
  writeFileSync(
    join(userHome, '.gemini', 'config', 'config.json'),
    JSON.stringify({ userSettings: { themeMode: 'DARK', useAiCredits: true } }),
  )
  // Seed pre-existing keys in isolated config/config.json to verify merge preservation.
  mkdirSync(join(isolatedHome, 'config'), { recursive: true })
  writeFileSync(
    join(isolatedHome, 'config', 'config.json'),
    JSON.stringify({ customTopKey: 'kept', userSettings: { existingPref: 'kept', useAiCredits: false } }),
  )

  prepareHome(isolatedHome, userHome)

  const mergedConfig = JSON.parse(readFileSync(join(isolatedHome, 'config', 'config.json'), 'utf8'))
  assert.equal(mergedConfig.customTopKey, 'kept')
  assert.equal(mergedConfig.userSettings.existingPref, 'kept')
  assert.equal(mergedConfig.userSettings.useAiCredits, true)

  // With no antigravity-cli/settings.json in userHome, useG1Credits falls back to useAiCredits.
  const agySettings = JSON.parse(readFileSync(join(isolatedHome, 'agy', 'settings.json'), 'utf8'))
  const cliSettings = JSON.parse(readFileSync(join(isolatedHome, 'antigravity-cli', 'settings.json'), 'utf8'))
  assert.equal(agySettings.useG1Credits, true)
  assert.equal(cliSettings.useG1Credits, true)

  // Host antigravity-cli/settings.json useG1Credits takes precedence over config.json fallback on fresh homes.
  const isolatedHome2 = makeTempDir('agy-isolated-home2-')
  mkdirSync(join(userHome, '.gemini', 'antigravity-cli'), { recursive: true })
  writeFileSync(join(userHome, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({ useG1Credits: false }))
  prepareHome(isolatedHome2, userHome)
  assert.equal(JSON.parse(readFileSync(join(isolatedHome2, 'agy', 'settings.json'), 'utf8')).useG1Credits, false)
  assert.equal(JSON.parse(readFileSync(join(isolatedHome2, 'config', 'config.json'), 'utf8')).userSettings.useAiCredits, true)
})

test('filterToolsForEngineMode strips only overlapping FS/shell/job/MCP-resource tools in native mode', () => {
  const overlapping = [
    'read', 'write', 'edit', 'bash', 'glob', 'grep', 'working_directory',
    'job_list', 'job_output', 'job_kill',
    'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  ]
  assert.deepEqual([...NATIVE_OVERLAPPING_DSH_TOOLS].sort(), [...overlapping].sort())

  const preserved = [
    'subagent', 'subagent_fork', 'subagent_freebuff', 'list_subagent_models',
    'list_agents', 'interrupt_agent', 'wait_agent', 'send_message',
    'spawn_teammate', 'team_task_create', 'team_task_update', 'workflow',
    'skill', 'todo_write', 'present', 'ask_user_question',
    'create_goal', 'get_goal', 'update_goal', 'schedule_create',
    'web_search', 'web_fetch', 'read_image', 'load_workspace_dependencies', 'plugin_manager',
    'notebooklm_ask', 'feishu_doc_read', 'google_drive_search', 'md_convert', 'mcp__github__get_issue',
  ]
  const allSchemas = [...overlapping, ...preserved].map(name => schema(name))

  assert.deepEqual(filterToolsForEngineMode(allSchemas, 'bridge').map(t => t.name), allSchemas.map(t => t.name))
  assert.deepEqual(filterToolsForEngineMode(allSchemas, 'native').map(t => t.name), preserved)
  assert.deepEqual(filterToolsForEngineMode(undefined, 'native'), [])
})

test('extractNativeSessionContext, prepareNativeRequest, and nativeBridgeSystemPrompt handle sections, plain text, and teamIdentity', () => {
  const msgs = [
    dshSysMsg('s1'),
    agentsMdMsg('inst-1', 'RULE_ONE: keep exports documented.'),
    runtimeCtxMsg('rc-1', {
      cwd: '/old/dir',
      policy: 'read-only',
    }),
    runtimeCtxMsg('rc-2', {
      cwd: '/proj/with "quotes" & spaces',
      policy: 'workspace-write',
      workspaceRoot: '/proj/with "quotes" & spaces',
      additionalWritableRoots: ['/shared/dir[1]', '/shared/worktrees'],
      asSections: false,
    }),
    user('u-1', 'Fix the bug'),
  ]

  const ctx = extractNativeSessionContext(msgs)
  assert.equal(ctx.cwd, '/proj/with "quotes" & spaces')
  assert.equal(ctx.sandboxMode, 'workspace-write')
  assert.equal(ctx.workspaceRoot, '/proj/with "quotes" & spaces')
  assert.deepEqual(ctx.additionalWritableRoots, ['/shared/dir[1]', '/shared/worktrees'])
  assert.equal(ctx.teamIdentity, undefined)

  const prepared = prepareNativeRequest({
    provider: 'antigravity',
    model: 'gemini-4-carbon',
    system: 'You are an AI agent powered by DeepSeek Harness.',
    messages: msgs,
  })
  assert.equal(prepared.rulesText, 'RULE_ONE: keep exports documented.')
  assert.deepEqual(prepared.messages.map(m => m.id), ['u-1'])

  // When team:identity is present, runtime-context is retained with ONLY teamIdentity and the same message id.
  const withTeam = prepareNativeRequest({
    provider: 'antigravity',
    model: 'gemini-4-carbon',
    messages: [
      dshSysMsg('s1'),
      runtimeCtxMsg('rc-team', {
        cwd: '/proj/team',
        policy: 'workspace-write',
        teamIdentity: 'You are teammate "worker-1" on the shared task board.',
      }),
      user('u-team', 'Claim task 1'),
    ],
  })
  assert.deepEqual(withTeam.messages.map(m => m.id), ['rc-team', 'u-team'])
  assert.equal(withTeam.messages[0].content[0].text, 'You are teammate "worker-1" on the shared task board.')

  const prompt = nativeBridgeSystemPrompt('RULE_ONE', '### mcp_dsh_subagent\nDelegate work.')
  assert.doesNotMatch(prompt, /primary model of a DeepSeek Harness/)
  assert.match(prompt, /read_file.*edit_file.*write_file.*run_command/)
  assert.match(prompt, /<user_rules>\nRULE_ONE\n<\/user_rules>/)
  assert.match(prompt, /<mcp_tool_contracts>[\s\S]*mcp_dsh_subagent[\s\S]*<\/mcp_tool_contracts>/)
})

test('native mode omits --agent, binds canonical session/front cwd, strips DSH system/runtime-context, filters tools, traces built-in calls, and continues multi-turn with rebuild: false', async () => {
  const projectDir = makeTempDir('agy-native-proj-')
  const canonicalProjectDir = realpathSync(projectDir)
  writeFileSync(join(projectDir, 'sample.txt'), 'hello native workspace\n')

  const oversizedSubagent = {
    name: 'subagent',
    description: `${'Delegate isolated coding tasks to a dedicated background subagent. '.repeat(28)}NEVER_POLL_SUBAGENT.`,
    parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'Task prompt.' } }, required: ['prompt'] },
  }
  const todoWrite = {
    name: 'todo_write',
    description: 'Record todo progress items',
    parameters: { type: 'object', properties: { todos: { type: 'array' } }, required: ['todos'] },
  }
  const customPlugin = schema('feishu_doc_read', 'Read a Feishu cloud document')

  const plan = [
    {
      thought: 'Inspecting sample.txt first.',
      builtins: [
        {
          toolCallId: 'b_read_1',
          name: 'read_file',
          title: 'Read sample.txt',
          kind: 'read',
          locations: [{ path: join(projectDir, 'sample.txt') }],
          rawInput: { Path: 'sample.txt' },
          updates: [{ status: 'in_progress', title: 'Read sample.txt' }],
        },
      ],
      tool: { name: 'todo_write', args: { todos: [{ content: 'Read sample.txt', status: 'completed' }] } },
      afterTool: {
        thought: 'Summarizing now.',
        text: 'Summary: sample.txt greets the native workspace.',
      },
    },
    {
      thought: 'Answering follow-up in the same ACP session.',
      text: 'Follow-up answered without rebuild.',
    },
  ]

  const { adapter, runtime, prompts, argvs, procCwds, lifecycle, infoLogs } = makeRuntime({
    config: { engineMode: 'native' },
    plan,
  })
  assert.equal(runtime.status().engineMode, 'native')

  const tools = [schema('read'), schema('write'), schema('edit'), schema('bash'), schema('grep'), oversizedSubagent, todoWrite, customPlugin]
  const baseReq = {
    provider: 'antigravity',
    model: 'gemini-4-argon',
    reasoningEffort: 'high',
    sessionId: 'S-native-e2e',
    system: 'You are an AI agent powered by DeepSeek Harness.\nInternal loop prompt that must not leak.',
    tools,
  }
  const turn1Msgs = [
    dshSysMsg('sys-0'),
    runtimeCtxMsg('rc-1', { cwd: projectDir, policy: 'workspace-write', workspaceRoot: projectDir }),
    agentsMdMsg('inst-1', 'WORKSPACE_RULE: keep responses concise.'),
    user('u-1', 'Read sample.txt, update todo_write, and summarize.'),
  ]

  // Turn 1, Step 1: native read_file runs internally (traced in reasoning) -> MCP todo_write parks.
  const step1 = await collect(adapter.stream({ ...baseReq, messages: turn1Msgs }))
  assert.equal(finishOf(step1).reason.kind, 'tool-calls')
  const [todoCall] = callsOf(step1)
  assert.equal(todoCall.name, 'todo_write')

  // Verify argv omitted `--agent` completely and logged engineMode=native.
  const spawnedArgv = argvs()[0]
  assert.equal(spawnedArgv.includes('--agent'), false, `native argv must omit --agent: ${JSON.stringify(spawnedArgv)}`)
  await new Promise(r => setTimeout(r, 30))
  assert.ok(infoLogs.some(line => line.includes('engineMode=native')))

  // Verify built-in tool trace landed once in reasoning (deduplicated across tool_call + tool_call_update) and NOT in text, and MCP tool did NOT emit [agy].
  const step1Reasoning = reasoningOf(step1)
  assert.equal((step1Reasoning.match(/\[agy\]/g) ?? []).length, 1, `expected single deduplicated [agy] trace in reasoning: ${step1Reasoning}`)
  assert.match(step1Reasoning, /\[agy\] read_file: Read sample\.txt/)
  assert.doesNotMatch(step1Reasoning, /todo_write/)
  assert.equal(textOf(step1), '')

  // Verify session/new AND spawned agy front process used canonical realpath(projectDir), filtered overlapping tools, and omitted DSH system/runtime-context.
  const p1 = prompts()[0]
  assert.equal(procCwds()[0], canonicalProjectDir)
  assert.equal(p1.cwd, canonicalProjectDir)
  assert.deepEqual(p1.tools, ['subagent', 'todo_write', 'feishu_doc_read', 'dsh_await_result', 'dsh_call_tool'])
  assert.doesNotMatch(p1.system, /powered by DeepSeek Harness/)
  assert.doesNotMatch(p1.system, /primary model of a DeepSeek Harness/)
  assert.ok(p1.system.includes(canonicalProjectDir), 'nativeBridgeSystemPrompt names canonical effectiveCwd')
  assert.match(p1.system.replaceAll('\u200b', ''), /<user_rules>\nWORKSPACE_RULE: keep responses concise\.\n<\/user_rules>/)
  assert.match(p1.system, /<mcp_tool_contracts>[\s\S]*NEVER_POLL_SUBAGENT[\s\S]*<\/mcp_tool_contracts>/)
  assert.equal(p1.text, 'Read sample.txt, update todo_write, and summarize.')

  // Turn 1, Step 2: deliver todo_write result -> completes Turn 1 in the same prompt.
  const afterToolMsgs = [
    ...turn1Msgs,
    assistantFrom('a-1', step1),
    toolMsg('t-1', todoCall.id, 'todo recorded'),
  ]
  const step2 = await collect(adapter.stream({ ...baseReq, messages: afterToolMsgs }))
  assert.equal(finishOf(step2).reason.kind, 'stop')
  assert.equal(
    textOf(step2),
    'BUILTIN(read_file)=ALLOWED:allow-once RESULT(todo_write)=todo recordedSummary: sample.txt greets the native workspace.',
  )
  assert.equal(prompts().length, 1, 'tool result resumed the live ACP prompt')

  // Turn 2: follow-up user turn (even with an in-history system update and refreshed runtime-context snapshot) reuses the exact same ACP session (rebuild: false)!
  const turn2Msgs = [
    ...afterToolMsgs,
    assistantFrom('a-2', step2),
    dshSysMsg('sys-in-history-2'),
    runtimeCtxMsg('rc-2', { cwd: projectDir, policy: 'workspace-write', workspaceRoot: projectDir }),
    user('u-2', 'What file did you just summarize?'),
  ]
  const turn2 = await collect(adapter.stream({ ...baseReq, messages: turn2Msgs }))
  assert.equal(finishOf(turn2).reason.kind, 'stop')
  assert.equal(textOf(turn2), 'Follow-up answered without rebuild.')
  assert.equal(prompts().length, 2)
  assert.equal(prompts()[1].session, p1.session, 'Turn 2 reused the exact same ACP sessionId')
  assert.doesNotMatch(prompts()[1].text, /<dsh_history>/, 'Turn 2 sent incremental input with rebuild: false')
  assert.equal(prompts()[1].text, 'What file did you just summarize?')
  assert.equal(lifecycle().filter(e => e.op === 'new').length, 1)
})

test('native mode enforces read-only, workspace-write (paths, relative traversal, /var <-> /private/var symlinks, escaping symlinks), and danger-full-access permissions', async () => {
  const projectDir = makeTempDir('agy-perm-proj-')
  const extraDir = makeTempDir('agy-perm-extra-')
  const outsideHomeFile = join(homedir(), '.dsh-nonexistent-outside-test-target.txt')
  const escapeLink = join(projectDir, 'escape-etc')
  const danglingLink = join(projectDir, 'dangling-outside')
  symlinkSync('/etc', escapeLink)
  symlinkSync('/etc/nonexistent-dsh-escape-target', danglingLink)

  const { adapter } = makeRuntime({ config: { engineMode: 'native' } })
  const runDirective = async (sessionId, policy, directiveLines, opts = {}) => {
    const chunks = await collect(adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-argon',
      sessionId,
      tools: [schema('todo_write')],
      messages: [
        dshSysMsg(),
        runtimeCtxMsg('rc', {
          cwd: projectDir,
          policy,
          workspaceRoot: projectDir,
          additionalWritableRoots: opts.additionalWritableRoots,
        }),
        user('u1', directiveLines.join('\n')),
      ],
    }))
    return textOf(chunks)
  }

  // 1. read-only mode: allows read/search built-ins; rejects write_file, edit_file, run_command.
  const roText = await runDirective('S-perm-ro', 'read-only', [
    `BUILTIN ${JSON.stringify({ name: 'read_file', kind: 'read', rawInput: { Path: 'a.txt' } })}`,
    `BUILTIN ${JSON.stringify({ name: 'search_web', kind: 'search', rawInput: { query: 'acp' } })}`,
    `BUILTIN ${JSON.stringify({ name: 'list_resources', kind: 'read', rawInput: {} })}`,
    `BUILTIN ${JSON.stringify({ name: 'write_file', kind: 'edit', rawInput: { Path: join(projectDir, 'a.txt') } })}`,
    `BUILTIN ${JSON.stringify({ name: 'edit_file', kind: 'edit', rawInput: { Path: 'a.txt' } })}`,
    `BUILTIN ${JSON.stringify({ name: 'run_command', kind: 'execute', rawInput: { CommandLine: 'ls' } })}`,
  ])
  assert.match(roText, /BUILTIN\(read_file\)=ALLOWED:allow-once/)
  assert.match(roText, /BUILTIN\(search_web\)=ALLOWED:allow-once/)
  assert.match(roText, /BUILTIN\(list_resources\)=ALLOWED:allow-once/)
  assert.match(roText, /BUILTIN\(write_file\)=PERMISSION_REJECTED/)
  assert.match(roText, /BUILTIN\(edit_file\)=PERMISSION_REJECTED/)
  assert.match(roText, /BUILTIN\(run_command\)=PERMISSION_REJECTED/)

  // 2. workspace-write mode: allows inside projectDir (relative + nested uncreated dirs + /var symlink), additionalWritableRoots, and run_command;
  //    rejects /etc/hosts, outsideHomeFile, relative ../ traversal, symlink escape, dangling symlink escape, empty path, and mixed locations + outside Path.
  const wwText = await runDirective('S-perm-ww', 'workspace-write', [
    `BUILTIN ${JSON.stringify({ name: 'write_file', kind: 'edit', rawInput: { Path: 'src/nested/new-file.ts' } })}`,
    `BUILTIN ${JSON.stringify({ name: 'edit_file', kind: 'edit', locations: [{ path: join(extraDir, 'ok.ts') }], rawInput: { Path: join(extraDir, 'ok.ts') } })}`,
    `BUILTIN ${JSON.stringify({ name: 'run_command', kind: 'execute', rawInput: { CommandLine: 'npm test' } })}`,
    `BUILTIN ${JSON.stringify({ name: 'write_file', kind: 'edit', rawInput: { Path: '/etc/hosts' } })}`,
    `BUILTIN ${JSON.stringify({ name: 'edit_file', kind: 'edit', rawInput: { Path: outsideHomeFile } })}`,
    `BUILTIN ${JSON.stringify({ name: 'write_file', kind: 'edit', rawInput: { Path: '../../../../../../etc/hosts' } })}`,
    `BUILTIN ${JSON.stringify({ name: 'write_file', kind: 'edit', rawInput: { Path: 'escape-etc/hosts' } })}`,
    `BUILTIN ${JSON.stringify({ name: 'write_file', kind: 'edit', rawInput: { Path: 'dangling-outside' } })}`,
    `BUILTIN ${JSON.stringify({ name: 'write_file', kind: 'edit', rawInput: {} })}`,
    `BUILTIN ${JSON.stringify({ name: 'edit_file', kind: 'edit', locations: [{ path: join(projectDir, 'safe.ts') }], rawInput: { Path: '/etc/hosts' } })}`,
    'SPOOFCALL todo_write {"todos":[]}',
  ], { additionalWritableRoots: [extraDir] })

  const wwParts = wwText.split(' | ')
  assert.equal(wwParts[0], 'BUILTIN(write_file)=ALLOWED:allow-once', 'relative nested path inside projectDir')
  assert.equal(wwParts[1], 'BUILTIN(edit_file)=ALLOWED:allow-once', 'path inside additionalWritableRoots')
  assert.equal(wwParts[2], 'BUILTIN(run_command)=ALLOWED:allow-once', 'run_command allowed in workspace-write')
  assert.equal(wwParts[3], 'BUILTIN(write_file)=PERMISSION_REJECTED', '/etc/hosts rejected')
  assert.equal(wwParts[4], 'BUILTIN(edit_file)=PERMISSION_REJECTED', 'outside home path rejected')
  assert.equal(wwParts[5], 'BUILTIN(write_file)=PERMISSION_REJECTED', 'relative ../ traversal to /etc/hosts rejected')
  assert.equal(wwParts[6], 'BUILTIN(write_file)=PERMISSION_REJECTED', 'symlink escaping to /etc rejected')
  assert.equal(wwParts[7], 'BUILTIN(write_file)=PERMISSION_REJECTED', 'dangling symlink escaping to /etc rejected')
  assert.equal(wwParts[8], 'BUILTIN(write_file)=PERMISSION_REJECTED', 'missing target path rejected')
  assert.equal(wwParts[9], 'BUILTIN(edit_file)=PERMISSION_REJECTED', 'mixed safe location + /etc/hosts rawInput.Path rejected')
  assert.equal(wwParts[10], 'RESULT(todo_write)=PERMISSION_REJECTED', 'spoofed MCP title without structured serverName still rejected')

  // Direct unit check on /var <-> /private/var symlink equivalence against strict single-root writableRoots.
  const reportedToolCalls = new Map()
  recordReportedToolCall({ reportedToolCalls }, {
    sessionUpdate: 'tool_call',
    toolCallId: 'tc_symlink',
    name: 'write_file',
    kind: 'edit',
    rawInput: { Path: join(projectDir, 'deep', 'created.txt') },
  })
  const siblingTmpDir = makeTempDir('agy-perm-sibling-')
  const baseState = {
    sessionId: 's1',
    tenantKey: 't1',
    turnLive: true,
    engineMode: 'native',
    sandboxMode: 'workspace-write',
    sessionCwd: projectDir,
    writableRoots: [projectDir],
    reportedToolCalls,
    advertisedToolNames: new Set(),
  }
  const allowedInside = answerPermission(baseState, {
    sessionId: 's1',
    toolCall: { toolCallId: 'tc_symlink', name: 'write_file', kind: 'edit', rawInput: { Path: join(projectDir, 'deep', 'created.txt') } },
    options: [{ optionId: 'allow-1', kind: 'allow_once' }, { optionId: 'reject-1', kind: 'reject_once' }],
  }, { hasHandshake: () => true, warn: () => undefined })
  assert.deepEqual(allowedInside, { outcome: 'selected', optionId: 'allow-1' })

  const rejectedSibling = answerPermission({ ...baseState, reportedToolCalls: new Map() }, {
    sessionId: 's1',
    toolCall: { toolCallId: 'tc_sib', name: 'write_file', kind: 'edit', rawInput: { Path: join(siblingTmpDir, 'escape.txt') } },
    options: [{ optionId: 'allow-1', kind: 'allow_once' }, { optionId: 'reject-1', kind: 'reject_once' }],
  }, { hasHandshake: () => true, warn: () => undefined })
  assert.deepEqual(rejectedSibling, { outcome: 'selected', optionId: 'reject-1' })

  // 3. danger-full-access mode: allows writes outside workspaceRoot with allow_once.
  const dfaText = await runDirective('S-perm-dfa', 'danger-full-access', [
    `BUILTIN ${JSON.stringify({ name: 'write_file', kind: 'edit', rawInput: { Path: outsideHomeFile } })}`,
  ])
  assert.equal(dfaText, 'BUILTIN(write_file)=ALLOWED:allow-once')
})

test('live configure({ engineMode }) and idle native frontCwd changes restart ACP slots cleanly without disrupting concurrent sessions', async () => {
  const projectDir = makeTempDir('agy-switch-proj-')
  const canonicalDir1 = realpathSync(projectDir)
  const { adapter, runtime, argvs, procCwds, prompts } = makeRuntime({ config: { engineMode: 'bridge' } })

  const req = (id, text, sessionId = 'S-live-switch', cwd = projectDir) => ({
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId,
    tools: [schema('read'), schema('todo_write')],
    messages: [
      dshSysMsg(),
      runtimeCtxMsg('rc-switch', { cwd, policy: 'workspace-write', workspaceRoot: cwd }),
      user(id, text),
    ],
  })

  // 1. Starts in bridge mode with `--agent dsh-bridge` and isolated workspace cwd.
  await collect(adapter.stream(req('u1', 'hello bridge')))
  assert.equal(argvs().length, 1)
  assert.equal(argvs()[0].includes('--agent'), true)
  assert.equal(argvs()[0][argvs()[0].indexOf('--agent') + 1], 'dsh-bridge')
  assert.notEqual(prompts()[0].cwd, canonicalDir1)
  assert.deepEqual(prompts()[0].tools, ['read', 'todo_write', 'dsh_await_result', 'dsh_call_tool'])

  // 2. Live switch to native mode stops the bridge AcpProcess cleanly without setting an error,
  //    and the next turn spawns `agy acp` without `--agent` directly inside canonicalDir1.
  const statusNative = runtime.configure({ engineMode: 'native' })
  assert.equal(statusNative.engineMode, 'native')
  assert.equal(statusNative.error, undefined)
  assert.equal(statusNative.state, 'idle')

  await collect(adapter.stream(req('u2', 'hello native')))
  assert.equal(argvs().length, 2, 'switching engineMode spawned a fresh agy acp front')
  assert.equal(argvs()[1].includes('--agent'), false)
  assert.equal(procCwds()[1], canonicalDir1)
  assert.equal(prompts()[1].cwd, canonicalDir1)
  assert.deepEqual(prompts()[1].tools, ['todo_write', 'dsh_await_result', 'dsh_call_tool'])

  // 3. Switching cwd on the sole session resets its session and restarts the idle native front in canonicalDir2.
  const projectDir2 = makeTempDir('agy-switch-proj2-')
  const canonicalDir2 = realpathSync(projectDir2)
  await collect(adapter.stream(req('u3', 'moved workspace', 'S-live-switch', projectDir2)))
  assert.equal(argvs().length, 3, 'idle native front restarts in the new canonical workspace')
  assert.equal(procCwds()[2], canonicalDir2)
  assert.equal(prompts()[2].cwd, canonicalDir2)

  // 4. Opening a second session in projectDir3 while S-live-switch still holds a live session on the slot
  //    keeps the running front alive (no disruption) and passes canonicalDir3 to session/new + nativeBridgeSystemPrompt.
  const projectDir3 = makeTempDir('agy-switch-proj3-')
  const canonicalDir3 = realpathSync(projectDir3)
  await collect(adapter.stream(req('u-other', 'concurrent repo', 'S-second-repo', projectDir3)))
  assert.equal(argvs().length, 3, 'front stays alive while another session is bound to it')
  assert.equal(prompts()[3].cwd, canonicalDir3)
  assert.ok(prompts()[3].system.includes(canonicalDir3))

  // 5. Switching back to bridge mode restarts with `--agent dsh-bridge`.
  const statusBridge = runtime.configure({ engineMode: 'bridge' })
  assert.equal(statusBridge.engineMode, 'bridge')
  assert.equal(statusBridge.error, undefined)
  await collect(adapter.stream(req('u4', 'back to bridge')))
  assert.equal(argvs().length, 4)
  assert.equal(argvs()[3].includes('--agent'), true)
})

test('session-index.json resumes native sessions in effectiveCwd via session/load and invalidates on engineMode or cwd change', async () => {
  const projectDir = makeTempDir('agy-persist-proj-')
  const canonicalDir = realpathSync(projectDir)
  let liveMode = 'native'
  const volatileEngineMode = { get: () => liveMode }
  const { adapter, prompts, mcps } = makeRuntime({
    config: { maxLiveSessions: 1, engineMode: volatileEngineMode },
  })
  const baseA = { provider: 'antigravity', model: 'gemini-4-argon', sessionId: 'S-nat-persist-A', tools: [schema('read'), schema('todo_write')] }
  const baseB = { provider: 'antigravity', model: 'gemini-4-argon', sessionId: 'S-nat-persist-B', tools: [schema('todo_write')] }

  const turn1Msgs = [
    dshSysMsg(),
    runtimeCtxMsg('rc-a1', { cwd: projectDir, policy: 'workspace-write', workspaceRoot: projectDir }),
    user('au-1', 'first native turn'),
  ]
  const a1 = await collect(adapter.stream({ ...baseA, messages: turn1Msgs }))
  const sessionA = prompts()[0].session
  assert.equal(prompts()[0].cwd, canonicalDir)

  // Evict S-nat-persist-A by running S-nat-persist-B under maxLiveSessions: 1.
  await collect(adapter.stream({
    ...baseB,
    messages: [dshSysMsg(), runtimeCtxMsg('rc-b1', { cwd: projectDir }), user('bu-1', 'evict A')],
  }))

  // Resume S-nat-persist-A in the same projectDir: uses session/load with canonicalDir and rebuild: false.
  const turn2Msgs = [...turn1Msgs, assistantFrom('aa-1', a1), user('au-2', 'resumed native turn')]
  const a2 = await collect(adapter.stream({ ...baseA, messages: turn2Msgs }))
  assert.equal(prompts().at(-1).session, sessionA)
  assert.equal(prompts().at(-1).cwd, canonicalDir)
  assert.doesNotMatch(prompts().at(-1).text, /<dsh_history>/)
  assert.ok(mcps().some(m => m.op === 'load' && m.session === sessionA && m.cwd === canonicalDir))

  // Flip volatile engineMode to 'bridge': ensureSlotReady restarts slot and persisted native session is invalidated.
  liveMode = 'bridge'
  const turn3Msgs = [...turn2Msgs, assistantFrom('aa-2', a2), user('au-3', 'after volatile bridge switch')]
  await collect(adapter.stream({ ...baseA, messages: turn3Msgs }))
  assert.notEqual(prompts().at(-1).session, sessionA)
  assert.match(prompts().at(-1).text, /<dsh_history>/)
})

test('native built-in permission denial that aborts session/prompt with zero text continues in-place instead of failing with EMPTY_RESPONSE', async () => {
  const projectDir = makeTempDir('agy-abort-reject-proj-')
  const plan = [
    // Round 1 of Turn 1: agy tries write_file('/var/empty/blocked.txt'), gets reject_once, and immediately ends session/prompt with zero text (real agy 1.5.5 behavior).
    {
      thought: 'Attempting write outside workspace.',
      builtin: {
        name: 'write_file',
        title: 'Write /var/empty/blocked.txt',
        kind: 'edit',
        rawInput: { Path: '/var/empty/blocked.txt' },
        abortOnReject: true,
      },
    },
    // Round 2 (in-place continuation in the SAME ACP session): receives [HARNESS_SANDBOX_NOTICE] and explains cleanly.
    {
      thought: 'Adapting to workspace-write boundary.',
      text: 'Write outside the workspace was blocked by sandbox policy; keeping changes inside the project.',
    },
    // Turn 2 follow-up: reuses the exact same ACP session (dirty stayed false, rebuild: false).
    {
      thought: 'Follow-up turn.',
      text: 'Session stayed clean and reusable.',
    },
    // Exhaustion scenario (3 consecutive zero-output denials in read-only mode -> visible fallback text, never EMPTY_RESPONSE).
    {
      builtin: { name: 'write_file', kind: 'edit', rawInput: { Path: join(projectDir, 'ro.txt') }, abortOnReject: true },
    },
    {
      builtin: { name: 'write_file', kind: 'edit', rawInput: { Path: join(projectDir, 'ro.txt') }, abortOnReject: true },
    },
    {
      builtin: { name: 'write_file', kind: 'edit', rawInput: { Path: join(projectDir, 'ro.txt') }, abortOnReject: true },
    },
  ]

  const { adapter, prompts, lifecycle } = makeRuntime({
    config: { engineMode: 'native' },
    plan,
  })

  // Part A: single out-of-workspace denial recovers in-place on the same ACP session.
  const turn1Msgs = [
    dshSysMsg(),
    runtimeCtxMsg('rc-ww', { cwd: projectDir, policy: 'workspace-write', workspaceRoot: projectDir }),
    user('u-1', 'Try writing /var/empty/blocked.txt'),
  ]
  const turn1 = await collect(adapter.stream({
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'S-abort-recover',
    tools: [schema('todo_write')],
    messages: turn1Msgs,
  }))
  assert.equal(finishOf(turn1).reason.kind, 'stop')
  assert.equal(textOf(turn1), 'Write outside the workspace was blocked by sandbox policy; keeping changes inside the project.')
  assert.equal(prompts().length, 2, 'initial prompt + 1 in-place sandbox refusal continuation')
  assert.equal(prompts()[0].session, prompts()[1].session, 'continuation stayed in the exact same ACP session')
  assert.match(prompts()[1].text, /\[HARNESS_SANDBOX_NOTICE\].*write_file.*\/var\/empty\/blocked\.txt.*workspace-write/)

  // Turn 2 continues incrementally with rebuild: false (session was NOT marked dirty or forgotten).
  const turn2Msgs = [
    ...turn1Msgs,
    assistantFrom('a-1', turn1),
    user('u-2', 'Continue normally'),
  ]
  const turn2 = await collect(adapter.stream({
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'S-abort-recover',
    tools: [schema('todo_write')],
    messages: turn2Msgs,
  }))
  assert.equal(finishOf(turn2).reason.kind, 'stop')
  assert.equal(textOf(turn2), 'Session stayed clean and reusable.')
  assert.equal(prompts()[2].session, prompts()[0].session, 'Turn 2 reused the same ACP session')
  assert.doesNotMatch(prompts()[2].text, /<dsh_history>/)
  assert.equal(lifecycle().filter(e => e.op === 'new').length, 1)

  // Part B: stubborn denials exhausting the continuation cap still emit visible refusal text and never throw EMPTY_RESPONSE.
  const roChunks = await collect(adapter.stream({
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'S-abort-cap',
    tools: [schema('todo_write')],
    messages: [
      dshSysMsg(),
      runtimeCtxMsg('rc-ro', { cwd: projectDir, policy: 'read-only', workspaceRoot: projectDir }),
      user('u-ro', 'Write ro.txt anyway'),
    ],
  }))
  assert.equal(finishOf(roChunks).reason.kind, 'stop')
  assert.match(textOf(roChunks), /Operation refused by DSH sandbox policy \(read-only\): write_file/)
})

