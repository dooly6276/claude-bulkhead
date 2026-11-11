'use strict'

const USAGE = `usage:
  bulkhead status [--json]              sessions, their ports and memory, slots, free RAM
  bulkhead top [--interval=SECONDS]     the same, live, full screen (q quits, r refreshes)
  bulkhead log [-n N] [--since 7d] [--guard NAME] [--summary] [--json]
                                        what the guards blocked
  bulkhead scan [--since 30d] [--project TEXT] [-n N] [--json]
                                        replay your Claude Code transcripts against the guards
  bulkhead doctor [--json] [--no-remote] check the install, settings and this machine
  bulkhead config [--json]              effective settings and where each one came from
  bulkhead config --preset quiet|normal|strict [--project]
                                        fewer or more guards at once
  bulkhead explain [--cwd DIR] [--session-id ID] [--json] -- <command...>
                                        what every guard would say about a command, nothing runs
  bulkhead allow <code> | --list        allow one blocked command once (you run this, not the agent)
  bulkhead port [--near PORT] [--json]  a port no process is listening on
  bulkhead reap [--dry-run] [--json]    stop what exited sessions left running
  bulkhead slot run [--gb=N] [--wait=MINUTES] [--label=TEXT] -- <command...>
  bulkhead slot status [--gb=N]         same as bulkhead-slot
  bulkhead remote run [--remote=NAME] [--gb=N] [--tail=N] -- <command...>
                                        run a heavy command on another machine over ssh
  bulkhead remote status|list|add|remove|fetch   see bulkhead remote --help
  bulkhead version                      print the version
  bulkhead help <command>               usage of one command`

const COMMANDS = {
  status: './status',
  top: './top',
  log: './log-cli',
  scan: './scan',
  doctor: './doctor',
  config: './config-cli',
  explain: './explain',
  allow: './allow-cli',
  port: './port-cli',
  reap: './reap-cli',
  slot: './slot-cli',
  remote: './remote',
}

// The USAGE lines of one command: its own text when its module has one, else its block of the list above.
function usageOf(cmd) {
  const own = COMMANDS[cmd] && require(COMMANDS[cmd]).USAGE
  if (own) return own
  const out = []
  let on = false
  for (const line of USAGE.split('\n').slice(1)) {
    if (/^ {2}bulkhead \S/.test(line)) on = line.startsWith(`  bulkhead ${cmd}`)
    if (on) out.push(line)
  }
  return out.length ? `usage:\n${out.join('\n')}` : null
}

function main(argv) {
  const [cmd, ...rest] = argv
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') return console.log(require('../package.json').version)
  if (cmd === 'help' && rest[0] && COMMANDS[rest[0]]) return console.log(usageOf(rest[0]) || USAGE)
  // remote has its own --help with subcommands
  if (COMMANDS[cmd] && cmd !== 'remote' && (rest.includes('-h') || rest.includes('--help'))) return console.log(usageOf(cmd) || USAGE)
  if (COMMANDS[cmd]) return require(COMMANDS[cmd]).main(rest)
  const help = cmd === '--help' || cmd === '-h' || cmd === 'help'
  if (!help && cmd) console.error(`bulkhead: unknown command "${cmd}"`)
  ;(help ? console.log : console.error)(USAGE)
  process.exit(help ? 0 : 1)
}

module.exports = { main, USAGE }
