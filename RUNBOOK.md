# Vercel Deployment Runbook

Operational runbook for the `career-ops` fork deployed on Vercel. The Docker (dh) stack remains the fully-featured deployment; Vercel is the lighter, serverless one. Mirrored as a Claude doc; this file is canonical — update it when the deployment changes.

## Deployment overview

|                |                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| Vercel project | `reactive-resume` (team `petegeorge20005-9028s-projects`, Hobby)                                     |
| Source         | `github.com/UcGeorge/reactive-resume`, branch `career-ops`, deployed from the local checkout        |
| Deploy tooling | Keel — `keel.yaml` + `deploy/vercel.Dockerfile` + `deploy/vercel/*.sh`; `keel dev` UI or `keel deploy` |
| Local checkout | `/Volumes/Nebula/dev/UcGeorge/reactive-resume` (Nebula must be mounted); the dh stack runs it via the wrapper in `~/dockerholicks/reactive-resume/` |
| Runtime        | One Node 24 Function (max 300 s) + static web assets on the CDN; region `iad1`                       |
| Postgres       | Neon `neon-red-ladder` (Free) → `DATABASE_URL` + unpooled variants                                   |
| Redis          | Upstash `upstash-kv-coffee-pocket` (Free) → `REDIS_URL` / `KV_URL`                                   |
| Files          | Vercel Blob `reactive-resume-files` (private) → `BLOB_READ_WRITE_TOKEN`                              |
| Production URL | https://reactive-resume-psi.vercel.app (the team-scoped `*-projects.vercel.app` alias is SSO-walled)  |
| MCP endpoint   | https://reactive-resume-psi.vercel.app/mcp (OAuth — sign in with your Reactive Resume account)        |

Connect Claude Code: `claude mcp add --transport http reactive-resume https://reactive-resume-psi.vercel.app/mcp`, then `/mcp` → reactive-resume → authenticate.

Git auto-deploy is not connected. To enable it: Vercel dashboard → Project → Settings → Git → connect the GitHub repo and set **Production Branch** to `career-ops`.

## Deploying

Deployments are declared in `keel.yaml` ([Keel](https://keel-cloud.mintlify.site)) and run inside the `deploy/vercel.Dockerfile` environment (Node 24, Vercel CLI 60.1.3, git, curl, jq); the step logic is in `deploy/vercel/*.sh`. Vercel still does the build in its own cloud builder — Keel only drives the CLI and verifies the result.

| Deployment        | What it does                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `vercel`          | Checks the token, uploads the checkout, waits for the Vercel build, health-checks `/api/health`. Deploy-time choices: Environment (production default, preview), force rebuild. |
| `vercel-rollback` | `vercel promote` of an earlier deployment (ID or URL) to production, then the same health check. **Code only — the DB schema is not rolled back.** |

Values saved per target (both deployments share them): `VERCEL_TOKEN` (vercel.com → Account Settings → Tokens, scoped to the team), `VERCEL_ORG_ID` + `VERCEL_PROJECT_ID` (leave blank on a linked checkout; both from `.vercel/project.json` when running in Keel Cloud), `PRODUCTION_URL` (optional; where the health check runs, defaults to the shortest alias). `keel manifest vercel -o values.md` writes the how-to-obtain list for whoever fills the form.

```bash
cd /Volumes/Nebula/dev/UcGeorge/reactive-resume
keel validate                                          # after editing keel.yaml or deploy/
keel dev                                               # UI on http://localhost:3400 → create a target, save VERCEL_TOKEN, Deploy
keel deploy vercel --var-file ~/.secrets/rr-vercel.env  # headless; the file holds VERCEL_TOKEN=… (chmod 600, outside the repo)
keel deploy vercel-rollback --var-file ~/.secrets/rr-vercel.env --var DEPLOYMENT=dpl_…
```

Manual fallback (same upload, no health check): `vercel deploy --prod --yes` from the checkout. `.github/workflows/keel.yml` validates `keel.yaml` and builds the environment image whenever they change.

- The cloud build runs `pnpm build`, then `prepare-deployment.mjs`, which **applies database migrations at build time** against Neon (an advisory lock serializes concurrent builds). No runtime migrations.
- After deploy: `https://<prod-url>/api/health` must report `database`, `storage`, `redis` all healthy. The Keel health-check step retries six times, ten seconds apart, because a sleeping Neon free-tier database can fail the first request. A `302` to `vercel.com/sso-api` means the URL is SSO-walled — set `PRODUCTION_URL`.
- Preview deployments refuse migrations by default (`ALLOW_PREVIEW_MIGRATIONS` unset) and their URLs are behind Vercel SSO, so the `vercel` deployment skips the health check for them — leave previews alone unless isolated preview resources are connected.
- Rollback: `vercel-rollback` with the *Deployment ID* output of an earlier run (or dashboard → Deployments → Promote). Rolls back **code only, never the DB schema**. Keep migrations backward-compatible.

## Signups

Environment changes only take effect on the **next deployment**.

```bash
# Close signups (do this AFTER creating your own account):
printf 'true' | vercel env add FLAG_DISABLE_SIGNUPS production
keel deploy vercel --var-file ~/.secrets/rr-vercel.env

# Re-enable signups:
vercel env rm FLAG_DISABLE_SIGNUPS production --yes
keel deploy vercel --var-file ~/.secrets/rr-vercel.env
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

| Feature                         | Docker (dh)                          | Vercel                                            |
| ------------------------------- | ------------------------------------ | ------------------------------------------------- |
| Evaluations / tailoring         | pg-boss queue, retries               | in-request via `waitUntil`; ≤ 300 s; manual retry |
| Scheduled scanning              | every 6 h (`SCANNER_INTERVAL_HOURS`) | off — manual Scan now only                        |
| Follow-ups materialize / digest | in-process daily crons               | daily Vercel cron; digest inert without SMTP      |
| Queue persistence & retries     | yes (pg-boss)                        | no                                                |
| In-app follow-up queue          | fresh (recomputes on read)           | fresh (same)                                      |

## Connected agent (MCP) AI provider

A "Connected agent (MCP)" provider has no API key. Features that need a model queue their calls in the `ai_requests` table; an MCP client you run (Claude Code, Codex, anything MCP-capable) claims them, answers with its own model, and completes them. Settings → Integrations also has a Routing card: assign each AI feature (chat, import, evaluation, ...) to a provider. Unrouted features use the Default route, then the oldest tested provider; a route whose provider is untested, disabled, or deleted falls back the same way and is flagged in the UI.

Serve it from Claude Code:

```sh
claude mcp add --transport http rr https://<your-app>/mcp --header "x-api-key: <key from Settings → API Keys>"
claude   # then: /mcp → rr → prompt serve_ai_requests (keeps claiming until you stop it)
```

Any HTTP client can serve too: `POST /api/openapi/ai-requests/claim` with `{"wait":25}`, then `POST /api/openapi/ai-requests/complete` (`{"id","text"}` or `{"id","toolCalls"}`) or `/fail`.

Environment (declared in `packages/env/src/server.ts`, `turbo.json` globalEnv, `.env.example`):

- `AI_AGENT_REQUEST_TIMEOUT_MS` (default 120000): a queued request nobody claims fails after this long, with a message telling the user to start the serve loop.
- `AI_AGENT_TEST_TIMEOUT_MS` (default 90000): how long Save & Test waits for the agent to answer.

Limits: claims poll Postgres once a second and long-poll up to 25 s per call; a claimed request has a 10-minute lease; terminal rows are deleted after 24 h; the API-key rate limit applies per key. On Vercel an agent chat run is capped at 240 s and evaluations at their 240 s budget, so route `evaluation` (and anything else slow) to an API-key provider there. Import through the agent depends on the client rendering embedded file resources; use an API-key provider for Import if yours cannot. Check the agent vendor's subscription terms before serving automated requests from a consumer plan.

## Troubleshooting

- Logs: `vercel logs <deployment-url>`, or dashboard → Logs.
- Health: `GET /api/health`.
- Evaluation fails with "ran out of time" / "stopped before finishing": the AI provider was too slow for the 240 s budget (Vercel kills Functions at 300 s). Use **Run again**, or switch the default AI provider to a faster model. A run orphaned by a kill is auto-marked failed after 6 min. Find kills with `vercel logs --environment production --since 2h --query "Task timed out"`.
- Tailoring shows "already in progress": one run per application at a time; follow it in the Tailoring tab. A run orphaned mid-flight is auto-marked failed after 6 min (Vercel) / 15 min (Docker).
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
keel deploy vercel --var-file ~/.secrets/rr-vercel.env   # or Deploy in `keel dev`
```

## Incident log

- **2026-09-26** — `vercel link` overwrote `.env.local`; reconstructed from documented defaults (restore from backup if custom values are missing).
- **2026-09-26** — a setup watcher loop retried `vercel integration add` every 30 s with a broken installed-check; each retry provisioned a new database (~11 strays, incl. one Pay-As-You-Go Upstash). All strays deleted; Free-tier keepers unaffected. Lesson recorded in Troubleshooting.
