#!/bin/sh
# Deploy the mounted checkout to Vercel and export what later steps and the
# outputs need. Vercel runs the build (pnpm build + prepare-deployment.mjs,
# which applies database migrations) in its own cloud builder.
#
# Inputs (exported by Keel):
#   ENVIRONMENT     production | preview            (default production)
#   FORCE_REBUILD   true to skip Vercel's build cache (default false)
#   PRODUCTION_URL  optional public URL that the production alias answers on
# Exports: DEPLOYMENT_URL, DEPLOYMENT_ID, INSPECT_URL, APP_URL, GIT_COMMIT
set -eu

environment="${ENVIRONMENT:-production}"
set -- deploy --yes --target "$environment"
if [ "${FORCE_REBUILD:-false}" = "true" ]; then
	set -- "$@" --force
fi

echo "Deploying $(git rev-parse --short HEAD 2>/dev/null || echo '<no git>') to Vercel ($environment)"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
	echo "Note: the working tree has uncommitted changes; they will be part of this deployment."
fi

# `vercel deploy` prints only the deployment URL on stdout; progress and build
# output go to stderr and stream into the run log.
out="$(mktemp)"
vercel "$@" >"$out"
deployment_url="$(tail -n 1 "$out" | tr -d '[:space:]')"
rm -f "$out"

case "$deployment_url" in
	https://*) ;;
	*)
		echo "Could not read the deployment URL from the Vercel CLI output: '$deployment_url'" >&2
		exit 1
		;;
esac

info="$(vercel inspect "$deployment_url" --json 2>/dev/null)"
deployment_id="$(printf '%s' "$info" | jq -r '.id // empty')"
ready_state="$(printf '%s' "$info" | jq -r '.readyState // empty')"
context="$(printf '%s' "$info" | jq -r '.contextName // empty')"

if [ "$ready_state" != "READY" ]; then
	echo "Deployment $deployment_url is in state '$ready_state', expected READY." >&2
	exit 1
fi

if [ "$environment" = "production" ]; then
	app_url="${PRODUCTION_URL:-}"
	if [ -z "$app_url" ]; then
		# Prefer a custom domain; otherwise the shortest *.vercel.app alias. The
		# team-scoped <project>-<team>.vercel.app alias is behind Vercel SSO.
		app_url="$(printf '%s' "$info" | jq -r '
			[.aliases[]?] as $a
			| ([$a[] | select(endswith(".vercel.app") | not)] | first)
			  // ($a | sort_by(length) | first)
			  // empty')"
		[ -n "$app_url" ] && app_url="https://$app_url"
	fi
	[ -n "$app_url" ] || app_url="$deployment_url"
else
	app_url="$deployment_url"
fi

export DEPLOYMENT_URL="$deployment_url"
export DEPLOYMENT_ID="$deployment_id"
export APP_URL="${app_url%/}"
export GIT_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
if [ -n "$context" ] && [ -n "$deployment_id" ]; then
	export INSPECT_URL="https://vercel.com/$context/$(printf '%s' "$info" | jq -r '.name')/$deployment_id"
else
	export INSPECT_URL="$deployment_url"
fi

echo
echo "Deployment: $DEPLOYMENT_URL ($DEPLOYMENT_ID)"
echo "App URL:    $APP_URL"
echo "Inspect:    $INSPECT_URL"
