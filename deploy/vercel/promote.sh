#!/bin/sh
# Point the production aliases at an existing deployment (rollback / roll
# forward). Code only: database migrations already applied are not reverted.
#
# Inputs (exported by Keel):
#   DEPLOYMENT      deployment URL or dpl_… ID to promote
#   PRODUCTION_URL  optional public URL that the production alias answers on
# Exports: DEPLOYMENT_URL, DEPLOYMENT_ID, APP_URL, GIT_COMMIT
set -eu

target="${DEPLOYMENT:?DEPLOYMENT is required}"
target="${target#https://}"
target="${target%/}"

info="$(vercel inspect "$target" --json 2>/dev/null)" || {
	echo "No deployment found for '$target' in this project." >&2
	exit 1
}
deployment_url="https://$(printf '%s' "$info" | jq -r '.url')"
deployment_id="$(printf '%s' "$info" | jq -r '.id')"
ready_state="$(printf '%s' "$info" | jq -r '.readyState // empty')"

if [ "$ready_state" != "READY" ]; then
	echo "Deployment $deployment_url is in state '$ready_state'; only READY deployments can be promoted." >&2
	exit 1
fi

echo "Promoting $deployment_url ($deployment_id) to production"
vercel promote "$deployment_id" --yes --timeout 5m

info="$(vercel inspect "$deployment_id" --json 2>/dev/null)"
app_url="${PRODUCTION_URL:-}"
if [ -z "$app_url" ]; then
	app_url="$(printf '%s' "$info" | jq -r '
		[.aliases[]?] as $a
		| ([$a[] | select(endswith(".vercel.app") | not)] | first)
		  // ($a | sort_by(length) | first)
		  // empty')"
	[ -n "$app_url" ] && app_url="https://$app_url"
fi
[ -n "$app_url" ] || app_url="$deployment_url"

export DEPLOYMENT_URL="$deployment_url"
export DEPLOYMENT_ID="$deployment_id"
export APP_URL="${app_url%/}"
export GIT_COMMIT="$(printf '%s' "$info" | jq -r '.meta.githubCommitSha // "unknown"')"

echo
echo "Production now serves: $DEPLOYMENT_URL ($DEPLOYMENT_ID)"
echo "App URL:               $APP_URL"
