#!/bin/sh
# GET <url>/api/health until it reports healthy. The first request after idle
# can wake a sleeping Neon database, so retry a few times before failing.
# Usage: health-check.sh <base-url>
set -eu

base="${1:?usage: health-check.sh <base-url>}"
base="${base%/}"
attempts="${HEALTH_CHECK_ATTEMPTS:-6}"
pause="${HEALTH_CHECK_PAUSE_SECONDS:-10}"

i=1
while :; do
	body="$(mktemp)"
	# No -L: a redirect to vercel.com/sso-api means Deployment Protection, not health.
	result="$(curl -sS --max-time 30 -o "$body" -w '%{http_code} %{redirect_url}' "$base/api/health" 2>/dev/null)" || true
	code="${result%% *}"
	redirect="${result#* }"
	[ -n "$code" ] || code=000
	status="$(jq -r '.status // empty' "$body" 2>/dev/null || true)"

	if [ "$code" = "200" ] && [ "$status" = "healthy" ]; then
		echo "Healthy after $i attempt(s):"
		jq '{version, database: .database.status, storage: .storage.status, redis: (.redis.status // "not configured")}' "$body"
		rm -f "$body"
		exit 0
	fi

	protected=false
	case "$code" in
		401 | 403) protected=true ;;
		30[1278]) case "$redirect" in *vercel.com/sso*) protected=true ;; esac ;;
	esac
	if [ "$protected" = "true" ]; then
		rm -f "$body"
		cat >&2 <<MSG
$base/api/health answered HTTP $code${redirect:+ → $redirect}: this URL is behind Vercel Deployment
Protection (SSO). Set PRODUCTION_URL on the target to the public alias, or disable protection for it
in Vercel → Project → Settings → Deployment Protection.
MSG
		exit 1
	fi

	echo "Attempt $i/$attempts: HTTP $code, status '${status:-unknown}'"
	if [ -s "$body" ]; then
		jq -c '{database: .database, storage: .storage, redis: .redis}' "$body" 2>/dev/null || head -c 500 "$body"
		echo
	fi
	rm -f "$body"

	if [ "$i" -ge "$attempts" ]; then
		echo "$base/api/health did not become healthy after $attempts attempts." >&2
		exit 1
	fi
	i=$((i + 1))
	sleep "$pause"
done
