#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
docker info >/dev/null
docker compose version
SNIPE_APP_KEY="base64:$(head -c 32 /dev/urandom | base64)"
export SNIPE_APP_KEY
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
"${dc[@]}" up -d gitea vikunja grist paperless snipe wordpress
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
wait_for_service grist http://grist:8484/status 90
wait_for_service paperless http://paperless:8000/ 150
wait_for_service snipe http://snipe/ 150
snipe_exec=("${dc[@]}" exec -T snipe)
"${snipe_exec[@]}" php artisan migrate --force
"${snipe_exec[@]}" php artisan snipeit:create-admin --first_name=QA --last_name=Operator \
  --email=qa@example.test --username=qaoperator --password="$QA_PASSWORD"
"${snipe_exec[@]}" sh -ec 'test -s storage/oauth-private.key || php artisan passport:keys --no-interaction'
# Use the running Apache worker's effective UID (image UIDs may differ).
web_uid=$("${snipe_exec[@]}" sh -ec '
  for proc in /proc/[0-9]*; do
    read -r name < "$proc/comm" 2>/dev/null || continue
    case "$name" in apache2|httpd) ;; *) continue ;; esac
    uid=$(awk "/^Uid:/ {print \$3}" "$proc/status") || continue
    if [ "$uid" -gt 0 ]; then echo "$uid"; break; fi
  done')
[[ "$web_uid" =~ ^[0-9]+$ ]] || { echo "Could not identify the Apache worker UID." >&2; exit 1; }
keys=(storage/oauth-private.key storage/oauth-public.key)
for key in "${keys[@]}"; do
  if ! "${dc[@]}" exec -T --user "$web_uid" snipe test -r "$key"; then
    echo "Repairing Apache read access to $key"
    "${dc[@]}" exec -T --user 0 snipe chown "$web_uid" "$key"
    "${dc[@]}" exec -T --user 0 snipe chmod 600 "$key"
    "${dc[@]}" exec -T --user "$web_uid" snipe test -r "$key"
  fi
done
"${snipe_exec[@]}" php artisan passport:client --personal --name="Regression tests" --no-interaction >/dev/null
# Only the token goes to fd 3. Framework startup output stays off the token channel.
SNIPE_TOKEN=$("${snipe_exec[@]}" sh -ec 'php -d display_errors=0 3>&1 >/dev/null' < tests/support/snipe-token.php)
[[ -n "$SNIPE_TOKEN" && "$SNIPE_TOKEN" != *[[:space:]]* ]] || {
  echo "Invalid token transfer from Snipe-IT." >&2
  exit 1
}
export SNIPE_TOKEN
if [[ ${GITHUB_ACTIONS:-} == true ]]; then
  printf '::add-mask::%s\n' "$SNIPE_TOKEN"
fi
wait_for_service wordpress http://wordpress/wp-admin/install.php 120
"${dc[@]}" exec -T --user www-data wordpress php < tests/support/wordpress-install.php
# Install the pinned plugin into this run's disposable WordPress container.
plugin_tmp=$(mktemp -d)
trap 'rm -rf -- "$plugin_tmp"; cleanup' EXIT
curl -fsSL --retry 3 https://downloads.wordpress.org/plugin/woocommerce.11.3.0.zip -o "$plugin_tmp/woocommerce.zip"
unzip -q "$plugin_tmp/woocommerce.zip" -d "$plugin_tmp"
"${dc[@]}" cp "$plugin_tmp/woocommerce" wordpress:/var/www/html/wp-content/plugins/
"${dc[@]}" exec -T --user www-data wordpress php < tests/support/woocommerce-install.php
"${dc[@]}" exec -T -e WC_SEED=yes --user www-data wordpress php < tests/support/woocommerce-install.php
echo "HTML report: $REPORT_DIR/html/index.html"
"${dc[@]}" run --rm -e SNIPE_TOKEN tests
