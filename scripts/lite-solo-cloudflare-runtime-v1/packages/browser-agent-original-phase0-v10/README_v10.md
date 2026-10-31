# Browser Agent Home-Exit v10

v10 keeps Playwright on the GitHub-hosted runner and uses the user's Windows PC only as a Tailscale exit node during the browser phase.

## Authentication method

v10 uses the Tailscale GitHub Action auth-key flow.

Required GitHub Actions secret:

- `TAILSCALE_AUTHKEY`

OAuth client secrets are not used by v10.

## Windows PC

The Windows PC only needs Tailscale running in the background and advertising itself as an exit node.

Observed Tailscale IPv4:

`100.112.238.56`

In the Tailscale Windows app/admin console:

1. Advertise **Run as exit node**.
2. Approve **Use as exit node** for this PC if approval is requested.
3. Keep the PC awake while browser automation runs.

## First browser test

Run workflow:

`Original Phase0 Home-Exit Browser v10`

Use:

- `action=observe`
- `mode=create_fresh`
- `home_exit_node=100.112.238.56`
- `interactive_view=true`
- `manual_challenge_wait_minutes=15`

Observe mode sends no ChatGPT message.

The runner joins the tailnet, switches its browser-phase internet egress through the Windows exit node, opens headful Chrome under Xvfb, and waits until ChatGPT backend probes are healthy.

## Manual login / challenge

With `interactive_view=true`, the workflow prints:

`TAILSCALE_VNC=<runner-tailnet-ip>:5900`

From the Windows PC, connect a VNC viewer to that private Tailscale address to interact with the actual runner Chrome window and complete any normal ChatGPT login or verification.

## Resume test

After observe succeeds, run:

- `action=wake`
- `mode=resume_existing`
- `chat_url=https://chatgpt.com/c/6abe90a0-fd68-83e8-8026-8af0171605fc`

v10 only reports delivery when the actual ChatGPT `/backend-api/f/conversation/prepare` request succeeds. A local message bubble or `Unknown error / Retry` is failure.
