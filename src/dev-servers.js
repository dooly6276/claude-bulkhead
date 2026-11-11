'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const shell = require('./shell')

// Dev servers and the port each one uses when none is given. `sub` lists the subcommands
// that start a server; '' means the bare command does, null means any arguments do. `notSub`
// is the reverse: every subcommand except these. `test(args)` is an extra gate on the arguments,
// `need` means the tool serves only when a port flag or environment variable says where, `scan`
// reads the port out of the joined arguments (`--args='--server.port=3000'`), `version` lists
// extra flags that only print a version.
const TOOLS = [
  { bin: ['next'], sub: ['dev', 'start'], port: 3000, flags: ['-p', '--port'], env: ['PORT'], version: ['-v'] },
  { bin: ['vite'], sub: ['preview'], port: 4173, flags: ['--port'], version: ['-v'] },
  // vite [root] and vite dev|serve start the server; build and optimize do not
  { bin: ['vite'], notSub: ['build', 'optimize', 'preview'], port: 5173, flags: ['--port'], version: ['-v'] },
  { bin: ['astro'], sub: ['dev', 'preview'], port: 4321, flags: ['--port'] },
  { bin: ['nuxt', 'nuxi'], sub: ['dev'], port: 3000, flags: ['-p', '--port'], env: ['NUXT_PORT', 'PORT'] },
  { bin: ['remix'], sub: ['dev'], port: 3000, flags: ['--port'], env: ['PORT'] },
  { bin: ['remix'], sub: ['vite:dev'], port: 5173, flags: ['--port'] },
  { bin: ['expo'], sub: ['start'], port: 8081, flags: ['-p', '--port'], env: ['RCT_METRO_PORT'] },
  { bin: ['react-native', 'metro'], sub: ['start', 'serve'], port: 8081, flags: ['--port'], env: ['RCT_METRO_PORT'] },
  { bin: ['uvicorn'], sub: null, port: 8000, flags: ['--port'] },
  { bin: ['hypercorn'], sub: null, port: 8000, flags: ['-b', '--bind'], arg: n => `--bind :${n}` },
  { bin: ['gunicorn'], sub: null, port: 8000, flags: ['-b', '--bind'], env: ['PORT'], arg: n => `--bind :${n}` },
  { bin: ['fastapi'], sub: ['dev', 'run'], port: 8000, flags: ['--port'] },
  { bin: ['flask'], sub: ['run'], port: 5000, flags: ['-p', '--port'], env: ['FLASK_RUN_PORT'] },
  { bin: ['rails'], sub: ['s', 'server'], port: 3000, flags: ['-p', '--port'], env: ['PORT'] },
  { bin: ['puma'], sub: null, port: 9292, flags: ['-p', '--port', '-b', '--bind'], env: ['PORT'], arg: n => `-p ${n}` },
  { bin: ['rackup'], sub: null, port: 9292, flags: ['-p', '--port'] },
  { bin: ['gatsby'], sub: ['develop'], port: 8000, flags: ['-p', '--port'] },
  { bin: ['gatsby'], sub: ['serve'], port: 9000, flags: ['-p', '--port'] },
  { bin: ['ng', 'nx', 'ember'], sub: ['serve', 's'], port: 4200, flags: ['--port'] },
  { bin: ['webpack'], sub: ['serve'], port: 8080, flags: ['--port'] },
  { bin: ['webpack-dev-server'], sub: null, port: 8080, flags: ['--port'] },
  { bin: ['vue-cli-service'], sub: ['serve'], port: 8080, flags: ['--port'] },
  { bin: ['rspack'], sub: ['serve', 'dev', 's'], port: 8080, flags: ['--port'] },
  { bin: ['rsbuild'], sub: ['dev'], port: 3000, flags: ['--port'] },
  { bin: ['react-scripts', 'craco'], sub: ['start'], port: 3000, flags: [], env: ['PORT'] },
  { bin: ['parcel'], notSub: ['build', 'watch'], port: 1234, flags: ['-p', '--port'] },
  { bin: ['hugo'], sub: ['server', 'serve'], port: 1313, flags: ['-p', '--port'] },
  { bin: ['jekyll'], sub: ['serve', 's'], port: 4000, flags: ['-P', '--port'] },
  { bin: ['hexo'], sub: ['server', 's'], port: 4000, flags: ['-p', '--port'] },
  { bin: ['zola'], sub: ['serve'], port: 1111, flags: ['-p', '--port'] },
  { bin: ['mdbook'], sub: ['serve'], port: 3000, flags: ['-p', '--port'] },
  { bin: ['mkdocs'], sub: ['serve'], port: 8000, flags: ['-a', '--dev-addr'], arg: n => `-a localhost:${n}` },
  { bin: ['trunk'], sub: ['serve'], port: 8080, flags: ['--port'] },
  { bin: ['eleventy', '11ty'], sub: null, port: 8080, flags: ['--port'], test: a => a.includes('--serve') },
  { bin: ['vuepress', 'vuepress-vite', 'vuepress-webpack'], sub: ['dev'], port: 8080, flags: ['-p', '--port'] },
  { bin: ['vitepress'], sub: ['dev'], port: 5173, flags: ['--port'] },
  { bin: ['vitepress'], sub: ['preview', 'serve'], port: 4173, flags: ['--port'] },
  { bin: ['storybook'], sub: ['dev'], port: 6006, flags: ['-p', '--port'] },
  { bin: ['wrangler'], sub: ['dev'], port: 8787, flags: ['--port'] },
  { bin: ['netlify'], sub: ['dev'], port: 8888, flags: ['-p', '--port'] },
  { bin: ['vercel', 'vc'], sub: ['dev'], port: 3000, flags: ['-l', '--listen'] },
  { bin: ['docusaurus'], sub: ['start'], port: 3000, flags: ['-p', '--port'] },
  { bin: ['http-server'], sub: null, port: 8080, flags: ['-p', '--port'], env: ['PORT'] },
  { bin: ['live-server'], sub: null, port: 8080, flags: ['--port'], env: ['PORT'] },
  { bin: ['serve'], sub: null, port: 3000, flags: ['-l', '--listen', '-p'], arg: n => `-l ${n}` },
  { bin: ['json-server'], sub: null, port: 3000, flags: ['-p', '--port'], env: ['PORT'] },
  { bin: ['lite-server'], sub: null, port: 3000, flags: ['--port'] },
  { bin: ['browser-sync'], sub: null, port: 3000, flags: ['-p', '--port'] },
  { bin: ['streamlit'], sub: ['run'], port: 8501, flags: ['--server.port'], env: ['STREAMLIT_SERVER_PORT'] },
  { bin: ['jupyter'], sub: ['notebook', 'lab', 'server', 'nbclassic'], port: 8888, flags: ['--port', '--NotebookApp.port', '--ServerApp.port'], arg: n => `--port ${n}` },
  { bin: ['jupyter-lab', 'jupyter-notebook'], sub: null, port: 8888, flags: ['--port', '--NotebookApp.port', '--ServerApp.port'], arg: n => `--port ${n}` },
  { bin: ['mix'], sub: ['phx.server'], port: 4000, flags: [], env: ['PORT'] },
  // Spring Boot: 8080 unless a server.port says otherwise
  { bin: ['gradle', 'gradlew'], sub: null, port: 8080, flags: ['--server.port', '-Dserver.port'], env: ['SERVER_PORT'], scan: /server\.port[=\s]+(\d+)/, arg: n => `--args='--server.port=${n}'`, test: a => a.includes('bootRun') },
  { bin: ['mvn', 'mvnw'], sub: null, port: 8080, flags: ['--server.port', '-Dserver.port'], env: ['SERVER_PORT'], scan: /server\.port[=\s]+(\d+)/, arg: n => `-Dspring-boot.run.arguments=--server.port=${n}`, test: a => a.includes('spring-boot:run') },
  // these serve only where an explicit port says so: php -S host:port, java -jar app.jar --server.port=N, dotnet run --urls ...
  { bin: ['php'], sub: null, flags: ['-S'], need: true, arg: n => `-S localhost:${n}` },
  { bin: ['ruby'], sub: null, port: 8080, flags: ['-p'], test: a => a.includes('-run') && a.some(x => /^(?:-e)?httpd\b/.test(x)) },
  { bin: ['java'], sub: null, flags: ['--server.port', '-Dserver.port', '--port'], env: ['SERVER_PORT', 'PORT'], need: true, arg: n => `--server.port=${n}`, test: a => a.includes('-jar') },
  { bin: ['dotnet'], sub: ['run', 'watch'], flags: ['--urls'], env: ['ASPNETCORE_HTTP_PORTS'], need: true, arg: n => `--urls http://localhost:${n}` },
  // positional ports
  { bin: ['http.server'], sub: null, port: 8000, positional: /^(\d+)$/ },
  { bin: ['manage.py', 'django-admin', 'django'], sub: ['runserver', 'runserver_plus'], port: 8000, positional: /^(?:[\w.[\]]*:)?(\d+)$/ },
  { bin: ['artisan'], sub: ['serve'], port: 8000, flags: ['--port'] },
]

// Programs that run a file and read the port from PORT; the port must be named in the command.
const RUNTIMES = [
  { bin: /^(?:node|nodemon|tsx|ts-node|bun|deno)$/, ok: a => a.some(x => !x.startsWith('-') && /\.(?:[cm]?[jt]sx?)$/.test(x)) },
  { bin: /^(?:python[\d.]*|py)$/, ok: a => a.some(x => !x.startsWith('-') && /\.py$/.test(x)) },
  { bin: /^ruby$/, ok: a => a.some(x => !x.startsWith('-') && /\.rb$/.test(x)) },
  { bin: /^go$/, ok: a => a[0] === 'run' },
  { bin: /^cargo$/, ok: a => /^(?:run|watch)$/.test(a[0]) },
]

const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const OPT_WITH_VALUE = /^(?:--prefix|-C|--cwd|--dir|--filter|-F|--workspace|-w|--workspace-root)$/

// A token after which the wrapped command starts, for each wrapper: how many tokens it takes.
// `skipFlags` passes options, the ones in `valued` also take the next token.
const skipFlags = (t, i, valued = []) => {
  while (i < t.length && /^-/.test(t[i]) && t[i] !== '--') i += valued.includes(t[i]) ? 2 : 1
  return t[i] === '--' ? i + 1 : i
}
const afterDashes = (t, i) => {
  const j = t.indexOf('--', i)
  return j >= 0 ? j + 1 : -1
}
const PKG_FLAGS = ['-p', '--package', '-c', '--call', '-w', '--workspace', '--prefix', '--registry', '--node-options']
const WRAPPERS = {
  npx: (t, i) => skipFlags(t, i + 1, PKG_FLAGS),
  bunx: (t, i) => skipFlags(t, i + 1, PKG_FLAGS),
  pnpx: (t, i) => skipFlags(t, i + 1, PKG_FLAGS),
  uvx: (t, i) => skipFlags(t, i + 1, ['--from', '--with', '-p', '--python']),
  nohup: (t, i) => i + 1,
  exec: (t, i) => skipFlags(t, i + 1, ['-a']),
  time: (t, i) => skipFlags(t, i + 1, ['-f', '-o', '--format', '--output']),
  command: (t, i) => i + 1,
  builtin: (t, i) => i + 1,
  setsid: (t, i) => skipFlags(t, i + 1),
  nice: (t, i) => skipFlags(t, i + 1, ['-n', '--adjustment']),
  ionice: (t, i) => skipFlags(t, i + 1, ['-c', '-n', '-p']),
  stdbuf: (t, i) => skipFlags(t, i + 1),
  unbuffer: (t, i) => skipFlags(t, i + 1),
  caffeinate: (t, i) => skipFlags(t, i + 1, ['-t', '-w']),
  sudo: (t, i) => skipFlags(t, i + 1, ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U']),
  doas: (t, i) => skipFlags(t, i + 1, ['-u', '-C']),
  env: (t, i) => skipFlags(t, i + 1, ['-u', '-C', '-S', '-P']),
  'cross-env': (t, i) => skipFlags(t, i + 1),
  'env-cmd': (t, i) => {
    const d = afterDashes(t, i + 1)
    return d >= 0 ? d : skipFlags(t, i + 1, ['-f', '-e', '-r', '--file', '--environments', '--rc-file'])
  },
  dotenv: (t, i) => {
    const d = afterDashes(t, i + 1)
    return d >= 0 ? d : skipFlags(t, i + 1, ['-e', '-p', '-v', '-c'])
  },
  dotenvx: (t, i) => {
    const d = t[i + 1] === 'run' ? afterDashes(t, i + 2) : -1
    return d >= 0 ? d : i + 1
  },
  timeout: (t, i) => {
    let j = skipFlags(t, i + 1, ['-s', '--signal', '-k', '--kill-after'])
    if (/^\d+(?:\.\d+)?[smhd]?$/.test(t[j] || '')) j++
    return j
  },
}
// `<tool> <verb>` wrappers: npm exec, pnpm dlx, uv run, bundle exec, poetry run ...
const SUBWRAPPERS = {
  npm: /^(?:exec|x)$/,
  pnpm: /^(?:exec|dlx)$/,
  yarn: /^(?:exec|dlx)$/,
  bun: /^x$/,
  bundle: /^exec$/,
  uv: /^run$/,
  poetry: /^run$/,
  pipenv: /^run$/,
  pdm: /^run$/,
  rye: /^run$/,
  hatch: /^run$/,
  pixi: /^run$/,
  pipx: /^run$/,
  mise: /^(?:exec|x)$/,
  conda: /^run$/,
  direnv: /^exec$/,
}

// Words of one command without the keyword in front (`do npm run dev`) and without redirections.
function cleanWords(words, out = []) {
  let i = 0
  while (i < words.length && words[i].length <= 5 && /^(?:do|then|else|elif|if|while|until|\{|!)$/.test(words[i])) i++
  for (; i < words.length; i++) {
    const w = words[i]
    // only a word with < or > can be a redirection
    if (w.includes('>') || w.includes('<')) {
      if (/^\d*(?:>>?|<)$/.test(w)) { i++; continue }
      if (/^\d*[<>]/.test(w)) continue
    }
    out.push(w)
  }
  return out
}

// Every simple command in text order, each as its words. Quotes are respected, so
// grep -E "next dev|vite" is one command with a pattern, not two servers.
function commandsOf(cmd) {
  const { cmds } = shell.lex(String(cmd || ''))
  return cmds.slice().sort((a, b) => a.s - b.s).map(c => cleanWords(c.words.map(w => w.v))).filter(t => t.length)
}

const binNames = new Map()
function binName(t) {
  const key = String(t)
  let name = binNames.get(key)
  if (name === undefined) {
    name = path.basename(key).replace(/\.(?:cmd|exe|ps1)$/i, '').toLowerCase()
    if (binNames.size > 2000) binNames.clear()
    binNames.set(key, name)
  }
  return name
}

// Leading NAME=value pairs, `export NAME=value`, `set NAME=value` and `$env:NAME = value`.
function takeEnv(t, env) {
  let i = 0
  for (;;) {
    const w = t[i] || ''
    // a plain word (no =, no $) is neither an assignment nor $env:NAME
    if (!w.includes('=') && !w.includes('$') && !(w.length <= 6 && /^(?:export|set|env)$/i.test(w))) return i
    if (/^(?:export|set|env)$/i.test(t[i]) && /^\w+=/.test(t[i + 1] || '')) i++
    const ps = /^\$env:(\w+)(?:=(.*))?$/i.exec(t[i] || '')
    if (ps) {
      if (ps[2] !== undefined && ps[2] !== '') env[ps[1].toUpperCase()] = ps[2]
      else if (t[i + 1] === '=') { env[ps[1].toUpperCase()] = t[i + 2]; i += 2 }
      i++
      continue
    }
    const m = /^(\w+)=(.*)$/.exec(t[i] || '')
    if (!m) return i
    env[m[1].toUpperCase()] = m[2]
    i++
  }
}

// Index of the real command after npx, nohup, timeout 60, cross-env PORT=1, python -m and similar.
// NAME=value words on the way are added to env.
function commandStart(t, env) {
  let i = 0
  while (i < t.length) {
    const b = binName(t[i])
    const kv = t[i].includes('=') ? /^(\w+)=(.*)$/.exec(t[i]) : null
    if (kv) { env[kv[1].toUpperCase()] = kv[2]; i++ } else if (Object.hasOwn(WRAPPERS, b)) {
      const j = WRAPPERS[b](t, i)
      if (!(j > i)) break
      i = j
    } else if (Object.hasOwn(SUBWRAPPERS, b) && SUBWRAPPERS[b].test(t[i + 1] || '')) i = skipFlags(t, i + 2, PKG_FLAGS.concat(['--with', '--python', '--from']))
    else if (/^python[\d.]*$|^py$/.test(b) && t[i + 1] === '-m') i += 2
    else if (/^python[\d.]*$|^py$|^php$/.test(b) && /^(?:manage\.py|artisan)$/.test(binName(t[i + 1] || ''))) i += 1
    else break
  }
  return i
}

// The port in a flag value: 3000, :3000, 0.0.0.0:3000, tcp://0.0.0.0:3000, http://localhost:3000;https://x:3001
function portOf(v) {
  const s = String(v)
  if (/^\d+$/.test(s)) return Number(s)
  const m = /^(?:[\w+.-]+:\/\/)?[^/\s;,]*:(\d+)/.exec(s)
  return m ? Number(m[1]) : null
}

// The last port flag wins, as in `npm run dev -- -p 3001` over a script's `next dev -p 3000`.
function flagPort(args, flags = []) {
  let port
  for (let i = 0; i < args.length; i++) {
    for (const f of flags) {
      let v
      if (args[i] === f) v = args[i + 1]
      else if (args[i].startsWith(f + '=')) v = args[i].slice(f.length + 1)
      else if (/^-[a-zA-Z]$/.test(f) && args[i].startsWith(f) && /^\d+$/.test(args[i].slice(2))) v = args[i].slice(2)
      if (v !== undefined) port = portOf(v)
    }
  }
  return port
}

function toolPort(tool, args, env) {
  if (tool.positional) {
    const hit = args.map(a => tool.positional.exec(a)).find(Boolean)
    return hit ? Number(hit[1]) : tool.port
  }
  const flag = flagPort(args, tool.flags)
  if (flag !== undefined) return flag
  if (tool.scan) {
    const m = tool.scan.exec(args.join(' '))
    if (m) return Number(m[1])
  }
  for (const name of tool.env || []) {
    if (env[name] !== undefined) return portOf(env[name])
  }
  return tool.port
}

const INFO_FLAGS = new Set(['--help', '-h', '--version'])

// TOOLS by program name, in TOOLS order, so a word that is no server is dropped with one lookup.
let toolsByBin
function toolsFor(bin) {
  if (!toolsByBin) {
    toolsByBin = new Map()
    for (const tool of TOOLS) for (const b of tool.bin) (toolsByBin.get(b) || toolsByBin.set(b, []).get(b)).push(tool)
  }
  return toolsByBin.get(bin) || []
}

function matchTool(t, env) {
  const bin = binName(t[0] || '')
  const sub = t[1] && !t[1].startsWith('-') ? t[1] : ''
  for (const tool of toolsFor(bin)) {
    if (tool.sub && !tool.sub.includes(sub)) continue
    if (tool.notSub && tool.notSub.includes(sub)) continue
    const args = t.slice(1)
    if (args.some(a => INFO_FLAGS.has(a) || (tool.version || []).includes(a))) continue
    if (tool.test && !tool.test(args)) continue
    const argsAt = sub && tool.sub && tool.sub.includes(sub) ? 2 : 1
    const port = toolPort(tool, t.slice(argsAt), env)
    if (tool.need && port === undefined) continue
    return { tool, argsAt, port }
  }
  return null
}

// npm run dev, npm start, pnpm dev, yarn dev, bun run dev -> { runner, script, extra, at, workspace }
function scriptCall(t) {
  const runner = binName(t[0] || '')
  if (!RUNNERS.has(runner)) return null
  let i = 1
  let workspace
  while (/^-/.test(t[i] || '')) {
    if (/^(?:--filter|-F|--workspace|-w)$/.test(t[i])) workspace = t[i + 1]
    else if (/^--(?:filter|workspace)=/.test(t[i])) workspace = t[i].split('=')[1]
    i += OPT_WITH_VALUE.test(t[i]) ? 2 : 1
  }
  let script = t[i]
  if (runner === 'yarn' && script === 'workspace') { workspace = t[i + 1]; i += 2; script = t[i] }
  if (script === 'run' || script === 'run-script') script = t[++i]
  else if (runner === 'npm' && script !== 'start') return null
  if (!script || script === 'install' || script === 'test') return null
  const extra = []
  const after = t.slice(i + 1)
  for (let k = 0; k < after.length; k++) {
    if (/^(?:--workspace|-w|--filter|-F)$/.test(after[k]) && after[k + 1]) { workspace = after[++k]; continue }
    if (/^--(?:workspace|filter)=/.test(after[k])) { workspace = after[k].split('=')[1]; continue }
    if (after[k] !== '--') extra.push(after[k])
  }
  return { runner, script, extra, at: i, workspace }
}

function prefixDir(t, dir) {
  const i = t.findIndex(a => /^(?:--prefix|-C|--cwd|--dir)$/.test(a))
  return i > 0 && t[i + 1] ? resolveDir(dir, t[i + 1]) : dir
}

function resolveDir(dir, to) {
  if (/^~(?:\/|$)/.test(to)) to = path.join(os.homedir(), to.slice(1))
  const win = /^\/([a-z])(?:\/|$)/i.exec(to)
  const target = process.platform === 'win32' && win ? `${win[1]}:/${to.slice(3)}` : to
  return path.resolve(dir || '.', target)
}

function readScripts(dir, readFile) {
  try {
    return JSON.parse(readFile(path.resolve(dir, 'package.json'), 'utf8')).scripts || {}
  } catch {
    return {}
  }
}

// `pnpm --filter web dev` runs web's package.json: look in the usual workspace folders.
function workspaceDir(dir, name, readFile) {
  const leaf = String(name).split('/').pop()
  for (const d of [`apps/${leaf}`, `packages/${leaf}`, `services/${leaf}`, leaf]) {
    const full = path.resolve(dir, d)
    try {
      readFile(path.resolve(full, 'package.json'), 'utf8')
      return full
    } catch { /* not this one */ }
  }
  return dir
}

const quote = a => (/[\s"]/.test(a) ? `'${a}'` : a)

// t without its first n words; the same array when n is 0, which saves a copy per segment of a long pipeline.
const dropFirst = (t, n) => (n ? t.slice(n) : t)

// Returns null when no known dev server starts, otherwise { port, portArg, hint } where port
// is null when it cannot be worked out and hint(n) shows how to start the same thing on port n.
// ports lists every port the command publishes when there is more than one (docker run -p ...).
function detect(cmd, { cwd = process.cwd(), readFile = fs.readFileSync, depth = 0, env = {} } = {}) {
  env = { ...env }
  let dir = cwd
  let unknown = null
  for (let t of commandsOf(cmd)) {
    t = dropFirst(t, takeEnv(t, env))
    if (!t.length) continue
    if (t[0].length <= 12 && /^(?:cd|pushd|Set-Location|sl)$/i.test(t[0])) {
      const to = t.slice(1).find(a => !/^[/-]d$/i.test(a) && a !== '--')
      if (to) dir = resolveDir(dir, to)
      continue
    }
    const skip = commandStart(t, env)
    const rest = dropFirst(t, skip)
    const hit = serverHit(t, skip, env) || containerHit(rest, dir, readFile) || scriptHit(t, skip, { dir, readFile, depth, env }) || envPortServer(rest, env)
    if (!hit) continue
    if (hit.port) return hit
    unknown = unknown || hit
  }
  return unknown
}

function serverHit(t, skip, env) {
  const hit = matchTool(dropFirst(t, skip), env)
  if (!hit) return null
  const { tool } = hit
  const flags = tool.flags || []
  const kept = withoutPort(t, skip + hit.argsAt, tool).map(quote)
  // tools that read the port from the environment only: PORT=n next to the command
  if (!tool.arg && !flags.length && tool.env) {
    const portArg = n => `${tool.env[0]}=${n}`
    return { port: hit.port, portArg, hint: n => [portArg(n), ...kept].join(' ') }
  }
  const portArg = tool.arg || (n => (flags.length ? `${flags[flags.length - 1]} ${n}` : String(n)))
  return { port: hit.port, portArg, hint: n => [...kept, portArg(n)].join(' ') }
}

function scriptHit(t, skip, { dir, readFile, depth, env }) {
  const rest = dropFirst(t, skip)
  const call = scriptCall(rest)
  if (!call) return null
  if (depth > 2) return null
  let runDir = prefixDir(rest, dir)
  if (call.workspace) runDir = workspaceDir(runDir, call.workspace, readFile)
  const body = readScripts(runDir, readFile)[call.script]
  if (!body) {
    // pnpm vite, yarn next dev, bun vite: no script of that name, so it is a program
    return call.runner === 'npm' ? null : serverHit(t, skip + call.at, env)
  }
  const inner = detect([body, ...call.extra].join(' '), { cwd: runDir, readFile, depth: depth + 1, env })
  if (!inner) return null
  if (inner.viaEnv && !SERVER_SCRIPT.test(call.script)) return null
  if (inner.viaEnv) return { port: inner.port, viaEnv: true, portArg: inner.portArg, hint: n => `PORT=${n} ${call.runner} run ${call.script}` }
  return { port: inner.port, portArg: inner.portArg, hint: n => `${call.runner} run ${call.script} -- ${inner.portArg(n)}` }
}

const SERVER_SCRIPT = /^(?:start|dev|serve|server|develop|watch|(?:start|dev|serve):[\w:-]+)$/i
const envPort = env => (/^\d+$/.test(env.PORT || '') && Number(env.PORT) > 0 && Number(env.PORT) < 65536 ? Number(env.PORT) : null)

// A program running a file with PORT set in the command: node server.js, go run ., python app.py, cargo run.
function envPortServer(t, env) {
  const bin = binName(t[0] || '')
  const port = envPort(env)
  if (port == null) return null
  const rt = RUNTIMES.find(r => r.bin.test(bin))
  if (!rt || !rt.ok(t.slice(1))) return null
  return { port, viaEnv: true, portArg: n => `PORT=${n}`, hint: n => `PORT=${n} ${t.map(quote).join(' ')}` }
}

// docker run -p 3000:3000 image, docker compose up (ports from the compose file in the directory)
function containerHit(t, dir, readFile) {
  const bin = binName(t[0] || '')
  if (!/^(?:docker|podman|nerdctl|docker-compose|podman-compose)$/.test(bin)) return null
  const verb = containerVerb(t, bin)
  if (/^(?:run|container run)$/.test(verb)) {
    const hosts = publishedPorts(t)
    if (!hosts.length) return null
    const ports = hosts.map(h => h.port)
    return { port: ports[0], ports, portArg: String, hint: n => hostHint(t, hosts[0], n) }
  }
  if (!/^(?:compose up|up)$/.test(verb)) return null
  for (const f of composeFiles(t, dir)) {
    let text
    try { text = readFile(f, 'utf8') } catch { continue }
    const ports = composePorts(String(text))
    if (ports.length) return { port: ports[0], ports, portArg: String, hint: n => `${t.join(' ')} (publish ${n} instead of ${ports[0]} in ${path.basename(f)})` }
  }
  return null
}

// "run", "container run", "compose up" or "up": the words after the global options.
function containerVerb(t, bin) {
  const words = []
  for (let i = 1; i < t.length && words.length < 2; i++) {
    if (/^(?:-f|--file|-H|--host|--context|--project-name|--project-directory|--profile|--env-file)$/.test(t[i]) || (t[i] === '-p' && bin !== 'docker')) i++
    else if (!t[i].startsWith('-')) words.push(t[i])
    if (words[0] === 'run' || words[0] === 'up') break
  }
  return words.join(' ')
}

function composeFiles(t, dir) {
  const files = []
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '-f' || t[i] === '--file') files.push(path.resolve(dir, t[i + 1] || ''))
    else if (/^--file=/.test(t[i])) files.push(path.resolve(dir, t[i].slice(7)))
  }
  if (files.length) return files
  return ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'].map(n => path.resolve(dir, n))
}

// Host ports of every -p/--publish option: 3000:3000, 127.0.0.1:3000:80/tcp, 8000-8010:8000-8010.
function publishedPorts(t) {
  const out = []
  for (let i = 0; i < t.length; i++) {
    const m = /^(?:-p|--publish)(?:=(.*))?$/.exec(t[i]) || /^-p(\d[^\s]*)$/.exec(t[i])
    if (!m) continue
    const spec = m[1] !== undefined ? m[1] : t[i + 1]
    const port = hostPort(spec)
    if (port) out.push({ port, spec, at: i, inline: m[1] !== undefined })
  }
  return out
}

function hostPort(spec) {
  const parts = String(spec || '').replace(/\/(?:tcp|udp|sctp)$/i, '').split(':')
  if (parts.length < 2) return null
  const host = parts[parts.length - 2]
  const m = /^(\d+)(?:-\d+)?$/.exec(host)
  return m && Number(m[1]) > 0 && Number(m[1]) < 65536 ? Number(m[1]) : null
}

function hostHint(t, h, n) {
  const parts = h.spec.split(':')
  parts[parts.length - 2] = String(n)
  const spec = parts.join(':')
  const out = t.slice()
  if (h.inline) out[h.at] = out[h.at].replace(h.spec, spec)
  else out[h.at + 1] = spec
  return out.map(quote).join(' ')
}

// The host ports in a compose file's `ports:` lists, read line by line so a missing YAML parser costs nothing.
function composePorts(text) {
  const ports = []
  let indent = -1
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '')
    if (!line.trim()) continue
    const at = line.length - line.trimStart().length
    if (/^\s*ports:\s*$/.test(line)) { indent = at; continue }
    if (indent < 0) continue
    if (at <= indent && !line.trim().startsWith('-')) { indent = -1; continue }
    const item = line.trim().replace(/^-\s*/, '').replace(/\$\{[^}:]*:?-(\d+)\}/g, '$1')
    const pub = /^(?:published|host_port):\s*["']?(\d+)/.exec(item)
    const short = /^["']?([\d.:[\]a-fA-F-]+(?:\/\w+)?)["']?$/.exec(item)
    const p = pub ? Number(pub[1]) : short ? hostPort(short[1]) : null
    if (p) ports.push(p)
  }
  return ports
}

// The command as typed, minus redirections and any port it already names.
function withoutPort(t, argsAt, tool) {
  const out = t.slice(0, argsAt)
  for (let i = argsAt; i < t.length; i++) {
    const a = t[i]
    if (tool.positional && tool.positional.test(a)) continue
    if (tool.scan && tool.scan.test(a)) continue
    const flag = (tool.flags || []).find(f => a === f || a.startsWith(f + '='))
    if (flag) { if (a === flag) i++; continue }
    out.push(a)
  }
  return out
}

module.exports = { detect, commandsOf, TOOLS, portOf, composePorts }
