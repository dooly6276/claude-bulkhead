#!/usr/bin/env node
'use strict'
// Builds the Gemini CLI extension archive: bulkhead-gemini-extension.tar.gz, the generic release
// asset `gemini extensions install https://github.com/dooly6276/claude-bulkhead` downloads.
//
// A release archive is needed because a git checkout of this repo carries hooks/hooks.json, the
// Claude Code file, and Gemini CLI loads that file name from every extension. The archive holds the
// Gemini hook file (gemini/hooks.json) at hooks/hooks.json instead.
//
// Usage: node scripts/build-gemini-extension.js [output-dir]   (default: the current directory)
// The publish workflow (.github/workflows/publish.yml) builds it and attaches it to each release.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.join(__dirname, '..')
const ARCHIVE = 'bulkhead-gemini-extension.tar.gz'
const FILES = [
  ['gemini-extension.json', 'gemini-extension.json'],
  ['gemini/hooks.json', 'hooks/hooks.json'],
  ['bin', 'bin'],
  ['src', 'src'],
  ['skills', 'skills'],
  ['LICENSE', 'LICENSE'],
  ['README.md', 'README.md'],
  ['package.json', 'package.json']
]

function build (outDir) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bulkhead-gemini-'))
  try {
    for (const [from, to] of FILES) {
      fs.mkdirSync(path.dirname(path.join(stage, to)), { recursive: true })
      fs.cpSync(path.join(root, from), path.join(stage, to), { recursive: true })
    }
    const out = path.resolve(outDir, ARCHIVE)
    const r = spawnSync('tar', ['-czf', out, '-C', stage, '.'], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error('tar failed: ' + (r.stderr || r.error))
    return out
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

if (require.main === module) console.log(build(process.argv[2] || '.'))
module.exports = { build, FILES, ARCHIVE }
