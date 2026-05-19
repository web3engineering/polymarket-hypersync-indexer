#!/usr/bin/env bash
# run-tests.sh — integration test harness for the polymarket-hypersync-indexer
#
# Prerequisites:
#   export ENVIO_API_TOKEN=<your_token>
#   Docker must be running
#
# Usage:
#   bash scripts/run-tests.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
COMPOSE="docker compose -f $ROOT/docker-compose.test.yml"

# ── Block range ────────────────────────────────────────────────────────────────
TEST_START=85500000
TEST_END=85501000
TEST_MID=85500500   # resume split point (first half ends here, exclusive)

# ── Helpers ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[ok]${NC}  $*"; }
info() { echo -e "${YELLOW}[--]${NC}  $*"; }
err()  { echo -e "${RED}[!!]${NC}  $*"; }

PASS_COUNT=0
FAIL_COUNT=0
declare -a FAILURES=()

check_phase() {
  local name="$1"; shift
  if "$@"; then
    ok "$name"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    err "$name FAILED"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILURES+=("$name")
  fi
}

ch_query() {
  # Run a SQL query against local clickhouse; print result as JSON lines
  curl -s "http://localhost:8123/?database=polymarket&default_format=JSONEachRow" \
    --data-binary "$1"
}

ch_count() {
  # Returns the integer count for a table in the given block range
  local table="$1" start="$2" end="$3"
  ch_query "SELECT count() AS n FROM polymarket.${table} WHERE block_number >= ${start} AND block_number < ${end}" \
    | python3 -c "import sys,json; print(json.loads(sys.stdin.read().strip())['n'])" 2>/dev/null || echo 0
}

drop_tables() {
  info "Dropping all test tables..."
  local tables=(
    polymarket_order_filled_v3
    conditional_tokens_condition_preparation
    conditional_tokens_condition_resolution
    conditional_tokens_position_split
    conditional_tokens_positions_merge
    conditional_tokens_payout_redemption
    conditional_tokens_uri
  )
  for t in "${tables[@]}"; do
    ch_query "DROP TABLE IF EXISTS polymarket.${t}" > /dev/null
  done
}

run_indexer() {
  # run_indexer <flow> <start> <end> [extra env...]
  # INDEX_TARGETS defaults to v1 to match production's polymarket_order_filled_v3 scope.
  local flow="$1" start="$2" end="$3"; shift 3
  local extra_env=("$@")

  local env_args=(
    -e "INDEX_FLOW=$flow"
    -e "START_BLOCK=$start"
    -e "END_BLOCK=$end"
    -e "CONDITIONAL_TOKENS_START_BLOCK=$start"
    -e "STREAM_MODE=false"
    -e "INDEX_TARGETS=${INDEX_TARGETS:-v1}"
  )
  for e in "${extra_env[@]}"; do env_args+=(-e "$e"); done

  info "Running indexer: flow=$flow  blocks=[$start, $end)"
  $COMPOSE --profile run run --rm "${env_args[@]}" indexer
}

run_compare() {
  local start="$1" end="$2" check_fills="${3:-1}" check_cond="${4:-1}"
  # PROD_TOKEN is the DB access token (distinct from ENVIO_API_TOKEN used by Hypersync).
  # compare.ts has the correct default; do not override it here.
  START_BLOCK="$start" END_BLOCK="$end" \
    CHECK_FILLS="$check_fills" CHECK_COND="$check_cond" \
    npx --yes tsx "$SCRIPT_DIR/compare.ts"
}

# ── Check prerequisites ────────────────────────────────────────────────────────
if [[ -z "${ENVIO_API_TOKEN:-}" ]]; then
  err "ENVIO_API_TOKEN is not set. Export it before running."
  exit 1
fi

cd "$ROOT"

# ── 1. Start ClickHouse ────────────────────────────────────────────────────────
info "Starting ClickHouse..."
$COMPOSE up -d clickhouse

info "Waiting for ClickHouse Docker healthcheck to pass..."
for i in $(seq 1 60); do
  status=$(docker inspect -f '{{.State.Health.Status}}' polymarket-clickhouse-test 2>/dev/null || echo "unknown")
  if [[ "$status" == "healthy" ]]; then
    ok "ClickHouse is healthy"
    break
  fi
  [[ $i -eq 60 ]] && { err "ClickHouse did not become healthy in time (status: $status)"; exit 1; }
  sleep 2
done

# ── 2. Build indexer image once ────────────────────────────────────────────────
info "Building indexer image..."
$COMPOSE --profile run build indexer

# ══════════════════════════════════════════════════════════════════════════════
# TEST PHASE 1 & 2 — Accuracy (full range, fills + conditional in parallel)
# ══════════════════════════════════════════════════════════════════════════════
info ""
info "═══ Phase 1: Accuracy test — blocks [$TEST_START, $TEST_END) ═══"
info ""

drop_tables

# Run fills and conditional in parallel (they write to different tables)
run_indexer fills "$TEST_START" "$TEST_END" &
FILLS_PID=$!

run_indexer conditional-tokens-events "$TEST_START" "$TEST_END" &
COND_PID=$!

wait $FILLS_PID || { err "Fills indexer (accuracy) failed"; exit 1; }
wait $COND_PID  || { err "Conditional indexer (accuracy) failed"; exit 1; }

info "Accuracy comparison (fills)..."
check_phase "accuracy:fills" run_compare "$TEST_START" "$TEST_END" 1 0

info "Accuracy comparison (conditional)..."
check_phase "accuracy:conditional" run_compare "$TEST_START" "$TEST_END" 0 1

# ══════════════════════════════════════════════════════════════════════════════
# TEST PHASE 3 & 4 — Resume (no gaps, no duplicates)
# ══════════════════════════════════════════════════════════════════════════════
info ""
info "═══ Phase 2: Resume test ═══"
info ""

drop_tables

# Round 1: index first half only
info "Resume round 1 — fills    [$TEST_START, $TEST_MID)"
run_indexer fills "$TEST_START" "$TEST_MID" &
FILLS_R1_PID=$!

info "Resume round 1 — conditional [$TEST_START, $TEST_MID)"
run_indexer conditional-tokens-events "$TEST_START" "$TEST_MID" &
COND_R1_PID=$!

wait $FILLS_R1_PID || { err "Fills round-1 indexer failed"; exit 1; }
wait $COND_R1_PID  || { err "Conditional round-1 indexer failed"; exit 1; }

# Capture mid-point counts for sanity
FILLS_MID=$(ch_count polymarket_order_filled_v3 "$TEST_START" "$TEST_MID")
COND_PREP_MID=$(ch_count conditional_tokens_condition_preparation "$TEST_START" "$TEST_MID")
info "Mid-point counts: fills=$FILLS_MID  cond_preparation=$COND_PREP_MID"

# Round 2: resume to full range (START_BLOCK still set; indexer reads getLastBlock / getProgress)
info "Resume round 2 — fills    [auto-resume → $TEST_END)"
run_indexer fills "$TEST_START" "$TEST_END"

info "Resume round 2 — conditional [auto-resume → $TEST_END)"
run_indexer conditional-tokens-events "$TEST_START" "$TEST_END"

info "Resume comparison (fills)..."
check_phase "resume:fills" run_compare "$TEST_START" "$TEST_END" 1 0

info "Resume comparison (conditional)..."
check_phase "resume:conditional" run_compare "$TEST_START" "$TEST_END" 0 1

# ══════════════════════════════════════════════════════════════════════════════
# SUMMARY
# ══════════════════════════════════════════════════════════════════════════════
info ""
echo "════════════════════════════════════════════════════════════════════════════"
echo "  Results: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"
echo "════════════════════════════════════════════════════════════════════════════"

if [[ $FAIL_COUNT -gt 0 ]]; then
  err "FAILED tests:"
  for f in "${FAILURES[@]}"; do err "  - $f"; done
  echo ""
  # Teardown even on failure
  info "Tearing down..."
  $COMPOSE down -v 2>/dev/null || true
  exit 1
fi

ok "ALL TESTS PASSED"
info "Tearing down..."
$COMPOSE down -v 2>/dev/null || true
