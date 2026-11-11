# Record: vhs docs/demo.tape   then: bash docs/demo-post.sh   then: bash docs/demo-teardown.sh
# The two user turns are typed by docs/demo-drive.sh (tmux send-keys), which decides turn 2 from what Claude did.
Output "/tmp/demo-raw.mp4"
Set Shell "bash"
Set FontFamily "Menlo"
Set FontSize 24
Set Width 1760
Set Height 800
Set Padding 0
Set Margin 0
Set Theme "Catppuccin Mocha"
Set TypingSpeed 22ms

Hide
Type "for v in $(compgen -e | grep -E '^(CLAUDE|ANTHROPIC|AI_AGENT)'); do unset $v; done; export PS1='$ ' && export CLAUDE_CONFIG_DIR=$HOME/.claude-demo && source docs/demo-setup.sh && clear"
Enter
Sleep 4s
Type "echo $(( $(date +%s) + 19 )) > /tmp/demo/showat; bash docs/demo-drive.sh >/dev/null 2>&1 & bash docs/demo-run.sh"
Enter
Sleep 9s
Down
Sleep 800ms
Enter
Sleep 8s
Show
Sleep 100s
