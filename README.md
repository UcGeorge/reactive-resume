# Reactive Resume (fork)

A self-hosted resume builder and job-search workspace. This is a fork of the open source project
[Reactive Resume](https://github.com/reactive-resume/reactive-resume) by Amruth Pillai, extended with
career tooling and a way to run its AI features from an agent you already pay for.

## What this fork adds

- **Career workspace.** Job evaluations (two-pass, anchored on the posting before the resume is read),
  tailored resume copies with a fact gate, guided cover letters, follow-up cadences, a story bank, and
  a job-board scanner. Background work runs on pg-boss inside the same Postgres.
- **Connected agent (MCP) AI provider.** Any MCP-capable agent (Claude Code, Codex, ...) can serve the
  app's language-model calls: features queue requests, the agent claims them over MCP, answers with its
  own model, and completes them. No extra API key.
- **Per-feature provider routing.** Route chat, import, ATS review, evaluation, tailoring, cover
  letters, outreach and stories to different saved providers, with a Default route as fallback.
- **De-branded UI.** No donation prompts, sponsor links, or social nudges; attribution lives under
  Settings → About.

Everything upstream ships is still here: templates, live preview, PDF/DOCX/JSON export, the ATS checker,
public resume links, the OpenAPI surface, and the MCP server for resumes and applications.

## Quick start

Prerequisites: Node.js 24, pnpm (the version pinned in `package.json`), Docker for Postgres.

```sh
git clone https://github.com/UcGeorge/reactive-resume.git
cd reactive-resume
pnpm install
cp .env.example .env.local        # set APP_URL, DATABASE_URL, AUTH_SECRET at minimum
sudo docker compose -f compose.dev.yml up -d postgres
dotenvx run -f .env.local -- pnpm dev
```

The app listens on port 3000. Saved AI providers, the agent workspace and the connected-agent queue
need `ENCRYPTION_SECRET`; the agent workspace also needs `REDIS_URL`. See `.env.example` for the rest.

## Serving AI from your own agent

1. Settings → API Keys: create a key.
2. Settings → Integrations → Add provider → **Connected agent (MCP)** → Save & Test.
3. In your agent, connect to `https://<your-app>/mcp` with that key and run the `serve_ai_requests`
   prompt. The pending test turns green once the agent answers.
4. Settings → Integrations → Routing: pick which features use the agent.

`RUNBOOK.md` covers deployment, environment variables and the limits of this setup.

## Development

```sh
pnpm test              # per package: pnpm --filter <package> test
pnpm typecheck
pnpm build
pnpm exec turbo boundaries
```

`CLAUDE.md` documents the package layout and conventions.

## License

[MIT](./LICENSE). Copyright for the original project belongs to Amruth Pillai; the license and its
notice are kept as required.
