# Keel deployment environment for the Vercel deployments in keel.yaml.
# Everything the steps call lives here: the Vercel CLI, git (deployment metadata),
# curl + jq (health check and JSON parsing). Nothing is built in this image;
# Vercel builds the app in its own cloud builder.
FROM node:24-alpine

ARG VERCEL_CLI_VERSION=60.1.3

RUN apk add --no-cache bash curl git jq ca-certificates \
    && npm install -g "vercel@${VERCEL_CLI_VERSION}" \
    && npm cache clean --force \
    # The repository is bind-mounted and owned by the host user.
    && git config --system --add safe.directory '*'

# Nobody is at the keyboard: no prompts, no telemetry, no update nags.
ENV CI=1 \
    VERCEL_TELEMETRY_DISABLED=1 \
    NO_UPDATE_NOTIFIER=1

WORKDIR /workspace
ENTRYPOINT []
