<h1 align="center">claude-bulkhead</h1>

<p align="center">
  <strong>Impede que o Claude Code rode <code>pkill node</code> nos seus outros servidores de desenvolvimento, tome as portas deles e faça commit das edições de outra sessão com <code>git add -A</code>.</strong>
</p>

<p align="center">Hooks que sabem quais processos, portas e árvores git pertencem a cada sessão e subagent do Claude Code, então bloqueiam só o que prejudicaria outra coisa e dizem ao Claude qual comando seguro rodar no lugar. Zero dependências, sem telemetria.</p>

<p align="center">
  <a href="https://github.com/dooly6276/claude-bulkhead/actions/workflows/test.yml"><img src="https://github.com/dooly6276/claude-bulkhead/actions/workflows/test.yml/badge.svg" alt="testes"></a>
  <img src="https://img.shields.io/badge/node-18%2B-34d6b4?style=flat-square" alt="Node 18+">
  <img src="https://img.shields.io/badge/dependencies-0-34d6b4?style=flat-square" alt="zero dependências">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-34d6b4?style=flat-square" alt="licença MIT"></a>
</p>

<p align="center">
  <img src="docs/demo.gif" alt="Duas sessões do Claude Code trabalham em duas worktrees do mesmo app. A sessão A serve checkout na porta 3000. A sessão B recebe a ordem de matar todos os processos node e reiniciar seu servidor de search; o kill-guard do bulkhead bloqueia o comando, o Claude reinicia só o próprio servidor e o checkout continua rodando com o mesmo PID." width="100%">
</p>

<p align="center"><sub><a href="README.md">English</a> | <a href="README.ko.md">한국어</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.es.md">Español</a></sub></p>

## Instalação

Dentro do Claude Code:

```
/plugin marketplace add dooly6276/claude-bulkhead
/plugin install bulkhead@bulkhead
```

Depois, veja o que ele teria bloqueado no seu último mês, sem mudar nada:

```
/bulkhead:scan 30d
```

O Node 18 ou mais recente precisa estar no `PATH` (o instalador nativo do Claude Code não o instala; confira com `node --version`). Para os comandos de terminal e a status line, rode também `npm install -g claude-bulkhead`, ou use `npx claude-bulkhead status` sem instalar.

## O que ele bloqueia

| Sem o bulkhead | Com o bulkhead |
|---|---|
| Um agente reinicia o próprio dev server com `pkill node`, e o servidor de todos os outros worktrees morre junto. | O kill-guard bloqueia o comando e ensina o agente a achar e encerrar o próprio PID. |
| Duas sessões compartilham um checkout. Uma roda `git add -A && git commit`, e as edições pela metade da outra vão parar nesse commit. | O checkout-guard bloqueia e pede os nomes dos arquivos. |
| Dois worktrees rodam `npm run dev`. O segundo passa para a 3001, mas o agente dele continua testando `localhost:3000` e vê a outra branch. | O port-guard bloqueia a segunda inicialização e indica uma porta livre. O `bulkhead port` imprime uma sob demanda. |
| Três sessões iniciam `next build`, `npm test` e Playwright no mesmo minuto, e a máquina trava. | O memory-guard bloqueia comandos pesados quando a RAM está baixa. Pelo `bulkhead-slot`, o terceiro job espera na fila até haver espaço. |

<details>
<summary>Mais cinco</summary>

| Sem o bulkhead | Com o bulkhead |
|---|---|
| Uma sessão troca de branch em uma árvore que uma segunda sessão está editando. | O checkout-guard bloqueia e sugere `git worktree add`. |
| Uma sessão termina, e seus dev servers, test workers e watchers continuam rodando, ocupando RAM e portas. | O orphan-reaper os encerra segundos depois de a sessão terminar. |
| Um subagent fica fazendo polling em primeiro plano por dez minutos. A sessão não consegue responder a você, e o prompt cache expira. | O wait-guard bloqueia o loop e pede `run_in_background: true`. |
| Um agente quer saber o que está ocupando espaço em disco e roda dez `du` ao mesmo tempo na sua pasta pessoal. Os builds e o `git status` de todas as sessões se arrastam por minutos. | O disk-guard bloqueia e pede uma pasta por vez. |
| Uma tarefa de "limpar os worktrees" roda `git worktree remove` em um worktree onde uma segunda sessão ainda está trabalhando. | O checkout-guard bloqueia e informa qual sessão ainda está lá. |

</details>

Com uma única sessão, kill-guard, memory-guard, wait-guard, disk-guard e basics (sem `rm -rf ~`, sem force-push para `main`, sem `reset --hard` sobre trabalho não commitado) continuam valendo. port-guard e checkout-guard agem quando existe uma segunda sessão ou subagent ativo.

## O que é?

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="docs/hero-light.svg">
    <img src="docs/hero.svg" alt="Várias sessões do Claude Code em git worktrees separados na mesma máquina. O kill-guard bloqueia pkill node, o port-guard move um segundo dev server para uma porta livre, o disk-guard impede dez varreduras du em paralelo, o checkout-guard impede que git add -A leve para um commit as edições de outra sessão, e o bulkhead-slot enfileira um terceiro job pesado para que a RAM livre fique acima do mínimo. Depois o bulkhead scan conta o que teria sido bloqueado em sessões passadas." width="100%">
  </picture>
</p>

Hooks do Claude Code são programas pequenos que o Claude Code executa antes de cada comando de shell e que podem bloquear o comando e dizer ao Claude o motivo. O bulkhead é um conjunto deles. Antes de cada chamada ao Bash ou ao PowerShell, ele confere o comando com o que as outras sessões da máquina estão fazendo: quais processos e portas são de cada sessão, quanta RAM sobrou e em qual árvore git cada uma trabalha. Quando o comando prejudicaria outra sessão, ele é bloqueado, e o Claude recebe uma mensagem com o comando mais seguro para rodar. O Claude lê e segue em frente, em geral sem perguntar a você.

## Você precisa disso? Pergunte às suas transcrições

Você não precisa adivinhar. O Claude Code guarda a transcrição de cada sessão em `~/.claude/projects`, e o `bulkhead scan` reproduz os comandos de shell dessas transcrições contra os guards: quantas sessões você realmente roda ao mesmo tempo e com que frequência elas já fizeram o que o bulkhead bloqueia.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="docs/scan-light.svg">
    <img src="docs/scan.svg" alt="O bulkhead scan lê um mês de transcrições, informa o maior número de sessões que rodaram ao mesmo tempo e lista, por guard e por regra, quantos comandos teriam sido bloqueados, em quantas sessões, e quantos um hook ou o próprio usuário já bloqueou." width="100%">
  </picture>
</p>

```
/plugin install bulkhead@bulkhead      # then, inside Claude Code:
/bulkhead:scan 30d
```

Ele só lê, mascara qualquer coisa que pareça um segredo antes de imprimir e não envia nada para lugar nenhum. O port-guard e a verificação de pouca RAM não são reproduzidos, porque as transcrições não registram quais portas e quanta RAM estavam em uso; o checkout-guard é reconstruído a partir de quais sessões estavam ativas na mesma árvore git naquele minuto. Detalhes: [docs/commands.md](docs/commands.md#bulkhead-scan).

## Por que isso existe

Uma forma comum de acelerar o trabalho com o Claude Code é rodar várias sessões no mesmo repositório, cada uma em seu próprio git worktree e com seus próprios subagents. O git mantém as branches separadas. A máquina não: todas as sessões compartilham as mesmas portas, a mesma tabela de processos e a mesma RAM. É aí que elas colidem.

- Dois worktrees do mesmo app rodam `npm run dev`. O segundo falha na porta 3000, ou passa discretamente para a 3001 enquanto o agente dele continua testando `localhost:3000` e vê a outra branch.
- Um agente reinicia o próprio servidor com `pkill node` ou `taskkill /IM node.exe` e derruba os dev servers e as execuções de teste de todos os outros worktrees, e às vezes a própria sessão.
- Três sessões iniciam `npm test`, `next build` e uma execução do Playwright no mesmo minuto, e a máquina para de responder.
- Uma sessão termina e os dev servers que ela iniciou continuam rodando.

O tracker do Claude Code tem muitos relatos exatamente disso:

- [#13941](https://github.com/anthropics/claude-code/issues/13941): ao receber o pedido de reiniciar um dev server, o Claude rodou `taskkill //IM node.exe` ou `pkill node` e matou a própria sessão.
- [#34754](https://github.com/anthropics/claude-code/issues/34754): `taskkill //F //IM python.exe` matou duas simulações de longa duração, depois de o usuário ter marcado os PIDs delas como proibidos.
- [#43225](https://github.com/anthropics/claude-code/issues/43225): ao receber o pedido de reiniciar um bot, o Claude matou à força todos os processos Python da máquina, cerca de 20 serviços.
- [#53229](https://github.com/anthropics/claude-code/issues/53229): instruído a encerrar apenas dev servers sem uso, um agente também matou um gateway e um processo do Postgres que não havia identificado.
- [#15487](https://github.com/anthropics/claude-code/issues/15487): 24 processos de subagent saturaram um VPS de 4 GB até ele precisar ser reiniciado; um comentarista travou um Mac de 24 GB do mesmo jeito.
- [#11502](https://github.com/anthropics/claude-code/issues/11502) e [#25180](https://github.com/anthropics/claude-code/issues/25180): processos iniciados por agentes sobrevivem a eles, 60 processos Node em um relato e 550 workers do pytest no outro.

O claude-bulkhead é um conjunto de hooks pequenos que bloqueiam ou limpam cada um desses casos. Cada um pode ser desativado individualmente. O nome vem do padrão bulkhead: um compartimento que está enchendo de água não deve afundar o navio.

## O que ele faz

| | |
|---|---|
| **[kill-guard](docs/guards/kill-guard.md)**<br>Bloqueia `pkill node`, `taskkill /IM`, `Stop-Process -Name` e outros kills por nome de programa. Kills por PID passam. | **[port-guard](docs/guards/port-guard.md)**<br>Bloqueia iniciar um dev server em uma porta que outra sessão já usa, e matar por porta o servidor dessa sessão. |
| **[memory-guard e bulkhead-slot](docs/guards/memory-guard.md)**<br>Bloqueia comandos pesados quando a RAM está baixa e enfileira jobs pesados contra um orçamento de RAM compartilhado por todas as sessões. | **[checkout-guard](docs/guards/checkout-guard.md)**<br>Bloqueia `git checkout`, `stash`, `reset --hard`, `git add -A` e similares quando outra sessão ativa trabalha na mesma árvore, e a exclusão de uma pasta onde outra sessão trabalha. |
| **[wait-guard](docs/guards/wait-guard.md)**<br>Bloqueia loops de sleep em primeiro plano com mais de 3 minutos, que fazem a próxima requisição reescrever todo o prompt cache. | **[orphan-reaper](docs/guards/orphan-reaper.md)**<br>Quando uma sessão termina, encerra os dev servers, test workers, watchers e navegadores headless que ela deixou rodando. |
| **[disk-guard](docs/guards/disk-guard.md)** <sup>novo</sup><br>Bloqueia `du -sh ~`, `find /` sem `-maxdepth` e varreduras de disco em paralelo, que travam o disco que todas as sessões compartilham. | **[`bulkhead scan`](#você-precisa-disso-pergunte-às-suas-transcrições)** <sup>novo</sup><br>Reproduz suas transcrições passadas do Claude Code contra os guards: o que eles teriam bloqueado e quantas sessões rodaram ao mesmo tempo. |
| **[basics](docs/guards/basics.md)**<br>Bloqueia `rm -rf` na raiz, na home ou em uma pasta diretamente dentro dela, force-push na `main`, resets que perderiam trabalho não commitado e commits com Claude como autor. | **[`bulkhead status`, `top`, `log`, `doctor`](#veja-o-que-está-rodando)**<br>Mostra cada sessão, sua RAM, suas portas, os jobs na fila e o que os guards bloquearam. |
| **[Status line](#status-line)**<br>`3 sessions  2 heavy  9.1 GB free` na status line do Claude Code, em menos de 100 ms. | **[Configuração e slash commands](#configuração)**<br>Configuração por máquina e por projeto com listas de permissão, além de `/bulkhead:scan`, `/bulkhead:status`, `/bulkhead:log`, `/bulkhead:doctor` e `/bulkhead:reap`. |

Opcional: o **[`bulkhead remote`](#rode-tarefas-pesadas-em-outra-máquina-opcional)** roda uma suíte de testes, um build ou uma execução de navegador em outra máquina via SSH, quando esta não tem RAM sobrando.

## Mais demonstrações

![bulkhead status e, em seguida, port-guard, kill-guard e wait-guard bloqueando um agente](docs/demo.svg)

Uma execução roteirizada de `bulkhead status`, port-guard, kill-guard e wait-guard, gravada com o [docs/demo.sh](docs/demo.sh). As duas sessões são processos de mentira chamados `claude`; tudo o que aparece vem dos scripts de hook e do `bulkhead status`. A gravação no topo desta página é uma sessão real do Claude Code; como ela foi feita está em [docs/demo.tape](docs/demo.tape).

## Início rápido

1. Instale o plugin como acima e inicie uma nova sessão do Claude Code.
2. Veja o que ele teria pegado: rode `/bulkhead:scan 30d`, ou `bulkhead scan` na ferramenta Bash. Ele lê o último mês de transcrições e não altera nada.
3. Verifique a instalação. Dentro do Claude Code, rode `/bulkhead:doctor`, ou rode `bulkhead doctor` na ferramenta Bash. Todas as linhas devem dizer `OK`. Uma linha `WARN` ou `FAIL` informa o guard e o motivo.
4. Abra um terminal ao lado das suas sessões e rode `npx claude-bulkhead top` (ou `bulkhead top` depois de `npm install -g claude-bulkhead`) para acompanhar ao vivo sessões, RAM, portas e jobs pesados. Pressione `q` para sair.

Depois disso não há mais nada a fazer. Os guards rodam em toda chamada de Bash e PowerShell. Para ver o que eles bloquearam, rode `bulkhead log` ou `/bulkhead:log`; `bulkhead log --summary` conta os bloqueios por guard na sua máquina. Para mudar um limite ou liberar um comando, veja [docs/configuration.md](docs/configuration.md). Todos os comandos estão listados em [docs/commands.md](docs/commands.md).

## Rode tarefas pesadas em outra máquina (opcional)

Quando várias sessões rodam suítes de testes e builds ao mesmo tempo, uma máquina fica sem RAM: o memory-guard bloqueia os comandos, ou o bulkhead-slot os coloca na fila. Se você tem uma segunda máquina quase sempre ociosa, o `bulkhead remote` roda o comando pesado nela.

<p align="center">
  <img src="docs/remote.svg" alt="Esta máquina tem 1,8 GB livres, então o memory-guard segura o npm test. O bulkhead remote envia por SSH para o buildbox apenas o novo commit e os arquivos alterados, os testes rodam lá na cópia a, na porta 7172, e as últimas 20 linhas voltam. A RAM livre desta máquina não muda." width="100%">
</p>

```
bulkhead remote add buildbox dev@192.168.1.20 --ssh-option=IdentityFile=~/.ssh/buildbox
bulkhead remote run -- npm test
```

```
[bulkhead remote] buildbox: 3f2a1c9 already there, 3 changed files (24 KB), 1 deleted
[bulkhead remote] buildbox  copy a  /home/dev/bulkhead-remote/acme-web-3f9a1c  port 7172
...test output...
[bulkhead remote] exit 0 after 1m 12s (copy a)
```

- **O que é enviado.** O commit atual como um git bundle (somente os commits que o remoto ainda não tem) e suas alterações não commitadas, inclusive exclusões. Arquivos ignorados ficam aqui, a menos que você os indique com `--files`. Nada fora do repositório é enviado.
- **Onde roda.** Em uma de até 8 cópias do repositório no remoto, para que execuções paralelas não compartilhem uma árvore de trabalho. O `node_modules` é mantido entre execuções. Cada execução recebe a própria porta em `$BULKHEAD_PORT`.
- **Espaço.** Locks no remoto reservam uma cópia e um slot de job, e `--gb=N` espera até haver N GB livres lá. Se não houver espaço dentro de `--wait` minutos, sai com código 3.
- **Limpeza.** Quando o comando termina, ou a conexão SSH cai (Ctrl-C, timeout da ferramenta), tudo o que ele iniciou no remoto é encerrado, inclusive um servidor deixado em sua porta.
- **O remoto** precisa apenas de um servidor SSH, `bash`, `git` e `tar`. Linux, macOS e Windows com Git for Windows funcionam.

`bulkhead remote fetch PATH` traz de volta arquivos da cópia usada na última execução, e `bulkhead remote status` mostra a RAM livre e os jobs em execução de cada remoto. No Claude Code, `/bulkhead:remote <command>` roda um comando lá em segundo plano. Configuração, opções e códigos de saída: [docs/remote.md](docs/remote.md).

## Como funciona

```mermaid
flowchart LR
  CC["Claude Code session"] -->|"PreToolUse: Bash, PowerShell"| G["kill-guard, wait-guard, memory-guard,<br>port-guard, checkout-guard, disk-guard, basics"]
  CC -->|"SessionEnd, SessionStart"| R["orphan-reaper (background)"]
  G -->|"read"| P["process table, listening ports,<br>~/.claude/sessions"]
  G <-->|"read, append"| S[("state dir ~/.claude/bulkhead<br>slots, guards.log, events.jsonl")]
  B["bulkhead-slot"] <--> S
  G -->|"exit 2 + message: blocked"| CC
  G -->|"exit 0: allowed"| CC
  G -.->|"any error: exit 0"| CC
```

Cada guard é um script Node separado, sem dependências. O Claude Code envia a chamada da ferramenta a ele como JSON. O guard lê o texto do comando e só olha mais a fundo quando o comando casa: a tabela de processos, as portas em escuta, os arquivos de sessão que o Claude Code mantém em `~/.claude/sessions`, a RAM livre ou o `git status`. Um bloqueio é o código de saída 2 com uma mensagem que diz ao Claude o que fazer no lugar. Qualquer erro dentro de um guard deixa a chamada passar, então um guard quebrado nunca interrompe o seu trabalho.

Todas as sessões da máquina compartilham um único diretório de estado. O bulkhead-slot guarda ali suas reservas de RAM, e cada bloqueio é registrado ali. Mais detalhes, incluindo a estrutura do diretório de estado e como as sessões são encontradas em cada sistema operacional, estão em [docs/architecture.md](docs/architecture.md).

## Guards

Cada guard tem uma página com os comandos exatos que ele bloqueia, o que passa, a mensagem que o Claude vê e seus limites. A versão resumida:

<details>
<summary><strong>kill-guard</strong>: kills por nome de programa</summary>

Bloqueia `taskkill /IM`, `taskkill /FI` sem PID, `Stop-Process -Name`, `Get-Process node | Stop-Process`, `pkill`, `killall`, `kill $(pgrep node)`, `wmic ... delete` e similares quando miram um programa que outras sessões compartilham, como `node`, `python`, `java`, `chrome`, `git` ou `vite`. Kills por PID e por caminho do projeto passam. Kills por porta também passam, a menos que outra sessão seja dona da porta; quem confere isso é o port-guard. O Claude recebe instruções de como achar os próprios PIDs.

Para desativar: `BULKHEAD_DISABLE=kill-guard`. Detalhes: [docs/guards/kill-guard.md](docs/guards/kill-guard.md).
</details>

<details>
<summary><strong>port-guard</strong>: portas de outra sessão</summary>

Bloqueia iniciar um dev server (`npm run dev`, `next dev`, `vite`, `uvicorn`, `rails s` e outros) em uma porta na qual a árvore de processos de outra sessão do Claude já está escutando, e sugere uma porta livre. Também bloqueia comandos de kill por porta, como `npx kill-port 3000`, `fuser -k 3000/tcp` e `lsof -ti :3000 | xargs kill`, quando outra sessão é dona dessa porta.

Para desativar: `BULKHEAD_DISABLE=port-guard`. Detalhes: [docs/guards/port-guard.md](docs/guards/port-guard.md).
</details>

<details>
<summary><strong>memory-guard e bulkhead-slot</strong>: RAM</summary>

O memory-guard bloqueia comandos pesados (test runners, `next build`, `tsc`, Gradle, o emulador Android, Playwright, `cargo test`, `docker build` e similares) quando a RAM livre está abaixo de 3 GB, ou abaixo de 15% da RAM em máquinas com menos de 20 GB. O `bulkhead-slot run --gb=4 -- <command>` espera até o orçamento de RAM compartilhado ter espaço, roda o comando e libera o slot quando ele termina.

Para desativar: `BULKHEAD_DISABLE=memory-guard`. Detalhes: [docs/guards/memory-guard.md](docs/guards/memory-guard.md).
</details>

<details>
<summary><strong>checkout-guard</strong>: duas sessões na mesma árvore git</summary>

Bloqueia `git checkout <branch>`, `switch`, `stash`, `reset --hard`, `clean -f`, `rebase`, `merge`, `restore .` e um `pull` com alterações pendentes quando outra sessão ativa trabalha na mesma árvore, e sugere `git worktree add`. Também bloqueia ali `git add -A`, `git add .` e `git commit -a` (`stage-all`), que levariam as edições pela metade da outra sessão para o seu commit, e `rm -rf` ou `git worktree remove` em uma pasta onde outra sessão ativa trabalha (`remove-session-dir`). No Windows, bloqueia `git worktree remove --force` em um worktree que contém junctions, que o git já seguiu até o checkout principal.

Para desativar: `BULKHEAD_DISABLE=checkout-guard`, ou uma regra só com `BULKHEAD_DISABLE=stage-all` ou `remove-session-dir`. Detalhes: [docs/guards/checkout-guard.md](docs/guards/checkout-guard.md).
</details>

<details>
<summary><strong>disk-guard</strong>: varreduras do disco inteiro e em paralelo</summary>

Bloqueia `du`, `ncdu`, `dust`, `ls -R`, `Get-ChildItem -Recurse` e `dir /s` sobre o drive inteiro, a pasta pessoal ou a pasta pessoal de todos os usuários (`du -sh ~`, `du -sh ~/*`, `ncdu /`), `find /` e `find ~` sem `-maxdepth`, e varreduras de disco rodadas em paralelo, não importa para onde apontem: `xargs -P 10 du`, GNU `parallel`, `du ... &` em um loop, `ForEach-Object -Parallel`. Uma pasta por vez passa (`du -sh node_modules`, `du -sh ~/Library/Caches`).

Para desativar: `BULKHEAD_DISABLE=disk-guard`. Detalhes: [docs/guards/disk-guard.md](docs/guards/disk-guard.md).
</details>

<details>
<summary><strong>wait-guard</strong>: esperas longas em primeiro plano</summary>

Bloqueia um comando em primeiro plano cujos sleeps podem somar mais de 180 segundos. O prompt cache expira depois de cerca de cinco minutos sem requisição, então um subagent fazendo polling em primeiro plano reescreve todo o contexto a cada vez que acorda. O Claude recebe a instrução de rodar o loop com `run_in_background: true`. Sleeps em um job em segundo plano (`sleep 600 &`) passam. Com o timeout padrão de 120 segundos da ferramenta, uma espera não consegue passar do limite padrão, então o bloqueio só ocorre quando a chamada aumenta o timeout.

Para desativar: `BULKHEAD_DISABLE=wait-guard`, ou aumente o limite com `BULKHEAD_WAIT_MAX_SEC`. Detalhes: [docs/guards/wait-guard.md](docs/guards/wait-guard.md).
</details>

<details>
<summary><strong>orphan-reaper</strong>: processos deixados por sessões que terminaram</summary>

Quando uma sessão termina, um waiter oculto em segundo plano encerra o que ela iniciou nos shells das ferramentas e deixou rodando: dev servers e qualquer outra coisa escutando em uma porta, test runners e seus workers (Vitest, Jest, Playwright, pytest e xdist, `cargo test`, `go test` e outros), watchers como `tsc --watch` e nodemon, builds como `next build` e navegadores headless. Uma varredura no início da sessão pega o que um crash deixou para trás. Editores, terminais, daemons compartilhados como Gradle ou adb e qualquer coisa que você mesmo iniciou nunca são tocados. O `bulkhead reap --dry-run` mostra o que ele encerraria e por quê. Windows, Linux e macOS (macOS testado com fixtures).

Para desativar: `BULKHEAD_DISABLE=orphan-reaper`. Detalhes: [docs/guards/orphan-reaper.md](docs/guards/orphan-reaper.md).
</details>

<details>
<summary><strong>basics</strong>: quatro erros que não têm volta</summary>

`rm-root` (`rm -rf` na raiz, em uma pasta de nível superior como `/srv`, na home, em uma pasta diretamente dentro da home como `~/Documents`, ou acima do repositório), `force-push-main` (`git push --force` para `main` ou `master`; `--force-with-lease` passa), `discard-changes` (`git reset --hard` ou `git clean -fd` que perderiam trabalho não commitado) e `agent-author` (`--author="Claude <noreply@anthropic.com>"`, `git config user.name Claude` e similares, para que seus commits continuem contando como seus).

Para desativar: `BULKHEAD_DISABLE=basics`, ou uma regra pelo nome. Detalhes: [docs/guards/basics.md](docs/guards/basics.md).
</details>

## Como o bulkhead se relaciona com outros pacotes de hooks

Pacotes gerais de segurança protegem uma sessão de comandos perigosos. Por exemplo, o [claude-forge](https://github.com/sangrokjung/claude-forge) inclui hooks que filtram segredos vazados na saída, bloqueiam scripts remotos passados por pipe e impedem SQL destrutivo, e o [dcg](https://github.com/Dicklesworthstone/destructive_command_guard) e o [cc-safety-net](https://github.com/kenryu42/claude-code-safety-net) cobrem de forma ampla comandos destrutivos de shell e git. Vale a pena usá-los.

O bulkhead cobre um problema diferente: sessões na mesma máquina atrapalhando umas às outras por posse de processos, portas, RAM compartilhada e uma árvore git compartilhada. Só as regras do `basics` se sobrepõem a esses pacotes, e você pode desativá-las com `BULKHEAD_DISABLE=basics` se outro pacote já as cobrir. O bulkhead roda junto com outros hooks: o Claude Code executa todos os hooks que casam com uma chamada de ferramenta, e a chamada é bloqueada se qualquer um deles a bloquear.

## Configuração

Os padrões não exigem nenhuma configuração. Para alterá-los, use um arquivo de configuração: `~/.claude/bulkhead/config.json` para a máquina e `<repo>/.claude/bulkhead.json` para um projeto (encontrado subindo até a pasta com `.git`). As configurações do projeto vencem o arquivo global.

Um arquivo de projeto pode tirar nomes da lista de bloqueio do kill-guard, ignorar portas ou desligar um guard naquele repositório. Leia o `.claude/bulkhead.json` de um repositório que você clonar antes de trabalhar nele, como faria com o resto da configuração; `bulkhead config` mostra cada ajuste e o arquivo de onde ele veio. Hosts remotos e opções de ssh só são lidos do arquivo global.

Por exemplo, um projeto que roda `ffmpeg` de propósito e tem uma suíte de integração lenta:

```json
{
  "killGuard": { "allowNames": ["ffmpeg"] },
  "waitGuard": { "limitSeconds": 300 },
  "portGuard": { "ignorePorts": [9229] },
  "basics": { "protectedBranches": ["main", "release"] }
}
```

Todo guard pode ser desativado com `"<guard>": { "enabled": false }`. O `bulkhead config` imprime cada configuração, seu valor e de onde ele veio. Um arquivo quebrado é ignorado, os guards mantêm seus padrões e a sessão mostra um aviso na inicialização. Todas as chaves estão em [docs/configuration.md](docs/configuration.md), e o [config.example.json](config.example.json) define cada uma delas.

As variáveis de ambiente continuam funcionando e vencem os dois arquivos. O lugar mais simples para colocá-las é o bloco `env` do `~/.claude/settings.json`.

<details>
<summary>Todas as variáveis de ambiente</summary>

| Variável | Padrão | Equivale a |
|---|---|---|
| `BULKHEAD_DISABLE` | vazio | Guards a desativar, separados por vírgula: `kill-guard`, `wait-guard`, `memory-guard`, `port-guard`, `checkout-guard`, `disk-guard`, `orphan-reaper`, `basics`, ou `all`. Regras individuais também podem ser desativadas: `rm-root`, `force-push-main`, `discard-changes`, `agent-author`, `stage-all`, `remove-session-dir`. Um nome aqui fica desativado, diga o que disser os arquivos |
| `BULKHEAD_WAIT_MAX_SEC` | 180 | `waitGuard.limitSeconds` |
| `BULKHEAD_MIN_FREE_GB` | 3, ou 15% da RAM se for menos | `memory.minFreeGb` |
| `BULKHEAD_SLOT_FLOOR_GB` | 5, ou 25% da RAM se for menos | `memory.slotFloorGb` |
| `BULKHEAD_MAX_COMMIT_PCT` | 75 | `memory.maxCommitPct` (somente Windows) |
| `BULKHEAD_NO_LOG` | vazio | `log.enabled: false` quando definida como `1` |
| `BULKHEAD_STATE_DIR` | `~/.claude/bulkhead` | Onde ficam os slots, o log de eventos, o `guards.log` e o arquivo de configuração global |
| `BULKHEAD_SSH` | `ssh` no `PATH` | O cliente ssh que o `bulkhead remote` executa |

</details>

## Veja o que está rodando

O `bulkhead` está no `PATH` da ferramenta Bash, ao lado do `bulkhead-slot`. Dentro do Claude Code, `/bulkhead:scan [30d]`, `/bulkhead:status`, `/bulkhead:log [24h|7d]`, `/bulkhead:doctor` e `/bulkhead:reap` rodam o comando correspondente e resumem o resultado. No seu próprio terminal, rode `npx claude-bulkhead top`, ou instale uma vez com `npm install -g claude-bulkhead` e rode `bulkhead top`. O pacote npm é o mesmo código do plugin. Todo comando que imprime uma tabela aceita `--json`. A referência completa está em [docs/commands.md](docs/commands.md).

### bulkhead status

Todas as sessões do Claude Code na máquina, a memória que a árvore de processos de cada uma usa, o que ela mantém escutando em uma porta, os jobs retidos no bulkhead-slot e os que estão esperando, e a RAM livre:

```
$ bulkhead status
SESSION  STARTED       RSS     PROJECT
18672    Oct 12 17:49  1.4 GB  ~/src/acme-web
  :3000  node.exe  pid 24632
21888    Oct 12 17:52  353 MB  ~/src/acme-web-auth
26448    03:43         625 MB  ~/src/acme-web-checkout
  :3001  node.exe  pid 31020

SLOT    GB  PID    AGE    COMMAND
slot-1  4   30112  6 min  npx playwright test

WAITING  GB  PID    FOR    COMMAND
#1       3   30200  2 min  npm run build

9.9 GB free of 31.8 GB, commit 68%
```

`bulkhead slot ...` é o mesmo que `bulkhead-slot ...`.

### bulkhead top

A mesma visão, ao vivo e em tela cheia. Ela atualiza a cada 2 segundos no Linux e no macOS e a cada 4 segundos no Windows, onde uma varredura de processos leva de 1 a 2 segundos. A varredura roda em uma worker thread, então as teclas nunca esperam por ela. `q`, `Esc` ou `Ctrl-C` saem, `r` atualiza.

```
bulkhead top  14:30:05                                         scan 1.4s  every 4s  q quit  r refresh
RAM ████████████████░░░░░░░░░░░░░░  9.9 GB free of 31.8 GB  commit 68%

SESSIONS 3
PID      STARTED       PROJECT                         RSS              PROCS  PORTS
18672    Oct 12 17:49  ~/src/acme-web               1.4 GB  ██████████     12  :3000 :24678
21888    Oct 12 17:52  ~/src/acme-web-auth          353 MB  ███░░░░░░░      3  -
26448    03:43         ~/src/acme-web-checkout      625 MB  ████░░░░░░      5  :3001

HEAVY JOBS  1 running, 1 waiting
slot-1  4 GB   30112   6 min   npx playwright test
wait #1 3 GB   30200   2 min   npm run build  (this machine has 16 GB; one heavy job at a time)

RECENT BLOCKS
14:29  kill-guard     taskkill-im    ~/src/acme-web-auth      taskkill /F /IM node.exe
14:12  wait-guard     poll-loop      ~/src/acme-web-checkout  until [ -f out/DONE ]; do sleep 30; done
```

Em um terminal estreito, ele remove colunas em vez de quebrar linhas. Quando a saída não é um terminal, ou com `--once`, ele imprime um único retrato do momento e sai.

### bulkhead log

Cada bloqueio, e cada processo que o orphan-reaper encerra, é uma linha JSON em `<state dir>/events.jsonl` com horário, guard, regra, sessão, projeto e o comando cortado em 200 caracteres. O arquivo fica na sua máquina, é rotacionado em 1 MB e mantém um arquivo antigo. `BULKHEAD_NO_LOG=1` desativa o log.

```
$ bulkhead log --summary --since 7d
10 blocks in the last 7 days, 3 projects, 4 sessions

GUARD         RULE             COUNT  LAST
wait-guard    poll-loop            3  06:40  ████████████████████████
wait-guard    long-sleep           2  06:40  ████████████████
basics        force-push-main      1  06:40  ████████
basics        rm-root              1  06:40  ████████
kill-guard    pkill                1  06:40  ████████
kill-guard    taskkill-im          1  06:40  ████████
memory-guard  slot-files           1  06:40  ████████

PROJECT                  COUNT
~/src/acme-web               4
~/src/acme-web-auth          3
~/src/acme-web-checkout      3
```

`bulkhead log -n 20` lista os próprios eventos, `--since 30m|24h|7d|2w|<date>` limita o período e `--guard kill-guard` limita o guard.

### bulkhead doctor

Verifica o Node, os arquivos do plugin, o diretório de estado, os arquivos de configuração, cada guard (ativo ou desativado, e por quê), uma execução real de hook, o leitor de processos com seu tempo, os arquivos de sessão, os limites de RAM calculados para esta máquina, os slots retidos, o log de eventos e o git. O código de saída é 1 quando qualquer verificação falha.

```
$ bulkhead doctor
OK    node            v24.11.0
OK    plugin          ~/.claude/plugins/cache/bulkhead/bulkhead/0.2.2, hooks: 2 SessionStart, 1 SessionEnd, 7 PreToolUse
OK    state dir       ~/.claude/bulkhead is writable
OK    config          no config files, defaults in use
OK    kill-guard      on
OK    wait-guard      on, limit 180s
OK    memory-guard    on
OK    port-guard      on
OK    checkout-guard  on
OK    disk-guard      on
OK    basics          on, protected branches: main, master
OK    orphan-reaper   on, at session start and after each session ends
OK    hook run        kill-guard blocked a test command in 90 ms
OK    processes       356 processes, 21 listening ports, 8 Claude sessions in 2.4s
OK    sessions        ~/.claude/sessions (8 session files)
OK    memory          12.2 of 31.8 GB free, commit 43%, memory-guard blocks heavy commands below 3 GB, bulkhead-slot keeps 5 GB free for a second job, and waits while commit is above 75%
OK    slots           none held
OK    event log       ~/.claude/bulkhead/events.jsonl, empty so far
OK    git             2.52.0.windows.1

19 OK, 0 WARN, 0 FAIL
```

### bulkhead port

Imprime uma porta em que nada está escutando, verificada em IPv4 e IPv6, para que um segundo worktree possa iniciar seu servidor sem adivinhar:

```
npm run dev -- --port $(bulkhead port --near 3000)
```

### bulkhead reap

Roda o orphan-reaper agora. `--dry-run` lista o que ele encerraria, a regra que casou e por que a sessão conta como encerrada, sem encerrar nada:

```
$ bulkhead reap --dry-run
would stop 30112  test-runner  node ~/src/acme-web/node_modules/vitest/dist/workers/forks.js
  Vitest and its worker pool (tinypool); its session has exited and removed snapshot-bash-1791860359256-ezwkie.sh; 6 processes from 30080
1 tree would be stopped. Run `bulkhead reap` to stop it.
```

### Status line

O `bulkhead-statusline` imprime uma linha para a status line do Claude Code:

```
3 sessions  2 heavy  9.1 GB free
```

Sessions são as entradas ativas em `~/.claude/sessions`, heavy é o número de jobs que seguram um bulkhead-slot, e free é a mesma medida que o memory-guard usa. Ele não varre processos, leva menos de 100 ms e mantém a linha em cache por 5 segundos no diretório de estado.

Um plugin não consegue definir a status line principal (as configurações de plugin só aceitam `agent` e `subagentStatusLine`), então adicione-a você mesmo ao `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bulkhead-statusline",
    "refreshInterval": 10
  }
}
```

Isso exige `npm install -g claude-bulkhead`, que coloca o `bulkhead-statusline` no `PATH`. Se você já tem um script de status line, chame o `bulkhead-statusline` a partir dele e acrescente a saída.

## FAQ

**Ele deixa o Claude Code mais lento?**
Um pouco. Cada guard é um processo Node curto. Em um desktop com Windows 11 e Node 24, `node scripts/bench-hooks.js 15` mediu de 40 a 49 ms por guard em um comando permitido (mediana de 15 execuções), e 33 ms só para iniciar o Node. Gravar um bloqueio no log de eventos não acrescenta tempo mensurável. Os guards só fazem trabalho lento, como ler a lista de processos (um ou dois segundos no Windows), quando o comando casa: a inicialização de um dev server em uma porta que já responde, um kill, um comando pesado. A status line leva menos de 100 ms e fica em cache por 5 segundos.

**Ele bloqueou algo que não devia. O que eu faço?**
Rode `bulkhead log` para ver o comando exato e o motivo. Libere-o na configuração do projeto, `<repo>/.claude/bulkhead.json`: `killGuard.allowNames` para um nome de programa, `portGuard.ignorePorts` para uma porta compartilhada, `waitGuard.limitSeconds` para uma espera mais longa, ou `"enabled": false` para o guard inteiro nesse projeto. Veja [docs/configuration.md](docs/configuration.md). Depois, por favor, abra uma [issue de falso positivo](https://github.com/dooly6276/claude-bulkhead/issues/new?template=false-positive.yml) com a linha do `bulkhead log`, para que o padrão seja corrigido para todo mundo.

**Ele é útil com uma única sessão?**
Sim. O kill-guard, o wait-guard, o memory-guard e o basics protegem uma única sessão e seus subagents da mesma forma. O port-guard e o checkout-guard só agem quando há outra sessão ativa, e o orphan-reaper limpa o que ficou de sessões que já terminaram.

**Quais sistemas ele suporta?**
Windows, Linux e macOS, com Node 18 ou mais recente. O orphan-reaper no macOS é testado com fixtures da saída do `ps`, mas ainda não em um Mac de verdade, e no Linux ele precisa de uma versão do Claude Code que defina `CLAUDE_PID` nos shells das ferramentas. No Windows, o `bulkhead-slot` roda comandos pelo Git Bash quando ele está instalado e pelo `cmd.exe` caso contrário.

**Ele envia algo para algum lugar?**
Não. Não há telemetria nem chamadas de rede. O único socket que ele abre é a tentativa de conexão do port-guard a `localhost` para ver se uma porta responde. Os logs ficam no diretório de estado. A única exceção é o `bulkhead remote`, que se conecta por SSH a uma máquina que você configurou, e somente quando você o executa.

Mais perguntas, incluindo como os guards podem ser contornados e como os números de RAM são medidos, estão em [docs/faq.md](docs/faq.md).

## Limitações

- Os guards leem o texto do comando. Eles o dividem em comandos e abrem wrappers como `bash -c`, `cmd /c`, `powershell -EncodedCommand` e `sudo` até três níveis de profundidade, mas um kill ou um sleep escondido em um arquivo de script, em uma função de shell ou em um alias não é visto. Eles pegam os formatos comuns, não um contorno deliberado.
- O memory-guard e o bulkhead-slot só enxergam a RAM. Eles não limitam CPU, disco nem GPU.
- O bulkhead-slot só é usado quando é chamado. Nada obriga todas as sessões a passarem por sua fila.
- A página de cada guard lista seus próprios limites.

## Desinstalação

```
/plugin uninstall bulkhead@bulkhead
/plugin marketplace remove bulkhead
```

Depois, apague o diretório de estado (`~/.claude/bulkhead`, ou `BULKHEAD_STATE_DIR` se você o definiu) e remova a entrada `statusLine` do `~/.claude/settings.json`, caso a tenha adicionado.

## Usa o bulkhead? Mostre

Adicione este badge ao README do seu projeto:

```markdown
[![Guarded by bulkhead](https://img.shields.io/badge/guarded_by-bulkhead-34d6b4?style=flat-square)](https://github.com/dooly6276/claude-bulkhead)
```

Ele aparece assim: [![Guarded by bulkhead](https://img.shields.io/badge/guarded_by-bulkhead-34d6b4?style=flat-square)](https://github.com/dooly6276/claude-bulkhead)

## Contribuindo

Veja o [CONTRIBUTING.md](CONTRIBUTING.md). Relatos de segurança: [SECURITY.md](SECURITY.md). O changelog está no [CHANGELOG.md](CHANGELOG.md), e o que o bulkhead armazena e envia está no [PRIVACY.md](PRIVACY.md).

## Licença

[MIT](LICENSE)
