#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
docker info >/dev/null
docker compose version
export QA_PASSWORD="Qa-$(cat /proc/sys/kernel/random/uuid)"
export REPORT_DIR="$PWD/reports/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$REPORT_DIR"
project="webreg-$$-$(date +%s)"
dc=(docker compose -p "$project")
cleanup() { "${dc[@]}" down -v --remove-orphans; }
trap cleanup EXIT
"${dc[@]}" up -d gitea vikunja
ready=false
for _ in {1..90}; do
  if "${dc[@]}" exec -T gitea wget -qO /dev/null http://localhost:3000/api/healthz; then ready=true; break; fi
  sleep 2
done
if ! $ready; then "${dc[@]}" logs --tail=40 gitea; exit 1; fi
"${dc[@]}" exec -T -u git gitea gitea admin user create --username qaoperator --email qa@example.test --password "$QA_PASSWORD" --must-change-password=false
for account in qareader qaoutsider; do
  "${dc[@]}" exec -T -u git gitea gitea admin user create --username "$account" --email "$account@example.test" --password "$QA_PASSWORD" --must-change-password=false
done
ready=false
for _ in {1..60}; do
  if "${dc[@]}" exec -T gitea wget -T 3 -qO /dev/null http://vikunja:3456/api/v1/info; then ready=true; break; fi
  sleep 2
done
if ! $ready; then "${dc[@]}" logs --tail=40 db vikunja; exit 1; fi
echo "HTML report: $REPORT_DIR/html/index.html"
"${dc[@]}" run --rm tests
