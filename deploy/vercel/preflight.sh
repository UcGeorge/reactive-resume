#!/bin/sh
# Fail fast before anything is uploaded: the token must work and the Vercel
# project must be resolvable, either from VERCEL_ORG_ID + VERCEL_PROJECT_ID or
# from a linked checkout (.vercel/project.json, created by `vercel link`).
set -eu

if [ -z "${VERCEL_TOKEN:-}" ]; then
	echo "VERCEL_TOKEN is not set." >&2
	exit 1
fi

org="${VERCEL_ORG_ID:-}"
project="${VERCEL_PROJECT_ID:-}"

if { [ -n "$org" ] && [ -z "$project" ]; } || { [ -z "$org" ] && [ -n "$project" ]; }; then
	echo "VERCEL_ORG_ID and VERCEL_PROJECT_ID must be set together (the Vercel CLI rejects one without the other)." >&2
	exit 1
fi

if [ -z "$org" ]; then
	if [ ! -f .vercel/project.json ]; then
		cat >&2 <<'MSG'
This checkout is not linked to a Vercel project (.vercel/project.json is missing) and
VERCEL_ORG_ID / VERCEL_PROJECT_ID are blank. Either run `vercel link` in the checkout
(Keel Dev) or fill both IDs on the target (Keel Cloud runs from a fresh clone and can
never be linked). The IDs are in .vercel/project.json of any linked checkout.
MSG
		exit 1
	fi
	org="$(jq -r '.orgId // empty' .vercel/project.json)"
	project="$(jq -r '.projectId // empty' .vercel/project.json)"
	echo "Using the linked project from .vercel/project.json"
else
	echo "Using VERCEL_ORG_ID / VERCEL_PROJECT_ID from the target"
fi

echo "Vercel CLI $(vercel --version 2>/dev/null | tail -n1)"
echo "Organization: $org"
echo "Project:      $project"

# The token is read natively from VERCEL_TOKEN; never pass it as a flag.
account="$(vercel whoami 2>/dev/null)" || {
	echo "Authentication failed: VERCEL_TOKEN was rejected. Create a fresh token at vercel.com/account/tokens." >&2
	exit 1
}
echo "Authenticated as: $account"
