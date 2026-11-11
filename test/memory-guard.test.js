'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { check, isHeavy, touchesSlotFiles } = require('../src/memory-guard')
const { runScript } = require('./helpers')

const low = () => ({ freeGb: 1.4, totalGb: 32 })
const plenty = () => ({ freeGb: 12, totalGb: 32 })

test('recognizes heavy commands', () => {
  for (const cmd of [
    'npx vitest run --maxWorkers=4',
    'npm run build',
    'pnpm test',
    'cd web && npx next build',
    './gradlew assembleDebug',
    'emulator -avd Pixel_7 -no-window',
    'npx playwright test',
    'cargo test',
    'docker build -t app .',
    'node -e "require(\'playwright\').chromium.launch()"',
    'bash -c "npm test"',
    'mvn clean install',
    'gradle build',
    'pytest -n 8',
    'go test ./...',
  ]) assert.ok(isHeavy(cmd), cmd)
  for (const cmd of ['ls -la', 'git status', 'grep -rn "vitest" src', 'npm ci', 'bulkhead-slot run --gb=3 -- npm test', 'cat package.json',
    'grep -rn vitest package.json', 'rg tsc docs', 'git log --grep=playwright', 'cat jest.config.js | head', 'bulkhead slot run -- npx tsc',
    'pytest -x', 'npx vite preview', 'ls jest.config.js', 'ssh build-host npm test', 'git commit -m "speed up vitest"']) {
    assert.ok(!isHeavy(cmd), cmd)
  }
})

test('blocks heavy commands only when RAM is low', () => {
  assert.match(check('npm test', low), /1\.4 GB/)
  assert.strictEqual(check('npm test', plenty), null)
  assert.strictEqual(check('ls', low), null)
})

test('the default minimum scales down on small machines', () => {
  const laptop = () => ({ freeGb: 1.4, totalGb: 8 })
  assert.strictEqual(check('npm test', laptop), null)
  assert.match(check('npm test', () => ({ freeGb: 1.1, totalGb: 8 })), /minimum 1\.2 GB/)
  assert.match(check('npm test', laptop, 3), /minimum 3 GB/)
})

test('blocks hand edits to slot files', () => {
  assert.ok(touchesSlotFiles('rm ~/.claude/bulkhead/slots/slot-1.json'))
  assert.ok(touchesSlotFiles('while true; do sleep 240; echo x > ~/.claude/bulkhead/slots/slot-2.json; done &'))
  assert.ok(touchesSlotFiles('Remove-Item C:\\Users\\me\\.claude\\bulkhead\\slots\\slot-3.json'))
  assert.ok(!touchesSlotFiles('cat ~/.claude/bulkhead/slots/slot-1.json'))
  assert.ok(!touchesSlotFiles('bulkhead-slot status > status.txt'))
  assert.ok(!touchesSlotFiles('ls ~/.claude/bulkhead/slots 2>/dev/null'))
  assert.ok(!touchesSlotFiles('ls ~/.claude/bulkhead/slots 2>&1 | head'))
  assert.match(check('rm ~/.claude/bulkhead/slots/slot-1.json', plenty), /managed by bulkhead-slot/)
})

test('hook reads memory and honours the minimum', () => {
  const input = { tool_name: 'Bash', tool_input: { command: 'npm run build' } }
  const lowMem = { BULKHEAD_TEST_MEMORY: JSON.stringify({ freeGb: 1, totalGb: 16 }) }
  assert.strictEqual(runScript('memory-guard', input, lowMem).status, 2)
  assert.strictEqual(runScript('memory-guard', input, { ...lowMem, BULKHEAD_MIN_FREE_GB: '0.5' }).status, 0)
  assert.strictEqual(runScript('memory-guard', input, { ...lowMem, BULKHEAD_DISABLE: 'memory-guard' }).status, 0)
})

test('macOS: normal pressure does not block on a low estimate alone above the minimum, warning does', () => {
  const calm = () => ({ freeGb: 20, totalGb: 48, pressure: 1 })
  const warn = () => ({ freeGb: 20, totalGb: 48, pressure: 2 })
  const crit = () => ({ freeGb: 20, totalGb: 48, pressure: 4 })
  assert.strictEqual(check('npm test', calm, undefined, 'sh', () => false, () => 2), null)
  assert.match(check('npm test', warn, undefined, 'sh', () => false, () => 2), /memory pressure is warning/)
  assert.match(check('npm test', crit, undefined, 'sh', () => false, () => 2), /memory pressure is critical/)
  // below the floor still blocks at normal pressure
  assert.match(check('npm test', () => ({ freeGb: 1, totalGb: 48, pressure: 1 }), undefined, 'sh', () => false, () => 2), /only 1\.0 GB/)
})

test('a 16 GB Mac at normal pressure is not blocked', () => {
  const { readMemory } = require('../src/memory')
  const mem = () => readMemory({ platform: 'darwin', run: () => '55\n1\n' })
  assert.strictEqual(check('npm test', mem, undefined, 'sh', () => false, () => 1), null)
})

test('the block message says how many sessions are running, where the minimum comes from, and the exact slot line', () => {
  const why = n => check('cargo build --release', () => ({ freeGb: 1.4, totalGb: 16 }), undefined, 'sh', () => false, () => n)
  assert.match(why(3), /3 Claude sessions are running/)
  assert.match(why(1), /Only this session is running/)
  assert.ok(!/Claude sessions are running|Only this session/.test(why(null)))
  assert.match(why(1), /\(minimum 2\.4 GB: 15% of this machine's 16 GB\)/)
  assert.match(why(1), /\n {2}bulkhead-slot run --gb=4 -- 'cargo build --release'\n/)
  assert.match(check('npm test', () => ({ freeGb: 1, totalGb: 64 }), undefined, 'sh', () => false, () => 2), /minimum 3 GB: the 3 GB default/)
  assert.match(check('npm test', () => ({ freeGb: 1, totalGb: 64 }), 5, 'sh', () => false, () => 2), /minimum 5 GB/)
  assert.ok(!/Other sessions are probably/.test(why(1)))
})

test('more tools count as heavy', () => {
  for (const cmd of ['xcodebuild -scheme App -destination "platform=iOS Simulator" build', 'xcodebuild test -workspace A.xcworkspace -scheme A', 'swift build', 'swift test',
    'fastlane beta', 'bundle exec fastlane ios release', './gradlew test', 'mvn verify', 'cargo build --release', 'go test -race ./pkg', 'go build -race ./...',
    'docker buildx build .', 'bazel build //...', 'nx run app:build', 'nx build app', 'turbo run build']) assert.ok(isHeavy(cmd), cmd)
  for (const cmd of ['xcodebuild -version', 'swift --version', 'fastlane lanes', 'go test ./pkg', 'go build', 'docker ps', 'cargo fmt']) assert.ok(!isHeavy(cmd), cmd)
})
