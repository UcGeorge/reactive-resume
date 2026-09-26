# Vercel Deployment Runbook

Operational runbook for the `career-ops` fork deployed on Vercel. The Docker (dh) stack remains the fully-featured deployment; Vercel is the lighter, serverless one. Mirrored as a Claude doc; this file is canonical — update it when the deployment changes.

## Deployment overview

| | |
| --- | --- |
| Vercel project | `reactive-resume` (team `petegeorge20005-9028s-projects`, Hobby) |
| Source | `github.com/UcGeorge/reactive-resume`, branch `career-ops`, deployed via CLI from the local checkout |
| Runtime | One Node 24 Function (max 300 s) + static web assets on the CDN; region `iad1` |
| Postgres | Neon `neon-red-ladder` (Free) → `DATABASE_URL` + unpooled variants |
| Redis | Upstash `upstash-kv-coffee-pocket` (Free) → `REDIS_URL` / `KV_URL` |
| Files | Vercel Blob `reactive-resume-files` (private) → `BLOB_READ_WRITE_TOKEN` |

Git auto-deploy is not connected. To enable it: Vercel dashboard → Project → Settings → Git → connect the GitHub repo and set **Production Branch** to `career-ops`.

## Deploying

```bash
cd ~/dockerholicks/reactive-resume
vercel deploy --prod --yes
```

- The cloud build runs `pnpm build`, then `prepare-deployment.mjs`, which **applies database migrations at build time** against Neon (an advisory lock serializes concurrent builds). No runtime migrations.
- After deploy: `https://<prod-url>/api/health` must report `database`, `storage`, `redis` all healthy. A sleeping Neon free-tier database can fail the first check — retry once.
- Rollback (dashboard → Deployments → Promote an older one) rolls back **code only, never the DB schema**. Keep migrations backward-compatible.
- Preview deployments refuse migrations by default (`ALLOW_PREVIEW_MIGRATIONS` unset) — leave it that way unless isolated preview resources are connected.

## Signups

Environment changes only take effect on the **next deployment**.

```bash
# Close signups (do this AFTER creating your own account):
printf 'true' | vercel env add FLAG_DISABLE_SIGNUPS production
vercel deploy --prod --yes

# Re-enable signups:
vercel env rm FLAG_DISABLE_SIGNUPS production --yes
vercel deploy --prod --yes
```

## Secrets and environment variables

- `AUTH_SECRET`, `ENCRYPTION_SECRET`, `CRON_SECRET` are stored as hidden production Secrets in Vercel. A local copy was saved outside the repo — keep the values in a password manager.
- **Never rotate casually**: losing/changing `ENCRYPTION_SECRET` makes saved AI-provider API keys unreadable; changing `AUTH_SECRET` invalidates all sessions.
- Marketplace-injected (do not hand-edit): `DATABASE_URL` + `POSTGRES_*`, `REDIS_URL` + `KV_*`, `BLOB_READ_WRITE_TOKEN`, `NEON_PROJECT_ID`.
- Adding a new app env var requires all three: the var in Vercel, a schema entry in `packages/env/src/server.ts`, and the name in `turbo.json` `globalEnv` — then redeploy.

## Scheduled work

One Vercel cron is configured (`vercel.json`): `GET /api/cron/follow-ups`, daily 08:00 UTC (Hobby timing is approximate). It materializes follow-up reminders and sends the email digest — the digest no-ops until SMTP vars are configured.

**The scanner cron is deliberately off on Vercel**: scanner pacing/fail-skip state is in-memory (cold every invocation), fetches leave from Vercel's shared egress IPs, and a full sweep must fit one Function window. Manual **Scan now** in Discover works at any time.

To re-enable scheduled scanning, either:

1. Add to `vercel.json` `crons` and deploy (Hobby: max 2 crons, daily at most): `{ "path": "/api/cron/scanner", "schedule": "0 6 * * *" }`
2. Or call it from any external scheduler: `GET https://<prod-url>/api/cron/scanner` with header `Authorization: Bearer $CRON_SECRET`.

Both cron endpoints refuse every request when `CRON_SECRET` is unset.

## Career features: Vercel vs Docker

| Feature | Docker (dh) | Vercel |
| --- | --- | --- |
| Evaluations / tailoring | pg-boss queue, retries | in-request via `waitUntil`; ≤ 300 s; manual retry |
| Scheduled scanning | every 6 h (`SCANNER_INTERVAL_HOURS`) | off — manual Scan now only |
| Follow-ups materialize / digest | in-process daily crons | daily Vercel cron; digest inert without SMTP |
| Queue persistence & retries | yes (pg-boss) | no |
| In-app follow-up queue | fresh (recomputes on read) | fresh (same) |

## Troubleshooting

- Logs: `vercel logs <deployment-url>`, or dashboard → Logs.
- Health: `GET /api/health`.
- Evaluation stuck in "running" for > 5 min: the Function was frozen or hit the 300 s cap — use **Retry** in the evaluation panel. There are no automatic retries on Vercel.
- First request after idle is slow / fails: Neon free tier sleeps; retry.
- `413` on large uploads: the web app stages through Blob automatically; API clients must use the large-RPC-requests protocol (`docs/guides/large-rpc-requests`).
- Stray marketplace resources: `vercel integration add <slug>` **provisions a new database on every call** — never retry it blindly. List in dashboard → Storage; delete strays with `vercel integration resource remove <name> --yes`. Keep only: `neon-red-ladder`, `upstash-kv-coffee-pocket`, `reactive-resume-files`.
- Vercel MCP in Claude Code: `/mcp` → `vercel` → authenticate.

## Updating / upstream sync

```bash
git fetch upstream && git checkout main && git merge --ff-only upstream/main
git checkout career-ops && git merge main
pnpm typecheck && pnpm test && pnpm exec turbo boundaries   # gates
git push origin career-ops main
vercel deploy --prod --yes
```

## Incident log

- **2026-09-26** — `vercel link` overwrote `.env.local`; reconstructed from documented defaults (restore from backup if custom values are missing).
- **2026-09-26** — a setup watcher loop retried `vercel integration add` every 30 s with a broken installed-check; each retry provisioned a new database (~11 strays, incl. one Pay-As-You-Go Upstash). All strays deleted; Free-tier keepers unaffected. Lesson recorded in Troubleshooting.
