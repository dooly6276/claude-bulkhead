# secrets-guard

[Back to README](../../README.md) | [All guards](../../README.md#guards)

Off by default. Whatever Claude reads goes into the conversation, the transcript and the provider's logs. secrets-guard stops the agent from reading secret files into it, so a stray `cat .env` does not copy your keys there. Turn it on with:

```json
{ "secretsGuard": { "enabled": true } }
```

The `strict` preset turns it on as well.

## Blocked

The Read and Grep tools, and shell commands (Bash and PowerShell, through the shared parser, so `bash -c`, `sudo`, `env`, `xargs`, `timeout`, `$( )` and pipelines are opened), on:

| Files | Examples |
|---|---|
| Environment files | `.env`, `.env.local`, `.env.production` (not `.env.example`, `.env.sample`, `.env.template`, `.env.dist`) |
| Private keys | `*.pem` and `*.key` unless the file is a certificate or public key, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `id_dsa*` (not `.pub`), anything in `~/.ssh` except `config`, `known_hosts`, `authorized_keys` and `.pub` files |
| Cloud and tool credentials | `~/.aws/credentials`, `~/.config/gh/hosts.yml`, `~/.config/gcloud` credentials, `~/.netrc`, `~/.git-credentials`, `~/.kube/config`, `~/.pgpass`, `/proc/*/environ` |
| Files that only sometimes hold a token | `~/.npmrc`, `.yarnrc.yml`, `.pypirc`, `~/.docker/config.json`: read first, blocked only if they contain a token or password |

by commands that print, encode or send them:

```
cat .env              head -n 5 .env.local     grep KEY .env          sed -n 1,5p .env
bat ~/.ssh/id_rsa     base64 .env              xxd ~/.ssh/id_ed25519  diff .env .env.example
cat .env*             cat ~/.ssh/*             grep -r token ~/.aws   find . -name .env -exec cat {} \;
sudo cat ~/.ssh/id_rsa    bash -c "cat .env"    echo "$(cat .env)"    xargs cat .env
cp .env /tmp/x        scp ~/.ssh/id_rsa host:  curl -T .env URL       curl -d @.env URL
Get-Content .env      type $HOME\.ssh\id_rsa   Select-String -Path .env -Pattern KEY
```

and by commands that dump the whole environment: `env` and `printenv` with no name, `export -p`, `declare -x`, a bare `set`, `Get-ChildItem Env:`, and tokens that CLIs print (`gh auth token`, `gcloud auth print-access-token`, `aws configure get aws_secret_access_key`, `npm config get //registry.../:_authToken`).

## Allowed

```
ls ~/.ssh                 stat .env                test -f .env            git check-ignore .env
cat .env.example          cat id_rsa.pub           cat ~/.ssh/config       cat ~/.ssh/known_hosts
echo A=1 >> .env          cat >> .env <<EOF        cp .env.example .env    sed -i s/a/b/ .env
source .env               docker run --env-file .env x                     node --env-file=.env app.js
ssh -i ~/.ssh/id_rsa host                          scp -i ~/.ssh/id_rsa app.tgz host:
env FOO=1 node x.js       printenv PATH            env | wc -l             set -e
grep .env README.md       grep -rn "process.env" src
```

Writing a secret file with Edit, Write or a redirect is fine. Using a secret without printing it is fine. `grep .env README.md` passes because the first argument of `grep`, `sed` and `awk` is a pattern or program, not a file.

## What Claude sees

```
[bulkhead] secrets-guard: this would show an environment file (.env) to the model.
Ask the user for the specific value you need, or use it by name (for example $API_KEY or --env-file .env) without printing it.
If the user wants you to read it, ask them: they can list it in secretsGuard.allow in .claude/bulkhead.json (see docs/guards/secrets-guard.md).
```

## Configuration

```json
{
  "secretsGuard": {
    "enabled": true,
    "extraPatterns": ["*.token", "~/vault/**", "config/prod/*"],
    "allow": [".env.test", "fixtures/*.pem"]
  }
}
```

A pattern without `/` matches a file name; with `/` it matches the end of the path (`~` is your home folder, `*` stays inside a folder, `**` crosses folders). `allow` wins over the built-in rules and `extraPatterns`. Turn the guard off for one session with `BULKHEAD_DISABLE=secrets-guard`.

## Limits

This keeps the agent from reading secrets by accident. It is not a sandbox: a program that opens the file itself (`python -c "print(open('.env').read())"`), a path built from a variable the guard cannot expand, or a script the agent wrote and ran can still read it. Use your permission rules or a sandbox for that.
