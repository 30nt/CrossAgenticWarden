import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolvePopulationSource } from '../caw.mjs'
import claude from '../.caw/adapters/claude/adapter.mjs'
import codex from '../.caw/adapters/codex/adapter.mjs'

const FREEFORM_SCHEMA = {
  type: 'object',
  properties: {
    cases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          case: { type: 'string' },
          source: {
            type: 'string',
            description: 'where this came from in this run: repository path and line, exact ' +
              'request words, or the delivered index member',
          },
        },
        required: ['case', 'source'],
        additionalProperties: false,
      },
    },
  },
  required: ['cases'],
  additionalProperties: false,
}

const STRUCTURED_SCHEMA = {
  type: 'object',
  properties: {
    cases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          case: { type: 'string' },
          source: {
            description: 'repository uses kind,path,occurrence,excerpt; request uses ' +
              'kind,occurrence,excerpt; index uses kind,index_sha256,occurrence,excerpt. ' +
              'Excerpts match exactly and occurrence is one-based; line ranges are engine-derived.',
            anyOf: [
              {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['repository'] }, path: { type: 'string' },
                  occurrence: { type: 'number' },
                  excerpt: { type: 'string' },
                },
                required: ['kind', 'path', 'occurrence', 'excerpt'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['request'] }, occurrence: { type: 'number' },
                  excerpt: { type: 'string' },
                },
                required: ['kind', 'occurrence', 'excerpt'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['index'] }, index_sha256: { type: 'string' },
                  occurrence: { type: 'number' },
                  excerpt: { type: 'string' },
                },
                required: ['kind', 'index_sha256', 'occurrence', 'excerpt'],
                additionalProperties: false,
              },
            ],
          },
        },
        required: ['case', 'source'],
        additionalProperties: false,
      },
    },
  },
  required: ['cases'],
  additionalProperties: false,
}

const loadBearing = [
  ['current active state', /active/i],
  ['current disabled state', /disabled/i],
  ['future suspended state', /suspended/i],
  ['future opaque-token input', /opaque/i],
  ['indexed web consumer', /\bweb\b/i],
  ['indexed worker consumer', /\bworker\b/i],
]

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'caw-enumerator-pair-'))
  const delivery = join(parent, 'delivery')
  mkdirSync(join(delivery, 'src'), { recursive: true, mode: 0o700 })
  writeFileSync(join(delivery, 'README.md'), [
    '# Refresh fixture',
    'refreshSession preserves active accounts and rejects disabled accounts.',
    '',
  ].join('\n'))
  writeFileSync(join(delivery, 'src', 'session.js'), [
    "export const accountStates = ['active', 'disabled']",
    'export function refreshSession(account) {',
    "  return account.state === 'disabled' ? 'rejected' : 'refreshed'",
    '}',
    '',
  ].join('\n'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: delivery })
  execFileSync('git', ['config', 'user.name', 'CAW Live Probe'], { cwd: delivery })
  execFileSync('git', ['config', 'user.email', 'probe@example.invalid'], { cwd: delivery })
  execFileSync('git', ['add', '-A'], { cwd: delivery })
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: delivery })
  return { parent, delivery }
}

function invoke(adapter, provider, executable, model, schema, context) {
  const scratchRoot = join(context.parent, `${provider}-${schema === FREEFORM_SCHEMA ? 'free' : 'structured'}`)
  mkdirSync(scratchRoot, { mode: 0o700 })
  const binding = { provider, model, reasoning: 'low' }
  const execution = {
    workingRoot: context.delivery,
    env: { ...process.env, PWD: context.delivery, CAW_ROLE: 'enumerator' },
    ...(provider === 'codex' ? {
      scratchRoot, writeBoundary: 'engine-private-only', writeBoundaryBy: 'os-boundary',
    } : { writeBoundary: 'none' }),
  }
  const invocation = adapter.buildInvocation({
    role: 'enumerator', binding, schema, executable, execution,
    instructions: 'You enumerate cases without planning. Search this repository in this run. ' +
      'Return a separate case for each distinct current state, future state or input, and indexed ' +
      'consumer. Use repository sources for current states, request sources for future states and ' +
      'inputs, and index sources for consumers. Do not claim global exhaustiveness.',
    prompt: context.prompt,
  })
  const result = spawnSync(invocation.executable, invocation.args, {
    input: invocation.input, cwd: invocation.cwd, env: invocation.env,
    encoding: 'utf8', timeout: 150_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
  })
  assert.equal(result.status, 0, `${provider}: ${result.stdout}\n${result.stderr}`)
  const finalResponseText = invocation.transport
    ? readFileSync(invocation.transport.finalResponsePath, 'utf8') : undefined
  const decoded = adapter.decodeSuccess(result.stdout, {
    binding, requestedNative: invocation.requestedNative, finalResponseText,
  })
  if (invocation.transport) rmSync(invocation.transport.root, { recursive: true, force: true })
  return decoded.canonical.value.cases
}

function paired(provider, adapter, executable, model) {
  const f = fixture()
  try {
    const request = 'Extend refreshSession for a new suspended-account state that refuses refresh, ' +
      'accept a not-yet-issued opaque token input once launched, and preserve behavior for every ' +
      'current account state and every listed consumer.'
    const indexText = 'consumer:web\nconsumer:worker'
    const indexResult = {
      text: indexText,
      truncated: 0,
      sha256: createHash('sha256').update(indexText).digest('hex'),
    }
    const prompt = `Repository: ${f.delivery}\n\nEngine index digest: ${indexResult.sha256}\n` +
      `${indexText}\n\nHuman request:\n${request}`
    const context = { ...f, prompt }
    const freeform = invoke(adapter, provider, executable, model, FREEFORM_SCHEMA, context)
    const structured = invoke(adapter, provider, executable, model, STRUCTURED_SCHEMA, context)
    const failures = structured.map((item, index) => ({
      index,
      result: resolvePopulationSource(item.source, {
        request, indexResult, workingRoot: f.delivery,
      }),
    })).filter(({ result }) => !result.ok)
    const report = {
      provider,
      load_bearing_cases_named_before_run: loadBearing.map(([name]) => name),
      freeform: { returned_count: freeform.length, cases: freeform },
      structured: {
        returned_count: structured.length,
        failed_count: failures.length,
        failure_rate: structured.length ? failures.length / structured.length : null,
        failure_classes: [...new Set(failures.map(({ result }) => result.class))],
        failures,
        cases: structured,
      },
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    for (const [name, pattern] of loadBearing) {
      assert.ok(freeform.some((item) => pattern.test(item.case)), `${provider} freeform lost ${name}`)
      assert.ok(structured.some((item) => pattern.test(item.case)), `${provider} structured lost ${name}`)
    }
    assert.deepEqual(failures, [], `${provider} structured anchors did not resolve`)
    assert.ok(structured.some((item) => item.source.kind === 'repository'))
    assert.ok(structured.some((item) => item.source.kind === 'request'))
    assert.ok(structured.some((item) => item.source.kind === 'index'))
  } finally {
    if (existsSync(f.parent)) rmSync(f.parent, { recursive: true, force: true })
  }
}

test('live Claude free-form/structured enumerator pair preserves named semantic cases', {
  skip: process.env.CAW_LIVE_ENUMERATOR_CLAUDE !== '1'
    ? 'set CAW_LIVE_ENUMERATOR_CLAUDE=1 for the two-call paid pair' : false,
  timeout: 360_000,
}, () => {
  assert.ok(process.env.CAW_CLAUDE && process.env.CAW_CLAUDE_MODEL,
    'CAW_CLAUDE and CAW_CLAUDE_MODEL are required')
  paired('claude', claude, process.env.CAW_CLAUDE, process.env.CAW_CLAUDE_MODEL)
})

test('live Codex free-form/structured enumerator pair preserves named semantic cases', {
  skip: process.env.CAW_LIVE_ENUMERATOR_CODEX !== '1'
    ? 'set CAW_LIVE_ENUMERATOR_CODEX=1 for the two-call paid pair' : false,
  timeout: 360_000,
}, () => {
  assert.ok(process.env.CAW_CODEX && process.env.CAW_CODEX_MODEL && process.env.CAW_CODEX_AUTH_FILE,
    'CAW_CODEX, CAW_CODEX_MODEL and CAW_CODEX_AUTH_FILE are required')
  paired('codex', codex, process.env.CAW_CODEX, process.env.CAW_CODEX_MODEL)
})
