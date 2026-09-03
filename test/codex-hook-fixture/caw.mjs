#!/usr/bin/env node

import { writeFileSync } from 'node:fs'

writeFileSync('uncaptured-caw-ran.txt', process.argv.slice(2).join(' '))
