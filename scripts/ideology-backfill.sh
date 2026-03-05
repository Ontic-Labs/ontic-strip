#!/usr/bin/env bash
# ideology-backfill.sh — Score the N most recent aggregated documents
# Usage: ./scripts/ideology-backfill.sh [LIMIT] [CONCURRENCY]
#   LIMIT       Number of docs to process (default 100)
#   CONCURRENCY Max parallel requests (default 3)

set -euo pipefail

LIMIT="${1:-100}"
CONCURRENCY="${2:-3}"
DB_URL='postgresql://postgres:%40ntic-labs-2026-3-3@db.hvxyimtblcjncqiqiuyv.supabase.co:5432/postgres?sslmode=require'
EDGE_URL='https://hvxyimtblcjncqiqiuyv.supabase.co/functions/v1/oracle-ideology'
AUTH='Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh2eHlpbXRibGNqbmNxaXFpdXl2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjU2MzY3OSwiZXhwIjoyMDg4MTM5Njc5fQ.5MgXlnB8Gsgn8QlGsrBidTx7Y-GQLw3JvM3hidbJ-sQ'

echo "Fetching $LIMIT most recent aggregated document IDs..."
DOCS=$(/opt/homebrew/bin/psql "$DB_URL" -t -A -c "
  SELECT id FROM documents
  WHERE pipeline_status = 'aggregated'
  ORDER BY created_at DESC
  LIMIT $LIMIT;
")

TOTAL=$(echo "$DOCS" | wc -l | tr -d ' ')
echo "Processing $TOTAL documents (concurrency=$CONCURRENCY)"
echo "---"

SCORED=0
MATCHED=0
ERRORS=0
DONE=0

process_doc() {
  local doc_id="$1"
  local idx="$2"
  local result
  result=$(curl -s --max-time 58 \
    "$EDGE_URL" \
    -H "Authorization: $AUTH" \
    -H "Content-Type: application/json" \
    -d "{\"document_id\": \"$doc_id\"}" 2>&1)

  local score
  score=$(echo "$result" | grep -o '"score":[^,}]*' | head -1 | cut -d: -f2)
  local stances
  stances=$(echo "$result" | grep -o '"total_stances":[0-9]*' | cut -d: -f2)
  local matched
  matched=$(echo "$result" | grep -o '"segments_matched":[0-9]*' | cut -d: -f2)

  if echo "$result" | grep -q '"error"'; then
    echo "[$idx/$TOTAL] $doc_id  ERROR"
    return 2
  elif [ "$score" != "null" ] && [ -n "$score" ]; then
    echo "[$idx/$TOTAL] $doc_id  score=$score stances=$stances matched=$matched"
    return 0
  else
    echo "[$idx/$TOTAL] $doc_id  null (stances=${stances:-0} matched=${matched:-0})"
    return 1
  fi
}

IDX=0
RUNNING=0
PIDS=()

for doc_id in $DOCS; do
  IDX=$((IDX + 1))
  process_doc "$doc_id" "$IDX" &
  PIDS+=($!)
  RUNNING=$((RUNNING + 1))

  if [ "$RUNNING" -ge "$CONCURRENCY" ]; then
    for pid in "${PIDS[@]}"; do
      wait "$pid" && SCORED=$((SCORED + 1)) || {
        rc=$?
        if [ "$rc" -eq 1 ]; then
          MATCHED=$((MATCHED + 1))
        else
          ERRORS=$((ERRORS + 1))
        fi
      }
      DONE=$((DONE + 1))
    done
    PIDS=()
    RUNNING=0
  fi
done

# Drain remaining
for pid in "${PIDS[@]}"; do
  wait "$pid" && SCORED=$((SCORED + 1)) || {
    rc=$?
    if [ "$rc" -eq 1 ]; then
      MATCHED=$((MATCHED + 1))
    else
      ERRORS=$((ERRORS + 1))
    fi
  }
  DONE=$((DONE + 1))
done

echo ""
echo "=== SUMMARY ==="
echo "Total:   $TOTAL"
echo "Scored:  $SCORED"
echo "Null:    $MATCHED"
echo "Errors:  $ERRORS"
echo "Rate:    $(( SCORED * 100 / TOTAL ))%"
