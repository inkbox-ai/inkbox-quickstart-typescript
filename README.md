# ts-sample-client-server

TypeScript port of `~/sample-client-server` (Python). Exists to exercise
the `@inkbox/sdk` TypeScript SDK end-to-end — the equivalent of the
Python sample for tunnels, signature verification, phone/mailbox
patching, and the in-process WebSocket bridge.

## What it does

- Builds an `Inkbox` SDK client from env.
- Brings a tunnel online via `inkbox.tunnels.connect(...)` with **in-process**
  HTTP and WebSocket handlers — no separate uvicorn/express required;
  the SDK runtime dispatches into our handler functions directly.
- Patches every phone number + mailbox in the org to point at the
  tunnel host so real Inkbox traffic flows back here.
- HTTP handler at `POST /webhook`: verifies the `X-Inkbox-Signature`
  via `verifyWebhook(...)`, persists the payload to `payloads/`, logs
  a one-line summary, and returns `{action:"answer"}` on incoming-call
  webhooks.
- WS handler at `/phone/media/ws`: opts in to Inkbox-managed STT/TTS
  via the response headers, sends a greeting once the platform sends
  a `start` event, and echoes any `transcript` event back as a `text`
  event for the platform to speak.

This is deliberately the simplest WS shape that proves the SDK works
end-to-end. There's no OpenAI Realtime bridge in v1 — easy to add by
swapping the WS handler, but not needed for an SDK smoke test.

## Setup

Requires Node ≥22.

```bash
# nvm
nvm use 22
# install deps (the SDK is linked in via file:/home/ec2-user/inkbox/sdk/typescript)
npm install
# fill in .env
cp .env.example .env
$EDITOR .env
# run
npm start
```

## Notes

- The SDK is referenced as `file:/home/ec2-user/inkbox/sdk/typescript`
  in `package.json` so local SDK changes pick up on `npm install`. Swap
  to a registry version before sharing this branch.
- `payloads/` is gitignored. So is `.inkbox-tunnel-state*/`.
- The tunnel's `publicHost` is `{INKBOX_TUNNEL_NAME}.{INKBOX_TUNNEL_ZONE}` —
  e.g. for dev, set `INKBOX_TUNNEL_ZONE=development.inkboxwire.com`.
