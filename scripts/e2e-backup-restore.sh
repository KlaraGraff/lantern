#!/usr/bin/env bash
# Real-app check of 备份 → 重置全部数据 → 从备份恢复 (macOS).
#
#   scripts/e2e-backup-restore.sh <lantern-binary> <book.epub>
#
# <lantern-binary> is a debug build (`npx tauri build --debug --no-bundle`
# gives src-tauri/target/debug/lantern). Everything runs under a throwaway
# HOME for the app, so the real library, settings and logs are never touched.
#
# Between launches of the app, the ignored test
# `e2e_backup_reset_restore_phase` seeds a book with a highlight, a note, a
# word and reading progress, backs up, asks for a reset, then stages a restore.
# The app's own startup applies the reset and the restore.
set -euo pipefail

APP_BIN=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
EPUB=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
ROOT=$(cd "$(dirname "$0")/.." && pwd)

WORK=$(mktemp -d "${TMPDIR:-/tmp}/lantern-e2e.XXXXXX")
FAKE_HOME="$WORK/home"
DATA="$FAKE_HOME/Library/Application Support/com.klaragraff.lantern-dev"
LOG="$FAKE_HOME/Library/Logs/com.klaragraff.lantern-dev/lantern.log"
BACKUP="$WORK/backup"
mkdir -p "$FAKE_HOME" "$BACKUP"
echo "e2e: work dir $WORK"

launch() {
  local label=$1 before=0
  [ -f "$LOG" ] && before=$(grep -c "lantern start" "$LOG" || true)
  HOME="$FAKE_HOME" "$APP_BIN" >"$WORK/app-$label.out" 2>&1 &
  local pid=$!
  for _ in $(seq 1 120); do
    if [ -f "$LOG" ] && [ "$(grep -c "lantern start" "$LOG" || true)" -gt "$before" ]; then
      break
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "e2e: app exited during launch '$label'"; cat "$WORK/app-$label.out"; exit 1
    fi
    sleep 1
  done
  [ "$(grep -c "lantern start" "$LOG" || true)" -gt "$before" ] || { echo "e2e: no start line for '$label'"; exit 1; }
  sleep 8 # let startup work (migrations, watchers) settle
  kill -0 "$pid" 2>/dev/null || { echo "e2e: app died after launch '$label'"; cat "$WORK/app-$label.out"; exit 1; }
  kill "$pid"; wait "$pid" 2>/dev/null || true
  echo "e2e: launch '$label' ok"
}

phase() {
  (cd "$ROOT/src-tauri" && LANTERN_E2E_PHASE=$1 LANTERN_E2E_DIR="$DATA" \
    LANTERN_E2E_BACKUP="$BACKUP" LANTERN_E2E_EPUB="$EPUB" \
    cargo test --lib -- --ignored --exact --nocapture \
      commands::library_backup::tests::e2e_backup_reset_restore_phase)
}

launch first-run
phase seed
launch reset
grep -q "reset: local data wiped" "$LOG" || { echo "e2e: app did not apply the reset"; exit 1; }
phase after_reset
launch restore
grep -q "restore: backup snapshot swapped in" "$LOG" || { echo "e2e: app did not swap the backup in"; exit 1; }
phase after_restore
launch after-restore
if grep -qiE "panicked|\[ERROR\]" "$LOG"; then
  echo "e2e: errors in the app log:"; grep -iE "panicked|\[ERROR\]" "$LOG"; exit 1
fi
echo "e2e: PASS — book, highlight, note, word and progress survived backup → reset → restore"
rm -rf "$WORK"
