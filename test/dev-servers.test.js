'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { detect, composePorts } = require('../src/dev-servers')

const packages = {
  [path.resolve('/w/app', 'package.json')]: {
    scripts: { dev: 'next dev --turbopack', web: 'vite', both: 'npm run web', api: 'node server.js', start: 'node server.js', serve: 'nodemon app.js', fixed: 'next dev -p 3000', preview: 'vite preview' },
  },
  [path.resolve('/w/app/site', 'package.json')]: { scripts: { dev: 'astro dev' } },
}
const readFile = p => {
  if (packages[p]) return JSON.stringify(packages[p])
  throw new Error('ENOENT')
}
const port = cmd => {
  const r = detect(cmd, { cwd: '/w/app', readFile })
  return r ? r.port : undefined
}

const cases = [
  ['next dev', 3000],
  ['npx next dev -p 3005', 3005],
  ['next dev --port=3006', 3006],
  ['PORT=4000 next dev', 4000],
  ['next start', 3000],
  ['vite', 5173],
  ['npx vite --port 5200', 5200],
  ['PORT=9999 vite', 5173],
  ['vite preview', 4173],
  ['astro dev', 4321],
  ['nuxi dev', 3000],
  ['remix dev', 3000],
  ['remix vite:dev', 5173],
  ['npx expo start', 8081],
  ['python -m http.server', 8000],
  ['python3 -m http.server 8080 --bind 127.0.0.1', 8080],
  ['uvicorn app.main:app --reload', 8000],
  ['python -m uvicorn app:app --port 8100', 8100],
  ['flask run', 5000],
  ['FLASK_RUN_PORT=5100 flask run', 5100],
  ['bundle exec rails s -p 3002', 3002],
  ['rails server', 3000],
  ['python manage.py runserver', 8000],
  ['python manage.py runserver 0.0.0.0:8001', 8001],
  ['php artisan serve --port=8100', 8100],
  ['ng serve', 4200],
  ['hugo server', 1313],
  ['npx wrangler dev', 8787],
  ['npx storybook dev -p 6007', 6007],
]

test('knows each tool default and explicit ports', () => {
  for (const [cmd, want] of cases) assert.strictEqual(port(cmd), want, cmd)
})

test('follows package scripts, extra args and env', () => {
  assert.strictEqual(port('npm run dev'), 3000)
  assert.strictEqual(port('npm run dev -- -p 3100'), 3100)
  assert.strictEqual(port('pnpm dev --port 3200'), 3200)
  assert.strictEqual(port('yarn web'), 5173)
  assert.strictEqual(port('bun run preview'), 4173)
  assert.strictEqual(port('pnpm both'), 5173)
  assert.strictEqual(port('PORT=4000 npm run dev'), 4000)
  assert.strictEqual(port('$env:PORT=4100; npm run dev'), 4100)
  assert.strictEqual(port('$env:PORT = "4101"; npm run dev'), 4101)
  assert.strictEqual(port('set PORT=4200 && npm run dev'), 4200)
  assert.strictEqual(port('cd site && npm run dev > dev.log 2>&1 &'), 4321)
  assert.strictEqual(port('npm --prefix site run dev'), 4321)
  // the last port flag wins, as it does in the tools
  assert.strictEqual(port('npm run fixed -- -p 3001'), 3001)
})

test('a PORT in the command counts for scripts and files that read it', () => {
  assert.strictEqual(port('PORT=3000 npm start'), 3000)
  assert.strictEqual(port('PORT=3001 npm run serve'), 3001)
  assert.strictEqual(port('export PORT=3002; npm start'), 3002)
  assert.strictEqual(port('PORT=3003 node server.js'), 3003)
  assert.strictEqual(port('PORT=3004 npx tsx src/index.ts'), 3004)
  const hint = cmd => detect(cmd, { cwd: '/w/app', readFile }).hint(3009)
  assert.strictEqual(hint('PORT=3000 npm start'), 'PORT=3009 npm run start')
  assert.strictEqual(hint('PORT=3000 node server.js'), 'PORT=3009 node server.js')
  // no PORT named, a script that is not a server, a one-liner: nothing to check
  for (const cmd of ['npm start', 'node server.js', 'PORT=3000 npm run api', 'PORT=3000 node -e "1"', 'PORT=abc npm start', 'PORT=3000 npm test']) {
    assert.strictEqual(port(cmd), undefined, cmd)
  }
})

test('ports it cannot work out are null', () => {
  assert.strictEqual(port('next dev --port $PORT'), null)
  assert.strictEqual(port('PORT=$P npm run dev'), null)
})

test('ignores commands that do not start a dev server', () => {
  for (const cmd of ['npm test', 'npm install', 'npm run api', 'npm run missing', 'next build', 'vite build', 'npx astro build',
    'git commit -m "start next dev on 3000"', 'grep -r "vite" src', 'echo next dev', 'ls', 'cd /w && ls']) {
    assert.strictEqual(port(cmd), undefined, cmd)
  }
})

test('hints keep the command and swap the port', () => {
  const hint = cmd => detect(cmd, { cwd: '/w/app', readFile }).hint(3001)
  assert.strictEqual(hint('uvicorn app:main --reload --port 8000'), 'uvicorn app:main --reload --port 3001')
  assert.strictEqual(hint('npx next dev -p 3000 > dev.log'), 'npx next dev --port 3001')
  assert.strictEqual(hint('python manage.py runserver 0.0.0.0:8000'), 'python manage.py runserver 3001')
  assert.strictEqual(hint('npm run dev'), 'npm run dev -- --port 3001')
})

const compose = 'services:\n  web:\n    image: x\n    ports:\n      - "3000:3000"\n      - 127.0.0.1:5432:5432 # db\n      - "${API_PORT:-8088}:80"\n  other:\n    ports:\n      - target: 80\n        published: 9000\n    environment:\n      - A=1\n'
const more = {
  [path.resolve('/w/app', 'compose.yaml')]: compose,
  [path.resolve('/w/app/web', 'package.json')]: JSON.stringify({ scripts: { dev: 'vite --port 5200' } }),
  [path.resolve('/w/app/packages/api', 'package.json')]: JSON.stringify({ scripts: { dev: 'uvicorn x:y --port 8100' } }),
}
const readMore = p => (more[p] !== undefined ? more[p] : readFile(p))
const server = cmd => detect(cmd, { cwd: '/w/app', readFile: readMore })
const portOf = cmd => { const r = server(cmd); return r ? r.port : undefined }

test('a quoted pattern is not a server', () => {
  for (const cmd of ['grep -E "next dev|next start|playwright" f', 'ls node_modules/.bin | grep -i -E "playwright|vite|tsx"',
    "ps aux | grep -E 'next dev|vite|uvicorn'", 'echo "a; next dev; b"', 'git log --grep="vite && next dev"']) {
    assert.strictEqual(portOf(cmd), undefined, cmd)
  }
  assert.strictEqual(portOf('echo "x"; npx next dev'), 3000)
})

test('vite prints information without serving', () => {
  for (const cmd of ['vite --version', 'vite -v', 'vite --help', 'vite -h', 'vite build', 'vite build --watch', 'vite optimize', 'npx vite --version', 'next --help', 'next -v', 'uvicorn --help']) {
    assert.strictEqual(portOf(cmd), undefined, cmd)
  }
  for (const [cmd, want] of [['vite', 5173], ['vite dev', 5173], ['vite serve', 5173], ['vite .', 5173], ['vite web --port 5200', 5200], ['vite preview', 4173], ['hugo server -v', 1313]]) {
    assert.strictEqual(portOf(cmd), want, cmd)
  }
})

test('knows the default and explicit port of more dev servers', () => {
  const serverCases = [
    ['npx serve -l 3001', 3001], ['npx serve -s build', 3000], ['serve', 3000], ['live-server', 8080], ['live-server --port=3002', 3002],
    ['json-server --port 3003 db.json', 3003], ['json-server db.json', 3000], ['php -S localhost:3004', 3004], ['php -S 0.0.0.0:3004 -t public', 3004],
    ['ruby -run -e httpd . -p 3005', 3005], ['ruby -run -ehttpd .', 8080], ['puma -p 3006', 3006], ['puma -b tcp://0.0.0.0:3007', 3007], ['puma', 9292],
    ['gunicorn -b :3008 app:app', 3008], ['gunicorn --bind=0.0.0.0:3009 app:app', 3009], ['gunicorn app:app', 8000], ['hypercorn app:app', 8000],
    ['fastapi dev', 8000], ['fastapi run main.py --port 3010', 3010], ['django-admin runserver 3011', 3011], ['python manage.py runserver 3012', 3012],
    ['streamlit run x.py', 8501], ['streamlit run x.py --server.port 3013', 3013], ['jupyter notebook --port 3014', 3014], ['jupyter lab', 8888],
    ['trunk serve', 8080], ['dotnet run --urls http://localhost:3015', 3015], ['dotnet watch run --urls "http://localhost:3016;https://localhost:3017"', 3016],
    ['java -jar app.jar --server.port=3018', 3018], ['java -Dserver.port=3019 -jar app.jar', 3019], ['PORT=3020 java -jar app.jar', 3020],
    ['./gradlew bootRun', 8080], ["./gradlew bootRun --args='--server.port=3021'", 3021], ['mvn spring-boot:run', 8080],
    ['mvn spring-boot:run -Dspring-boot.run.arguments=--server.port=3022', 3022], ['./mvnw spring-boot:run -Dserver.port=3023', 3023],
    ['npx react-native start', 8081], ['react-native start --port 3024', 3024], ['metro start', 8081], ['eleventy --serve', 8080], ['eleventy --serve --port 3025', 3025],
    ['vuepress dev docs', 8080], ['vitepress dev docs', 5173], ['vitepress preview', 4173], ['mix phx.server', 4000], ['PORT=3026 mix phx.server', 3026],
    ['PORT=3027 go run .', 3027], ['PORT=3028 cargo run', 3028], ['PORT=3029 python app.py', 3029], ['PORT=3030 python3.11 app.py', 3030], ['PORT=3031 ruby app.rb', 3031],
    ['docker run -p 3032:3032 app', 3032], ['docker run -d --name x -p 127.0.0.1:3033:80 nginx', 3033], ['docker run --publish=3034:80 nginx', 3034],
    ['podman run -p 8000-8010:8000-8010 app', 8000],
  ]
  for (const [cmd, want] of serverCases) assert.strictEqual(portOf(cmd), want, cmd)
})

test('tools that need a port in the command do not serve without one', () => {
  for (const cmd of ['php foo.php', 'php -v', 'dotnet run', 'dotnet build', 'java -jar app.jar', 'java -version', 'go run .', 'cargo run', 'python app.py', 'ruby app.rb',
    './gradlew build', 'mvn test', 'trunk build', 'eleventy', 'docker run alpine echo hi', 'docker run -p 3000 nginx', 'docker ps', 'docker compose down']) {
    assert.strictEqual(portOf(cmd), undefined, cmd)
  }
})

test('docker compose up reads the host ports of compose.yaml next to the command', () => {
  const r = server('docker compose up -d')
  assert.deepStrictEqual(r.ports, [3000, 5432, 8088, 9000])
  assert.strictEqual(r.port, 3000)
  assert.match(r.hint(3001), /publish 3001 instead of 3000 in compose\.yaml/)
  assert.deepStrictEqual(server('docker-compose up --build').ports, [3000, 5432, 8088, 9000])
  assert.strictEqual(server('docker compose -f ops/none.yml up'), null)
  assert.strictEqual(detect('docker compose up', { cwd: '/w/other', readFile: readMore }), null)
  assert.deepStrictEqual(composePorts('services:\n  a:\n    ports: []\n  b:\n    image: x\n'), [])
})

test('docker hints swap only the host port', () => {
  assert.strictEqual(server('docker run -p 3000:3000 app').hint(3001), 'docker run -p 3001:3000 app')
  assert.strictEqual(server('docker run --publish=127.0.0.1:3000:80/tcp app').hint(3001), 'docker run --publish=127.0.0.1:3001:80/tcp app')
})

test('package runners, wrappers and groups reach the tool underneath', () => {
  const runnerCases = [
    ['pnpm vite', 5173], ['yarn vite', 5173], ['yarn next dev', 3000], ['pnpm next dev -p 3040', 3040], ['npm exec -- next dev', 3000], ['npm exec -- next dev -p 3041', 3041],
    ['bunx --bun vite', 5173], ['pnpm dlx serve', 3000], ['npx -y next dev', 3000], ['npx --yes -p next next dev', 3000],
    ['timeout 60 npm run dev', 3000], ['timeout -s KILL 60s next dev', 3000], ['setsid npm run dev', 3000], ['caffeinate -i npm run dev', 3000], ['nice -n 10 npm run dev', 3000],
    ['stdbuf -oL npm run dev', 3000], ['sudo -u me npm run dev', 3000], ['dotenv -e .env -- npm run dev', 3000], ['dotenv -- next dev -p 3042', 3042], ['env-cmd -f .env npm run dev', 3000],
    ['cross-env NODE_ENV=development next dev', 3000], ['cross-env PORT=3043 node server.js', 3043], ['uv run uvicorn app:app --port 3044', 3044], ['poetry run flask run', 5000],
    ['(npm run dev &)', 3000], ['(cd web && npm run dev)', 5200], ['cd web && npm run dev', 5200], ['{ npm run dev; }', 3000], ['if true; then npm run dev; fi', 3000],
    ['for i in 1 2; do npm run dev & done', 3000], ['nohup npm run dev > dev.log 2>&1 &', 3000], ['cd /w/app/web && npm run dev', 5200],
    ['pnpm --filter api dev', 8100], ['yarn workspace api dev', 8100], ['npm run dev -w api', 8100], ['npm run dev --workspace=api', 8100],
  ]
  for (const [cmd, want] of runnerCases) assert.strictEqual(portOf(cmd), want, cmd)
  assert.strictEqual(server('cross-env PORT=3043 node server.js').hint(3050), 'PORT=3050 node server.js')
})

test('hints for tools whose port flag takes a host', () => {
  const hint = cmd => server(cmd).hint(3050)
  assert.strictEqual(hint('puma -b tcp://0.0.0.0:3007'), 'puma -p 3050')
  assert.strictEqual(hint('gunicorn -b :3008 app:app'), 'gunicorn app:app --bind :3050')
  assert.strictEqual(hint('php -S localhost:3004 -t public'), 'php -t public -S localhost:3050')
  assert.strictEqual(hint('dotnet run --urls http://localhost:3015'), 'dotnet run --urls http://localhost:3050')
  assert.strictEqual(hint('java -jar app.jar --server.port=3018'), 'java -jar app.jar --server.port=3050')
  assert.strictEqual(hint("./gradlew bootRun --args='--server.port=3021'"), "./gradlew bootRun --args='--server.port=3050'")
  assert.strictEqual(hint('npx serve -s build'), 'npx serve -s build -l 3050')
  assert.strictEqual(hint('mix phx.server'), 'PORT=3050 mix phx.server')
})
