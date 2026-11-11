# port-guard

[Back to README](../../README.md) | [All guards](../../README.md#guards)

Keeps one session from taking or killing a dev server port that another Claude session is using. This is the most common collision when several worktrees of one app run `npm run dev`.

## Starting a dev server on a taken port

### Which commands it reads

Package scripts: `npm run dev`, `npm start` and the same through pnpm, yarn and bun (including `--filter`, `-w` and `yarn workspace`, found under `apps/`, `packages/` or `services/`). Programs, with the port each uses when none is given:

| Port | Programs |
|---|---|
| 3000 | `next dev`/`start`, `nuxt dev`, `remix dev`, `rails s`, `docusaurus start`, `rsbuild dev`, `react-scripts start`, `serve`, `json-server`, `browser-sync`, `mdbook serve`, `vercel dev` |
| 4000 / 4200 | `jekyll serve`, `hexo server`, `mix phx.server` / `ng serve`, `nx serve`, `ember serve` |
| 5000 | `flask run` |
| 5173 / 4173 | `vite`, `vite dev`, `vitepress dev` / `vite preview`, `vitepress preview` |
| 8000 | `uvicorn`, `hypercorn`, `gunicorn`, `fastapi dev`, `python -m http.server`, `manage.py runserver`, `gatsby develop`, `mkdocs serve`, `php artisan serve` |
| 8080 | `webpack serve`, `vue-cli-service serve`, `vuepress dev`, `eleventy --serve`, `trunk serve`, `live-server`, `http-server`, `./gradlew bootRun`, `mvn spring-boot:run`, `ruby -run -e httpd` |
| 8081 | `expo start`, `react-native start`, `metro start` |
| 8501 / 8888 / 9292 | `streamlit run` / `jupyter notebook`, `jupyter lab` / `puma`, `rackup` |
| other | `astro dev` 4321, `hugo server` 1313, `storybook dev` 6006, `wrangler dev` 8787, `netlify dev` 8888, `parcel` 1234, `zola serve` 1111 |

Some programs serve only where the command names the port: `php -S localhost:3000`, `java -jar app.jar --server.port=3000` (or `-Dserver.port=`, `SERVER_PORT=`, `PORT=`) and `dotnet run --urls http://localhost:3000`. A bare `dotnet run`, `java -jar` or `php foo.php` is not treated as a server, because there is no way to know its port. `go run .`, `cargo run`, `python app.py`, `ruby app.rb`, `node server.js` and similar count when `PORT=3000` is in the command.

`docker run -p 3000:3000 app` is read by its host port (`-p`, `--publish`, also `127.0.0.1:3000:80`, ranges take the first port). `docker compose up` and `docker-compose up` read the `ports:` lines of `compose.yaml`, `compose.yml`, `docker-compose.yml` or the `-f` file in the current folder, with a small line-based reader that understands `"3000:3000"`, `127.0.0.1:5432:5432`, `${PORT:-3000}:3000` and `published: 3000`. No file, no check.

Wrappers and grouping are seen through: `npx -y`, `npm exec --`, `pnpm exec`/`dlx`, `yarn exec`/`dlx`, `bunx --bun`, `uv run`, `poetry run`, `timeout 60`, `setsid`, `caffeinate`, `nice`, `stdbuf`, `sudo`, `env`, `cross-env`, `dotenv --`, `env-cmd`, `(npm run dev &)`, `(cd web && npm run dev)`, `{ ...; }`, `if` and `for` bodies, and `cd` changing which `package.json` is read. `pnpm vite` and `yarn next dev` count when the package has no script of that name.

Information commands are not servers: `vite --version`, `-v`, `--help`, `-h`, `vite build`, `vite optimize`, and `--help`/`--version` on any of the programs above. `vite preview` is the preview server on 4173. Text inside quotes is not a command, so `grep -E "next dev|vite" f` and `echo "run next dev"` pass.

It works out the port from `--port`, `-p`, `-b host:port`, `--urls`, a `PORT=3000` prefix on the command (`PORT=3000 npm start`, `PORT=3000 node server.js`), `PORT=` in the script or the tool's default, following package.json scripts. If another Claude session's process tree is listening on that port, the call is blocked. A command that publishes several ports (docker, compose) is blocked when any of them is held.

### Why

Next.js and Vite move to the next free port on their own, so nothing fails, but the agent keeps testing `localhost:3000` and sees the other worktree's branch. The usual next step is to stop "whatever is on 3000".

### What Claude sees

```
[bulkhead] port-guard: port 3000 is already used by another Claude session (session pid 18672, ~/src/acme-web): node.exe pid 24632.
Leave that server alone; it is the other session's work. If you start yours anyway, it either fails or moves to the next port, and requests to localhost:3000 reach the other project.
Port 3001 is free:
  npm run dev -- --port 3001
```

When it cannot find a free port itself, the last line says to pick one and that `bulkhead port --near 3000` prints one.

### Allowed

- The same session reusing its own port.
- A port held by a program outside Claude.
- A command whose port it cannot work out, such as `--port $PORT`.

## Killing a server by port

kill-guard lets kills by port through, because a port usually names one server. But if that server belongs to another session, killing it by port does the same damage as killing it by name. port-guard blocks these when the port is held by another live Claude session:

```
npx kill-port 3000                       # also several ports, and --port 3000,3001
npx fkill :3000                          # fkill
fuser -k 3000/tcp                        # and fuser -k -n tcp 3000
lsof -t -i:3000 | xargs kill             # lsof output fed to kill or xargs kill
lsof -i :3000 | grep LISTEN | awk '{print $2}' | xargs kill       # lsof without -t
kill -9 $(lsof -i :3000 | awk 'NR>1{print $2}')                   # and the backtick form
for p in $(lsof -ti :3000); do kill $p; done                      # loops
lsof -ti :3000 | while read p; do kill -9 $p; done
PID=$(lsof -ti :3000); kill $PID                                  # a variable carries the PID
for port in 3000 3001; do kill $(lsof -ti :$port); done           # loop and plain variables
netstat -anv | grep '\.3000 ' | awk '{print $9}' | xargs kill     # macOS netstat
ss -ltnp 'sport = :3000' | awk '{print $6}' | xargs kill          # ss
Stop-Process -Id (Get-NetTCPConnection -LocalPort 3000).OwningProcess -Force
for /f "tokens=5" %a in ('netstat -aon ^| findstr :3000') do taskkill /F /PID %a
```

```
[bulkhead] port-guard: `npx kill-port 3000` would stop node.exe pid 24632, the server another Claude session runs on port 3000 (session pid 18672, ~/src/acme-web).
That server is the other session's work. Stopping it breaks whatever that session is running or testing.
If you need a server of your own, start it on a free port instead: 3001 is free.
`bulkhead port --near 3000` prints a port no session holds.
To stop a process you started yourself, stop it by its PID.
```

These pass: your own session's port, a port held by a program outside Claude, a port whose owner it cannot tell, and a port nothing listens on (then it does not scan processes at all). Looking up a port is never blocked: `lsof -ti :3000` and `netstat -ano | findstr :3000` on their own pass, and so do `kill -0`, a lookup in one statement with a kill in the next (`lsof -ti :3000; kill 1234`), and port numbers inside quotes. The lookup and the kill count together when they are in one pipeline, one loop, or joined by a variable.

## Finding a free port

`bulkhead port --near 3000` prints the first port at or above 3000 that binds on `127.0.0.1`, `0.0.0.0`, `::1` and `::`, skipping ports browsers refuse. It prints only the number, so it works inline:

```
npm run dev -- --port $(bulkhead port --near 3000)
```

See [commands](../commands.md#bulkhead-port).

## Cost

It reads the process list only when the command starts a dev server or kills by port and something already answers on that port. To check, it tries a TCP connection to `localhost`, which takes a few milliseconds. On an everyday command it costs about the same as starting Node.

## Turn off or tune

- `BULKHEAD_DISABLE=port-guard`, or `"portGuard": { "enabled": false }` in a config file, turns it off.
- `portGuard.ignorePorts` lists ports it never checks, such as a debugger port every session shares on purpose: `[9229]`.

See [configuration](../configuration.md).

## Limits

- The dev server list is fixed, and a Procfile, `concurrently "a" "b"` or a `make` target is not read. Wrappers such as `bash -c`, `cmd /c`, `powershell -Command`, `sudo` and `env PORT=3000` are opened, as in kill-guard.
- Ports set in a config file such as `vite.config.ts` or `.env` are not seen, so the tool's default is assumed.
- Text in a heredoc is data unless a shell reads it (`bash <<EOF`, `| ssh host bash`), so `python3 - <<EOF` with a `kill` in its body passes.
- `puma` and `rackup` without a port use their own default, 9292, not the 3000 that `rails s` uses.
