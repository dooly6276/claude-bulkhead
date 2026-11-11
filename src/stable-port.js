'use strict'
const crypto = require('crypto')
const path = require('path')
const { isFree, BROWSER_BLOCKED } = require('./port-cli')

const DEFAULT_RANGE = { min: 3000, max: 3999 }

// The same folder always starts its search at the same port: sha1 of the absolute root, modulo the
// size of the range, then forward (wrapping inside the range) to the first port nothing listens on.
// Windows paths are compared without case because the drive letter is written both ways.
function startOffset(root, size, platform = process.platform) {
  const abs = path.resolve(root)
  const key = platform === 'win32' ? abs.toLowerCase() : abs
  return crypto.createHash('sha1').update(key).digest().readUInt32BE(0) % size
}

async function stablePort(root, range = DEFAULT_RANGE, { bind, platform } = {}) {
  const { min, max } = { ...DEFAULT_RANGE, ...range }
  const size = max - min + 1
  if (!(size > 0)) return null
  const start = startOffset(root, size, platform)
  for (let i = 0; i < size; i++) {
    const port = min + ((start + i) % size)
    if (BROWSER_BLOCKED.has(port)) continue
    if (await isFree(port, bind)) return port
  }
  return null
}

module.exports = { stablePort, startOffset, DEFAULT_RANGE }
