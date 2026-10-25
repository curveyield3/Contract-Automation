# Upgrade Agent Launcher Cloudflare Deployment v1

## Purpose

This Worker is the minimal private launch surface for the Development Agent Task Manager.

It admits tasks to GitHub and displays the final merged output + ChatGPT Project links. It does not automate ChatGPT or supervise agents.

## Cloudflare Access

Protect the Worker route with Cloudflare Access.

Configure Worker variables/secrets:

- `CF_ACCESS_TEAM_DOMAIN` — e.g. `your-team.cloudflareaccess.com`
- `CF_ACCESS_AUD` — Access application audience tag
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_INSTALLATION_ID`

The Worker verifies the Access JWT when `CF_ACCESS_REQUIRED=true`.

For local-only testing, set `CF_ACCESS_REQUIRED=false`.

## GitHub authentication

Preferred: a dedicated GitHub App installed only on the required curveyield3 repositories.

The Worker supports PKCS#1 or PKCS#8 GitHub App private-key PEM values.

As an operator fallback, `GITHUB_TOKEN` may be stored as a Worker secret instead of the App credentials.

Required repository capabilities:

- Contract-Automation contents read/write;
- allowed target repositories contents read;
- target branch/ref reads.

The Worker does not need ChatGPT credentials.

## Deployment

Use Cloudflare Workers Builds / Git integration with this directory as the project root.

Wrangler config is versioned as:

`wrangler_v1.jsonc`

Equivalent CLI deployment:

`wrangler deploy --config wrangler_v1.jsonc`

Do not commit secrets.
