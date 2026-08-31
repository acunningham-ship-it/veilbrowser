#!/usr/bin/env bash
# veil killer-demo driver — recorded via asciinema. Every command is REAL
# against a real live site (news.ycombinator.com); every printed line is
# demo-batch.ts's actual stdout. No faked output, no canned captions
# standing in for a real run (leakproof-demo-drive.sh pattern).
set -euo pipefail
cd "$(dirname "$0")/.."

type_cmd(){ printf '\033[1;32m$\033[0m '; local c="$1"; local i
  for ((i=0; i<${#c}; i++)); do printf '%s' "${c:$i:1}"; sleep 0.018; done; printf '\n'; sleep 0.35; }
say(){ printf '\033[1;36m%s\033[0m\n' "$1"; sleep 1.0; }

clear; sleep 0.5
say "# veil phase-2: an agent driving a real browser, fast — not just correct"
say "#   old way: goto, snapshot, find target, click, wait, snapshot, extract x2 = 8 MCP calls"
say "#   new way: gotoAndWait, one read, ONE veil_batch = 3 calls, same real site"
sleep 0.6
type_cmd "bun run examples/demo-batch.ts"
bun run examples/demo-batch.ts
sleep 1.5
say "# every result above is real — including the honest moved:false on the scroll step,"
say "#   passed through batch untouched instead of a fake blanket 'ok'."
sleep 1.2
