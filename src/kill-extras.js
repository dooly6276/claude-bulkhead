'use strict'
// Kills that are not "a program by name" but still take down other sessions' work: every process
// of a user, every container, a shared app or service, a device server. Each detector returns
// [rule, why, check] or null. check(table, env) runs only after the cheap text test matched, and
// answers with the sentence to show or null. Most of these stop nothing when no other Claude
// session is alive, so a person working alone is never asked.
const shell = require('./shell')
const owners = require('./kill-owners')

const APPS = [
  'safari', 'visual studio code', 'terminal', 'iterm2', 'iterm', 'tmux', 'screen', 'warp', 'ghostty', 'alacritty', 'kitty',
  'coresimulator', 'simctl', 'slack', 'finder', 'dock', 'spotify', 'figma', 'notion', 'discord', 'zoom', 'zoom.us', 'webkit',
  'obsidian', 'postman', 'tableplus', 'sublime text', 'intellij idea', 'pycharm', 'webstorm', 'android studio',
]
const SERVICES = [
  'redis-server', 'redis', 'mongod', 'mongodb', 'mysqld', 'mysql', 'mariadbd', 'nginx', 'caddy', 'ngrok', 'cloudflared',
  'memcached', 'rabbitmq-server', 'elasticsearch', 'httpd', 'dnsmasq', 'tailscaled', 'minio', 'postgresql',
]
const SERVICE_TEXT = /homebrew\.mxcl|postgres|mysql|mariadb|redis|mongo|nginx|caddy|memcache|rabbit|elastic|dnsmasq|tailscale|minio|docker|colima|ngrok|cloudflared|httpd/i

function nameIn(list, word) {
  const w = String(word || '').trim().replace(/^["']+|["']+$/g, '').toLowerCase().replace(/\.(?:exe|app)$/, '')
  if (!w || w.length > 100) return false
  return list.some(n => w === n || (n.length >= 5 && w.includes(n)))
}

const isApp = word => nameIn(APPS, word)
const isService = word => nameIn(SERVICES, word)

const fixed = (rule, why, check) => [rule, why, check]

// kill -9 -1, kill 0 and the like: every process the user may signal, or the whole group.
function killOperands(argv) {
  const pids = []
  let signal = false
  let done = false
  for (let k = 1; k < argv.length; k++) {
    const v = argv[k]
    if (!done && v === '--') { done = true; continue }
    if (!done && (v === '-s' || v === '-n')) {
      // signal 0 only tests that the process exists
      if (/^(?:0|SIG0)$/i.test(argv[k + 1] || '')) return { list: true, pids }
      signal = true
      k++
      continue
    }
    if (!done && v === '-0') return { list: true, pids }
    if (!done && (v === '-l' || v === '-L')) return { list: true, pids }
    if (!done && /^-(?:\d+|[A-Za-z][A-Za-z0-9]*)$/.test(v) && !signal) { signal = true; continue }
    if (/^-?\d+$/.test(v)) pids.push(Number(v))
  }
  return { list: false, pids }
}

// Detectors that read one command. mode is 'sh' or 'ps'.
function detect(argv, { mode = 'sh', off = new Set(), stmt = [], env = new Map() } = {}) {
  const b = shell.bin(argv[0])
  const on = rule => !off.has(rule)
  if (b === 'kill' || (mode === 'ps' && /^kill$/i.test(argv[0]))) return killCheck(argv, on)
  if (b === 'taskkill') return taskkillCheck(argv, on)
  if (/^(?:stop-process|spps)$/i.test(argv[0])) return stopProcessCheck(argv, on)
  if ((b === 'pkill' || b === 'killall') && on('mass-kill')) {
    const hit = userKill(argv, b)
    if (hit) return hit
  }
  if (/^(?:docker|podman|docker-compose|podman-compose|nerdctl)$/.test(b) && on('docker-mass')) return dockerCheck(argv, b, stmt)
  if (b === 'pm2' && on('docker-mass')) return pm2Check(argv)
  if (b === 'adb' && on('device-kill')) return adbCheck(argv, env)
  if ((b === 'xcrun' || b === 'simctl') && on('device-kill')) return simctlCheck(argv)
  if (b === 'osascript' && on('app-quit')) return osascriptCheck(argv)
  if ((b === 'brew' || b === 'launchctl' || b === 'systemctl' || b === 'service') && on('service-stop')) return serviceCheck(argv, b)
  return null
}

function killCheck(argv, on) {
  const { list, pids } = killOperands(argv)
  if (list || !pids.length) return null
  if (on('mass-kill') && pids.some(p => p === -1 || p === 0)) {
    return fixed('mass-kill', 'kill -1 and kill 0 signal every process you may signal.', t => owners.othersCheck(t))
  }
  const literal = pids.filter(p => p > 0 || p < -1)
  if (on('owner-check') && literal.length) return fixed('other-session-pid', '', t => owners.pidsCheck(t, literal))
  return null
}

function taskkillCheck(argv, on) {
  if (!on('owner-check')) return null
  const pids = []
  for (let k = 1; k < argv.length - 1; k++) if (/^(?:\/\/?|-)pid$/i.test(argv[k]) && /^\d+$/.test(argv[k + 1])) pids.push(Number(argv[++k]))
  return pids.length ? fixed('other-session-pid', '', t => owners.pidsCheck(t, pids)) : null
}

function stopProcessCheck(argv, on) {
  if (!on('owner-check')) return null
  const pids = []
  for (let k = 1; k < argv.length - 1; k++) {
    if (/^-id$/i.test(argv[k])) for (const n of argv[++k].split(',')) if (/^\d+$/.test(n)) pids.push(Number(n))
  }
  return pids.length ? fixed('other-session-pid', '', t => owners.pidsCheck(t, pids)) : null
}

// pkill -u $USER and killall -u name with no program name: everything of that user.
function userKill(argv, b) {
  const rest = argv.slice(1)
  const user = rest.findIndex(a => /^(?:-u|-U|--user|--uid|--euid)(?:=.*)?$/.test(a))
  if (user < 0) return null
  const valued = new Set(['-u', '-U', '--user', '--uid', '--euid', '-s', '--signal', '-g', '-G', '-P', '-t'])
  const operands = []
  for (let k = 0; k < rest.length; k++) {
    if (valued.has(rest[k])) { k++; continue }
    if (/^-/.test(rest[k])) continue
    operands.push(rest[k])
  }
  if (operands.length) return null
  return fixed('mass-kill', `${b} -u kills every process of that user.`, t => owners.othersCheck(t))
}

const DOCKER_KILLERS = new Set(['rm', 'stop', 'kill', 'restart', 'rmi', 'pause', 'unpause'])

function dockerArgs(argv) {
  const out = []
  for (let k = 1; k < argv.length; k++) {
    if (/^-/.test(argv[k])) { if (/^(?:-H|--host|--context|-c|--config|-p|--project-name|-f|--file|--env-file|--profile|--project-directory)$/.test(argv[k])) k++; continue }
    out.push(argv[k])
  }
  return out
}

function dockerCheck(argv, b, stmt) {
  const args = dockerArgs(argv)
  const sub = /compose$/.test(b) ? 'compose' : args[0]
  const second = /compose$/.test(b) ? args[0] : args[1]
  if (sub === 'system' && second === 'prune') return mass('docker system prune removes containers, networks and images for everyone.')
  if (second === 'prune' && /^(?:container|volume)$/.test(sub)) return mass(`docker ${sub} prune removes everyone's unused ${sub}s.`)
  if (second === 'prune' && /^(?:image|builder)$/.test(sub) && argv.some(a => /^(?:-a|-af|-fa|--all)$/.test(a))) return mass(`docker ${sub} prune -a removes everyone's unused ${sub}s.`)
  if (sub === 'compose' || sub === 'stack') {
    if (!/^(?:down|stop|rm|kill|restart)$/.test(second || '')) return null
    const f = argv.findIndex(a => a === '-f' || a === '--file' || a === '--project-directory')
    const dir = f > 0 && argv[f + 1] ? argv[f + 1].replace(/[\\/][^\\/]*\.ya?ml$/, '') : ''
    return fixed('docker-mass', `docker compose ${second} stops the containers of that project.`, (t, env) => owners.sameProjectCheck(t, dir && dir !== argv[f + 1] ? dir : env.cwd))
  }
  const killer = DOCKER_KILLERS.has(sub) || (sub === 'container' && DOCKER_KILLERS.has(second))
  // docker ps -q | xargs docker stop: the ids come from the pipe
  const noIds = killer && !args.slice(sub === 'container' ? 2 : 1).length
  if (noIds && stmt.some(c => listsEveryContainer(c.argv)) && stmt.every(c => c.argv === argv || !c.argv.length || listsEveryContainer(c.argv))) return mass('Stopping or removing every container touches other sessions\' containers.')
  if (killer && argv.some(a => /^(?:\$\(|`)\s*(?:docker|podman)\s+(?:ps|container\s+ls|container\s+list|images|image\s+ls)\b/.test(a) && !/--filter|\s-f\b/.test(a))) {
    return mass('Stopping or removing every container touches other sessions\' containers.')
  }
  return null
}

function listsEveryContainer(argv) {
  if (!/^(?:docker|podman)$/.test(shell.bin(argv[0] || ''))) return false
  const a = dockerArgs(argv)
  const listing = a[0] === 'ps' || (a[0] === 'container' && /^(?:ls|list)$/.test(a[1])) || a[0] === 'images' || (a[0] === 'image' && a[1] === 'ls')
  return listing && argv.some(x => /^-[a-z]*q/.test(x) || x === '--quiet') && !argv.some(x => /^--filter|^-f$|^-f.+=/.test(x))
}

function mass(why) {
  return fixed('docker-mass', why, t => owners.othersCheck(t))
}

function pm2Check(argv) {
  const a = argv.slice(1).filter(x => !/^-/.test(x))
  if (a[0] === 'kill' || (/^(?:stop|delete|restart|reload)$/.test(a[0] || '') && a[1] === 'all')) {
    return fixed('docker-mass', `pm2 ${a[0]}${a[1] ? ' all' : ''} stops every process pm2 runs, for every project.`, t => owners.othersCheck(t))
  }
  return null
}

function adbCheck(argv, env) {
  const a = argv.slice(1)
  // -s, -e and -d name one device; so does ANDROID_SERIAL
  const own = a.some(x => /^-[sed]$/.test(x)) || env.has('ANDROID_SERIAL')
  if (a.includes('kill-server') || (a.includes('emu') && a[a.indexOf('emu') + 1] === 'kill' && !own)) {
    return fixed('device-kill', 'adb kill-server and adb emu kill drop every device connection and emulator.', t => owners.othersCheck(t))
  }
  return null
}

function simctlCheck(argv) {
  const at = argv.findIndex(a => shell.bin(a) === 'simctl')
  if (at < 0) return null
  const [verb, target] = argv.slice(at + 1)
  if (/^(?:shutdown|erase|delete)$/.test(verb || '') && /^(?:all|booted)$/.test(target || '')) {
    return fixed('device-kill', `simctl ${verb} ${target} reaches every simulator.`, t => owners.othersCheck(t))
  }
  return null
}

function osascriptCheck(argv) {
  const text = argv.slice(1).join(' ')
  if (!/\bquit\b/i.test(text)) return null
  for (const m of text.matchAll(/"([^"]{1,80})"/g)) {
    if (isApp(m[1]) || isService(m[1]) || /^(?:google chrome|chromium|firefox|microsoft edge|simulator|xcode|docker|docker desktop|cursor|electron)$/i.test(m[1])) {
      return fixed('app-quit', `Quitting ${m[1]} closes it for everyone.`, t => owners.othersCheck(t))
    }
  }
  return null
}

function serviceCheck(argv, b) {
  const a = argv.slice(1)
  const words = a.filter(x => !/^-/.test(x))
  const text = a.join(' ')
  let hit = false
  if (b === 'brew') hit = words[0] === 'services' && /^(?:stop|restart|kill|cleanup)$/.test(words[1] || '') && (a.includes('--all') || isService(words[2]) || SERVICE_TEXT.test(words[2] || ''))
  else if (b === 'launchctl') {
    const verb = words[0]
    if (/^(?:bootout|unload|remove|stop|kill|disable)$/.test(verb || '') || (verb === 'kickstart' && a.includes('-k'))) {
      hit = SERVICE_TEXT.test(text) || (verb === 'bootout' && words.slice(1).every(x => /^(?:gui|user|system)\/\d*$/.test(x)))
    }
  } else if (b === 'systemctl' || b === 'service') {
    hit = /^(?:stop|restart|kill|disable|mask)$/.test(words.find(x => /^(?:stop|restart|kill|disable|mask)$/.test(x)) || '') && SERVICE_TEXT.test(text)
  }
  return hit ? fixed('service-stop', `Stopping or restarting a shared service (${b} ${words.slice(0, 3).join(' ')}) takes it away from every session.`, t => owners.othersCheck(t)) : null
}

module.exports = { detect, isApp, isService, killOperands, APPS, SERVICES }
