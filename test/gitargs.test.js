'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { gitCall, gitEnv, treeOf, parseArgs } = require('../src/gitargs')

const cwd = path.resolve('/work/shop')

test('gitCall reads every global option before the subcommand', () => {
  const c = gitCall(['git', '--no-pager', '-c', 'a=b', '-C', 'web', '-C', 'lib', '--namespace', 'ns', '--literal-pathspecs', 'status', '-s'], cwd)
  assert.strictEqual(c.sub, 'status')
  assert.deepStrictEqual(c.args, ['-s'])
  assert.strictEqual(c.dir, path.join(cwd, 'web', 'lib'))
  for (const opt of ['-p', '--paginate', '-P', '--no-pager', '--bare', '--no-replace-objects', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--exec-path=/x', '--config-env=a=B']) {
    assert.strictEqual(gitCall(['git', opt, 'add', '-A'], cwd).sub, 'add', opt)
  }
  assert.strictEqual(gitCall(['git', '--exec-path', 'add'], cwd).sub, 'add')
  assert.strictEqual(gitCall(['git', '--config-env', 'a=B', 'add'], cwd).sub, 'add')
  assert.strictEqual(gitCall(['/usr/bin/git.exe', 'add'], cwd).sub, 'add')
  assert.strictEqual(gitCall(['ls', 'add'], cwd), null)
  assert.strictEqual(gitCall(['git'], cwd).sub, undefined)
})

test('--git-dir and --work-tree are resolved and passed on', () => {
  const c = gitCall(['git', '-C', 'web', '--git-dir=../.git', '--work-tree', '..', 'add', '-A'], cwd)
  assert.strictEqual(c.gitDir, path.join(cwd, '.git'))
  assert.strictEqual(c.workTree, cwd)
  assert.deepStrictEqual(c.opts, [`--git-dir=${path.join(cwd, '.git')}`, `--work-tree=${cwd}`])
  assert.strictEqual(treeOf(c, () => assert.fail('no git run needed')), cwd)
  // only --git-dir: git takes the folder it runs in as the tree
  assert.strictEqual(treeOf(gitCall(['git', '--git-dir=/x/.git', 'add'], cwd), () => assert.fail('no git run needed')), cwd)
  assert.strictEqual(treeOf(gitCall(['git', 'add'], cwd), (args, dir) => (args[0] === 'rev-parse' ? `top of ${dir}` : '')), `top of ${cwd}`)
  assert.throws(() => treeOf(gitCall(['git', '--bare', 'add'], cwd), () => ''))
  assert.strictEqual(gitCall(['git', 'add'], cwd, { GIT_WORK_TREE: 'site' }).workTree, path.join(cwd, 'site'))
})

test('gitEnv reads GIT_WORK_TREE and GIT_DIR written in front of a command', () => {
  assert.deepStrictEqual(gitEnv('GIT_WORK_TREE=/srv/site GIT_DIR="/srv/site.git" git checkout -f'), { GIT_WORK_TREE: '/srv/site', GIT_DIR: '/srv/site.git' })
  assert.deepStrictEqual(gitEnv("cd x && GIT_DIR='a b' git status"), { GIT_DIR: 'a b' })
  assert.deepStrictEqual(gitEnv('echo MY_GIT_DIR=x'), {})
})

test('parseArgs reads short clusters, valued options and --', () => {
  const o = parseArgs(['-fAv', '--all', '--message=x', '--file', 'f', 'a', '--', '-b', 'c'], { valuedLong: ['file'] })
  assert.deepStrictEqual([...o.short].sort(), ['A', 'f', 'v'])
  assert.deepStrictEqual([...o.long].sort(), ['all', 'file', 'message'])
  assert.deepStrictEqual(o.pos, ['a', '-b', 'c'])
  assert.deepStrictEqual(o.after, ['-b', 'c'])
  // the rest of a cluster after a valued letter is its value; a last valued letter takes the next word
  const m = parseArgs(['-ma', '-am', 'msg', 'p'], { valuedShort: 'm' })
  assert.deepStrictEqual([...m.short].sort(), ['a', 'm'])
  assert.deepStrictEqual(m.pos, ['p'])
  assert.deepStrictEqual(parseArgs(['-', 'x']).pos, ['-', 'x'])
})
