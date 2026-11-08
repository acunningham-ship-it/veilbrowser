#!/usr/bin/env bash
# Launcher for the veil MCP server. Independent of the caller's PATH/cwd, and leaves a
# breadcrumb in ~/logs/veil-mcp.log so "disconnected" can be diagnosed after the fact.
#   VEIL_MCP_LOG overrides the log path. VEIL_CDP_URL / VEIL_USER_DATA_DIR pass through.
HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
export HOME
export PATH="$HOME/.bun/bin:${PATH:-/usr/bin:/bin}"
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." || exit 1

LOG="${VEIL_MCP_LOG:-$HOME/logs/veil-mcp.log}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null

cdp=n/a
if [ -n "${VEIL_CDP_URL:-}" ]; then
  u="${VEIL_CDP_URL#*://}"; u="${u%%/*}"
  host="${u%:*}"; port="${u##*:}"
  if timeout 1 bash -c "exec 3<>/dev/tcp/$host/$port" 2>/dev/null; then cdp=yes; else cdp=no; fi
fi
printf '%s startup pid=%s bun=%s cdp=%s cdp_url=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" "$(command -v bun || echo MISSING)" "$cdp" "${VEIL_CDP_URL:-}" >>"$LOG" 2>/dev/null

command -v bun >/dev/null || { echo "veil-mcp: bun not found (PATH=$PATH)" | tee -a "$LOG" >&2; exit 127; }
exec bun run src/mcp.ts 2> >(tee -a "$LOG" >&2)
