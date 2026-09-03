#!/usr/bin/env node

import { appendFileSync, readFileSync } from 'node:fs'

const event = readFileSync(0, 'utf8')
appendFileSync('.claude-hook-events.jsonl', `${event.trim()}\n`, { mode: 0o600 })
process.stdout.write('{"continue":true}\n')
