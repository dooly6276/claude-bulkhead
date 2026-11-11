'use strict'
const crypto = require('crypto')
const path = require('path')

const DEFAULT_RANGE = { min: 3000, max: 3999 }
// Ports browsers refuse to open; the same list port-cli.js uses.
const BROWSER_BLOCKED = new Set([1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080])

// "3000-3999" as { min, max }, or null.
function parseRange(text) {
  const m = /^(\d+)-(\d+)$/.exec(String(text || '').trim())
  if (!m) return null
  const min = Number(m[1])
  const max = Number(m[2])
  return min >= 1024 && max <= 65535 && min <= max ? { min, max } : null
}

// The string a worktree root is hashed as: its resolved path, lowercased on Windows.
function keyFor(root, platform = process.platform) {
  const p = path.resolve(root)
  return platform === 'win32' ? p.toLowerCase() : p
}

// The same key always starts at the same port: first 4 bytes of its sha1, as a uint32, modulo the range size.
function startPort(key, range = DEFAULT_RANGE) {
  const size = range.max - range.min + 1
  return range.min + (crypto.createHash('sha1').update(String(key)).digest().readUInt32BE(0) % size)
}

// The fixed order of candidates: the start, then upward, wrapping inside the range, browser-blocked ports left out.
function sequence(key, range = DEFAULT_RANGE) {
  const size = range.max - range.min + 1
  const first = startPort(key, range) - range.min
  const out = []
  for (let i = 0; i < size; i++) {
    const p = range.min + ((first + i) % size)
    if (!BROWSER_BLOCKED.has(p)) out.push(p)
  }
  return out
}

// Synchronous variant for callers that already know the busy ports (port-guard).
function pickFree(key, taken = new Set(), range = DEFAULT_RANGE) {
  for (const p of sequence(key, range)) if (!taken.has(p)) return p
  return null
}

// The stable port of a worktree root: its start port, or the next free one in the fixed order.
// null when the whole range is busy. `bind(host, port)` resolves true when the bind works.
async function stablePort(root, range = DEFAULT_RANGE, { bind, platform = process.platform } = {}) {
  const { isFree, canBind } = require('./port-cli')
  for (const p of sequence(keyFor(root, platform), range)) if (await isFree(p, bind || canBind)) return p
  return null
}

module.exports = { stablePort, pickFree, sequence, startPort, keyFor, parseRange, DEFAULT_RANGE, BROWSER_BLOCKED }
