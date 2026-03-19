#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

status=0

section() {
  printf '\n[prepublish-audit] %s\n' "$1"
}

run_secret_scan() {
  section "Scanning tracked files for secret patterns"

  local pattern
  pattern='(sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z\-_]{35}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]+|-----BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY-----|Authorization:[[:space:]]*Bearer[[:space:]]+[A-Za-z0-9._-]{16,}|OPENAI_API_KEY[[:space:]]*=[[:space:]]*[A-Za-z0-9_-]{12,}|ELEVENLABS_API_KEY[[:space:]]*=[[:space:]]*[A-Za-z0-9_-]{12,})'

  if git grep -nI -E "$pattern" -- . >/tmp/doomgen-prepublish-secrets.raw.txt; then
    grep -Ev 'YOUR_[A-Z0-9_]+_HERE|example|changeme|replace_me|<insert' /tmp/doomgen-prepublish-secrets.raw.txt > /tmp/doomgen-prepublish-secrets.txt || true
    if [[ -s /tmp/doomgen-prepublish-secrets.txt ]]; then
      cat /tmp/doomgen-prepublish-secrets.txt
      status=1
    else
      echo "OK"
    fi
  else
    if [[ -f /tmp/doomgen-prepublish-secrets.raw.txt ]]; then
      grep -Ev 'YOUR_[A-Z0-9_]+_HERE|example|changeme|replace_me|<insert' /tmp/doomgen-prepublish-secrets.raw.txt > /tmp/doomgen-prepublish-secrets.txt || true
    fi
    if [[ -s /tmp/doomgen-prepublish-secrets.txt ]]; then
      cat /tmp/doomgen-prepublish-secrets.txt
      status=1
    else
      echo "OK"
    fi
  fi
}

run_pii_scan() {
  section "Scanning tracked files for high-risk PII patterns"

  local pattern
  pattern='(\b\d{3}-\d{2}-\d{4}\b|social security number|passport number|driver.?license number)'

  if git grep -nI -E "$pattern" -- . ':(exclude)scripts/prepublish-audit.sh' >/tmp/doomgen-prepublish-pii.txt; then
    if [[ -s /tmp/doomgen-prepublish-pii.txt ]]; then
      cat /tmp/doomgen-prepublish-pii.txt
      status=1
    else
      echo "OK"
    fi
  else
    if [[ -s /tmp/doomgen-prepublish-pii.txt ]]; then
      cat /tmp/doomgen-prepublish-pii.txt
      status=1
    else
      echo "OK"
    fi
  fi
}

run_tracked_junk_scan() {
  section "Checking tracked files for temp/junk artifacts"

  local pattern
  pattern='(^|/)\.DS_Store$|(^|/)__pycache__/|\.pyc$|\.pyo$|(^|/)\.tmp/|(^|/)tmp/|(^|/)temp/|\.swp$|\.swo$|\.log$|\.env$'

  if git ls-files | rg -n "$pattern" >/tmp/doomgen-prepublish-junk.txt; then
    if [[ -s /tmp/doomgen-prepublish-junk.txt ]]; then
      cat /tmp/doomgen-prepublish-junk.txt
      status=1
    else
      echo "OK"
    fi
  else
    if [[ -s /tmp/doomgen-prepublish-junk.txt ]]; then
      cat /tmp/doomgen-prepublish-junk.txt
      status=1
    else
      echo "OK"
    fi
  fi
}

run_secret_scan
run_pii_scan
run_tracked_junk_scan

if [[ "$status" -ne 0 ]]; then
  printf '\n[prepublish-audit] FAILED\n'
  exit 1
fi

printf '\n[prepublish-audit] PASSED\n'
