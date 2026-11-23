#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
docker info >/dev/null
docker compose version
read -r run_uuid < /proc/sys/kernel/random/uuid
export QA_PASSWORD="Qa-$run_uuid"
if [[ ${GITHUB_ACTIONS:-} == true ]]; then
  printf '::add-mask::%s\n' "$QA_PASSWORD"
fi
export REPORT_DIR="$PWD/reports/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$REPORT_DIR"
project="webreg-$$-$(date +%s)"
dc=(docker compose -p "$project")
cleanup() { "${dc[@]}" down -v --remove-orphans; }
trap cleanup EXIT
"${dc[@]}" up -d gitea vikunja
wait_for_service() {
  local service=$1 url=$2 attempts=$3 i
  for ((i = 0; i < attempts; i++)); do
    if "${dc[@]}" exec -T gitea wget -qO /dev/null "$url"; then
      return 0
    fi
    sleep 2
  done
  "${dc[@]}" logs --tail=40 "$service"
  return 1
}

wait_for_service gitea http://localhost:3000/api/healthz 90
for account in qaoperator qareader qaoutsider; do
  email="$account@example.test"
  if [[ $account == qaoperator ]]; then email=qa@example.test; fi
  "${dc[@]}" exec -T -u git gitea gitea admin user create \
    --username "$account" --email "$email" --password "$QA_PASSWORD" \
    --must-change-password=false
done
wait_for_service vikunja http://vikunja:3456/api/v1/info 60
echo "HTML report: $REPORT_DIR/html/index.html"
"${dc[@]}" run --rm tests
