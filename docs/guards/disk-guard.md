# disk-guard

[Back to README](../../README.md) | [All guards](../../README.md#guards)

New in 0.2.0. Every session on a machine shares one disk. An agent that wants to know "what is using space" runs `du -sh ~`, or ten `du` at once through `xargs -P 10`, and the disk sits at 100% for minutes. Every other session's builds, tests and even `git status` crawl until the scans end, and stopping them can take minutes too. disk-guard blocks the scans that walk a whole drive or home folder, and scans run in parallel.

## Blocked

Sizing or listing the whole drive, the home folder, or every user's home (`/`, `~`, `$HOME`, `~/*`, `/Users`, `/home`, `C:\`, `%USERPROFILE%`, Git Bash `/c`):

```
du -sh ~                 du -sh ~/*               du -h -d 1 ~ | sort -h
sudo du -sh /            ncdu /                   dust ~
ls -R ~                  Get-ChildItem C:\ -Recurse
gci $env:USERPROFILE -Recurse | Measure-Object Length -Sum
dir /s C:\
```

`find` over the whole drive or home without `-maxdepth`:

```
find / -name "*.sqlite"          find ~ -name node_modules -type d
```

Disk scans run in parallel, wherever they point:

```
ls ~/dev | xargs -P 10 -I{} du -sm ~/dev/{}
find . -maxdepth 1 -type d | parallel du -sh
for d in */; do du -sh "$d" & done; wait
du -sh a & du -sh b & wait
1..4 | ForEach-Object -Parallel { Get-ChildItem $_ -Recurse }
```

## Allowed

```
du -sh node_modules      du -sh ~/Library/Caches  du -sh ./dist ./build
find . -name x           find ~ -maxdepth 2 -name x   find ~/dev -name package.json
ls -la ~                 ls -r ~                  du -sh a; du -sh b
```

Paths with variables it cannot expand (`du -sh "$DIR"`) pass.

## What Claude sees

```
[bulkhead] disk-guard: `du -sh ~` reads your whole home folder (~).
Other sessions share this disk; sizing everything keeps it busy for minutes and slows their work.
Measure one folder at a time, in the foreground: du -sh ./node_modules, or du -sh ~/Library/Caches. Start from the folders you already suspect.
```

```
[bulkhead] disk-guard: `find / -name x` walks the whole drive (/) with no depth limit.
Other sessions share this disk; a walk over millions of files slows their builds, tests and git for minutes.
Search the folder you mean (find ./src -name ...), or add -maxdepth 3. To find a file by name, try `mdfind`, `locate` or `git ls-files` first.
```

## Turn off or tune

- `BULKHEAD_DISABLE=disk-guard`, or `"diskGuard": { "enabled": false }` in a config file, turns it off. See [configuration](../configuration.md).

## Limits

- It reads the command text. A script that scans the disk from inside (`python cleanup.py`) is not seen.
- Big folders that are not the home folder itself, such as `~/Library` or `/var`, pass: they are often what you meant to measure.
