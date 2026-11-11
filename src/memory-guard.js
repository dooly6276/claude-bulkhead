'use strict'
const { runHook, blocked, setting } = require('./hook')
const { readMemory } = require('./memory')
const { limits } = require('./slots')
const shell = require('./shell')
const queue = require('./auto-queue')

// Commands that commonly take several GB of RAM: test runners with workers, full builds,
// bundlers, emulators and browsers. Each test gets the command's words with wrappers taken off.
const sub = argv => argv.slice(1).find(a => !a.startsWith('-')) || ''
const has = (argv, re) => argv.slice(1).some(a => re.test(a))
const quiet = argv => has(argv, /^(?:--version|-v|-V|--help|-h)$/)

// Gradle tasks that do not compile anything; any other task starts a build.
const GRADLE_LIGHT = /^(?:tasks|help|properties|dependencies|projects|wrapper|clean|init|--stop|--status|--version|-v|--help|-h|-q|--quiet|--offline)$/
const gradle = argv => argv.slice(1).some(a => !GRADLE_LIGHT.test(a) && !/^-D|^-P/.test(a))

const HEAVY_BINS = {
  vitest: argv => !quiet(argv),
  jest: argv => !quiet(argv),
  karma: argv => sub(argv) === 'start' || !sub(argv),
  playwright: argv => sub(argv) === 'test',
  cypress: argv => sub(argv) === 'run',
  gradlew: gradle,
  gradle,
  mvn: argv => has(argv, /^(?:test|package|verify|install|deploy|integration-test)$/),
  mvnw: argv => has(argv, /^(?:test|package|verify|install|deploy|integration-test)$/),
  emulator: argv => has(argv, /^(?:-avd|@.+)$/),
  dotnet: argv => /^(?:build|test|publish)$/.test(sub(argv)),
  next: argv => /^(?:build|dev)$/.test(sub(argv)),
  vite: argv => sub(argv) === 'build',
  tsc: argv => !quiet(argv) && !has(argv, /^--init$/),
  webpack: argv => !quiet(argv) && sub(argv) !== 'serve',
  ffmpeg: argv => !quiet(argv) && argv.length > 1,
  cargo: argv => /^(?:build|b|test|t|bench)$/.test(sub(argv)),
  go: argv => /^(?:test|build)$/.test(sub(argv)) && has(argv, /\/\.\.\.$|^\.\.\.$|^-race$/),
  xcodebuild: argv => has(argv, /^(?:-project|-workspace|-scheme|build|test|archive|build-for-testing|test-without-building)$/),
  swift: argv => /^(?:build|test)$/.test(sub(argv)),
  fastlane: argv => !quiet(argv) && !/^(?:lanes|env|help|actions|action|new_action|init)$/.test(sub(argv)) && argv.length > 1,
  pytest: argv => has(argv, /^(?:-n\d*|--numprocesses(?:=.*)?)$/),
  docker: argv => /^(?:build|buildx)$/.test(sub(argv)) || (sub(argv) === 'compose' && has(argv, /^(?:up|build)$/)),
  'docker-compose': argv => has(argv, /^(?:up|build)$/),
  bazel: argv => /^(?:build|test|run)$/.test(sub(argv)),
  turbo: argv => has(argv, /^(?:build|test)$/),
  nx: argv => /^(?:build|test|e2e|run|run-many|affected)$/.test(sub(argv)),
}
const RUNNERS = /^(?:npm|pnpm|yarn|bun)$/
// npx vitest, pnpm exec jest, yarn dlx, bunx, python -m pytest, node node_modules/.bin/jest
function realCommand(argv) {
  for (let guard = 0; guard < 8 && argv.length; guard++) {
    const b = shell.bin(argv[0])
    if (/^(?:npx|bunx|pnpx)$/.test(b)) {
      const at = argv.findIndex((a, k) => k > 0 && !a.startsWith('-'))
      argv = at > 0 ? argv.slice(at) : []
    } else if (RUNNERS.test(b) && /^(?:exec|dlx|x)$/.test(argv[1])) argv = argv.slice(2)
    else if (b === 'bundle' && argv[1] === 'exec') argv = argv.slice(2)
    else if (/^python[\d.]*$|^py$/.test(b) && argv[1] === '-m' && argv[2]) argv = argv.slice(2)
    else if (b === 'node' && argv[1] && /node_modules[\\/]/.test(argv[1])) argv = argv.slice(1)
    else break
  }
  return argv
}

function heavyArgv(argv) {
  argv = realCommand(argv)
  if (!argv.length) return false
  const b = shell.bin(argv[0])
  if (HEAVY_BINS[b]) return HEAVY_BINS[b](argv)
  // npm test, npm run build, pnpm build, yarn e2e, bun test
  if (RUNNERS.test(b)) {
    let k = 1
    while (argv[k] && argv[k].startsWith('-')) k += /^(?:--prefix|-C|--cwd|--dir|--filter|-F|-w|--workspace)$/.test(argv[k]) ? 2 : 1
    let script = argv[k] || ''
    if (script === 'run' || script === 'run-script') script = argv[k + 1] || ''
    return /^(?:build|test|t|e2e)(?:$|[:-])/.test(script)
  }
  return false
}

// A browser launched from code: chromium.launch(), puppeteer.launch(), launchPersistentContext.
const LAUNCH = /\b(?:chromium|firefox|webkit|puppeteer)\.launch\b|\blaunchPersistentContext\b/

// Commands that only read or search text: grep -rn vitest package.json
const INERT = /^(?:git|grep|egrep|rg|ag|echo|printf|cat|less|head|tail|ls|find|which|where|type|select-string|get-content|gc|write-host|write-output)$/i

// Heavy commands that stay up until stopped: a slot would be held for as long as they run.
const LONG_RUNNING = {
  next: argv => sub(argv) === 'dev',
  emulator: () => true,
  karma: () => true,
  docker: argv => !has(argv, /^(?:-d|--detach)$/),
  'docker-compose': argv => !has(argv, /^(?:-d|--detach)$/),
}
const isLong = argv => {
  const real = realCommand(argv)
  const f = real.length && LONG_RUNNING[shell.bin(real[0])]
  return Boolean(f && f(real) && (shell.bin(real[0]) !== 'docker' || sub(real) === 'compose'))
}

// The first heavy command in the line: { name, argv, long }, plus remote: true when any part of
// the line runs on another machine. null when nothing is heavy. name keys the GB estimate.
function findHeavy(cmd, mode = 'sh') {
  const text = shell.prepare(String(cmd || ''), mode)
  let found = null
  let remote = false
  for (const c of shell.commands(text, mode)) {
    const b = shell.bin(c.argv[0])
    if (c.remote) remote = true
    if (found || INERT.test(b) || c.remote) continue
    if (/^bulkhead(?:-slot)?$/.test(b)) continue
    if (heavyArgv(c.argv)) {
      const real = realCommand(c.argv)
      found = { name: shell.bin(real[0]), argv: real, long: isLong(c.argv) }
    } else if (LAUNCH.test(c.argv.join(' '))) found = { name: 'browser', argv: ['browser'], long: false }
  }
  return found && { ...found, remote }
}

const isHeavy = (cmd, mode = 'sh') => Boolean(findHeavy(cmd, mode))

const SLOT_FILE = /bulkhead[\\/]+slots|slot-\d+\.json/i
const WRITES = /(?:>{1,2}\|?|\b(?:touch|rm|del|unlink|mv|cp|Remove-Item|Set-Content|Add-Content|Out-File|New-Item|Clear-Content|Move-Item|Copy-Item|writeFileSync|unlinkSync|rmSync|utimesSync)\b)/i

// Hand-editing slot files is how a forgotten background loop kept a slot for hours.
function touchesSlotFiles(cmd) {
  // 2>/dev/null and 2>&1 only redirect error output; they write nothing to the slot files
  const quietRedirects = String(cmd).replace(/\d?>&\d|\d?>\s*(?:\/dev\/null|\$null|nul)\b/gi, ' ')
  return quietRedirects.split(/\n|;|&&|\|\|/).some(s => SLOT_FILE.test(s) && WRITES.test(s))
}

// A command that runs through bulkhead-slot already waits for room.
function queued(cmd) {
  return /\bbulkhead(?:-|\s+)slot\b/.test(String(cmd).replace(/'[^']*'|"[^"]*"/g, ' '))
}

// With a remote configured, the block also offers running the command there (docs/remote.md).
function hasRemote() {
  try {
    return Object.keys(require('./config').get('remotes') || {}).length > 0
  } catch {
    return false
  }
}

// Claude sessions that are running now, this one included; null when the session files cannot be read.
function liveSessions() {
  try {
    const { readSessionFiles } = require('./sessions')
    const { staleReason } = require('./slots')
    return [...readSessionFiles().keys()].filter(pid => !staleReason({ pid, at: Date.now() })).length
  } catch {
    return null
  }
}

// Where the minimum comes from, in a few words.
function minimumSource(minFreeGb, totalGb) {
  if (setting('memory.minFreeGb', null) != null) return 'set in your config'
  if (minFreeGb >= 3) return 'the 3 GB default'
  return `15% of this machine's ${Math.round(totalGb)} GB`
}

function slotLine(cmd, mode, overrides) {
  const found = findHeavy(cmd, mode)
  const gb = queue.estimateGb(found ? found.name : '', overrides)
  const text = String(cmd).trim()
  const arg = text.length <= 160 && !/[\r\n]/.test(text) && mode === 'sh' ? queue.quoters.sh(text) : '<command>'
  return `bulkhead-slot run --gb=${gb} -- ${arg}`
}

function check(cmd, memory = () => readMemory(), minFreeGb, mode = 'sh', remote = hasRemote, sessions = liveSessions) {
  if (!cmd) return null
  if (touchesSlotFiles(cmd)) {
    return '[bulkhead] memory-guard: slot files are managed by bulkhead-slot. Do not write, touch or delete them by hand; ' +
      'use `bulkhead-slot run --gb=N -- <command>`, which releases its slot when the command exits. `bulkhead-slot status` shows the holders.'
  }
  if (queued(cmd) || !isHeavy(cmd, mode)) return null
  const { freeGb, totalGb, pressure } = memory()
  if (minFreeGb == null) minFreeGb = limits(totalGb).minFreeGb
  // macOS says outright how stressed memory is; a low estimate with normal pressure is not a reason to block
  if (freeGb >= minFreeGb && !(pressure >= 2)) return null
  const n = sessions()
  const who = n > 1 ? `${n} Claude sessions are running and may be building or testing too.`
    : n === 1 ? 'Only this session is running, so other programs are using the RAM.' : ''
  const why = pressure >= 2 ? `memory pressure is ${pressure >= 4 ? 'critical' : 'warning'}`
    : `only ${freeGb.toFixed(1)} GB of RAM is free (minimum ${minFreeGb} GB: ${minimumSource(minFreeGb, totalGb)})`
  return `[bulkhead] memory-guard: ${why} and this looks like a heavy command.\n` +
    (who ? who + '\n' : '') +
    'Starting more work at this point is how machines freeze. Wait a minute, use fewer workers (for example --maxWorkers=2), or queue it:\n' +
    `  ${slotLine(cmd, mode, setting('memoryGuard.estimatesGb', null))}\n` +
    'bulkhead-slot waits until there is room, runs the command, and frees the slot when it exits.' +
    (remote() ? '\nOr run it on another machine, so it uses that machine\'s RAM:\n  bulkhead remote run -- <command>' : '')
}

// { rule, message } with the rule name the hook logs, or null.
function decide(cmd, memory, minFreeGb, mode, remote) {
  const message = check(cmd, memory, minFreeGb, mode, remote)
  return message ? { rule: touchesSlotFiles(cmd) ? 'slot-files' : 'low-memory', message } : null
}

// With memoryGuard.autoQueue on, a heavy command is not blocked: the hook rewrites it to run through
// bulkhead-slot, whatever the free RAM is, so every session waits in the same line. Returns
// { command, gb, label } or null when the command stays as it is (not heavy, already queued, in
// the background, on another machine, long-running, or the slot script cannot be found).
function autoQueue(input, o = {}) {
  const ti = (input && input.tool_input) || {}
  const cmd = ti.command
  if (typeof cmd !== 'string' || !cmd.trim() || ti.run_in_background === true) return null
  const mode = shell.modeFor(input)
  if (queue.wrapped(cmd) || touchesSlotFiles(cmd) || queue.backgrounded(cmd, mode)) return null
  const found = findHeavy(cmd, mode)
  if (!found || found.long || found.remote) return null
  const script = o.script !== undefined ? o.script : queue.slotScript()
  if (!script) return null
  const gb = queue.estimateGb(found.name, o.estimates)
  const label = queue.labelFor(found.argv)
  const command = queue.wrap(cmd, { shell: mode, script, gb, label, wait: o.wait, node: o.node, env: o.env, exists: o.exists, platform: o.platform })
  return command ? { command, gb, label } : null
}

function queueOutput(input, q) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...input.tool_input, command: q.command },
      additionalContext: `bulkhead queued this command (${q.label}, about ${q.gb} GB): it starts when the machine has room and prints its position every 30 s.`,
    },
  }
}

if (require.main === module) {
  runHook('memory-guard', input => {
    const cmd = input.tool_input && input.tool_input.command
    if (typeof cmd !== 'string') return
    if (setting('memoryGuard.autoQueue', false) === true && !touchesSlotFiles(cmd)) {
      const q = autoQueue(input, { estimates: setting('memoryGuard.estimatesGb', null), wait: setting('memoryGuard.waitMinutes', 10) })
      // no permissionDecision: the user's permission settings still apply to the rewritten command
      if (q) return { output: queueOutput(input, q) }
    }
    const hit = decide(cmd, undefined, undefined, shell.modeFor(input))
    if (!hit) return
    return blocked('memory-guard', hit.rule, input, hit.message)
  })
}

module.exports = { check, decide, isHeavy, findHeavy, touchesSlotFiles, autoQueue, queueOutput }
