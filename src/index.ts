/**
 * Sample Inkbox client/server in TypeScript.
 *
 *   1. Build an Inkbox SDK client from env.
 *   2. Bring a tunnel online via `inkbox.tunnels.connect(...)` with
 *      in-process HTTP + WS handlers (no separate uvicorn/express
 *      process needed; the SDK runtime dispatches scopes directly into
 *      our handlers).
 *   3. Configure only the tunnel identity at the tunnel host so
 *      real Inkbox traffic flows back here.
 *   4. Block on `listener.wait()` until SIGTERM/SIGINT.
 */

import { Inkbox } from "@inkbox/sdk";
import { connect } from "@inkbox/sdk/tunnels/connect";

import { env } from "./env.js";
import { httpHandler, wsHandler } from "./handlers.js";
import { patchInkboxObjectsToTunnel } from "./patch.js";

async function main(): Promise<void> {
  console.log(
    `Inkbox sample TS client/server starting (verify signatures: ${env.INKBOX_REQUIRE_SIGNATURE})`,
  );

  const inkbox = new Inkbox({
    apiKey: env.INKBOX_API_KEY,
    baseUrl: env.INKBOX_BASE_URL,
  });

  const listener = await connect(inkbox, {
    name: env.INKBOX_TUNNEL_NAME,
    handler: httpHandler,
    wsHandler,
    stateDir: env.INKBOX_TUNNEL_STATE_DIR,
    dataPlaneZone: env.INKBOX_TUNNEL_ZONE || undefined,
    onStatus: (status) => console.log(`[tunnel-status] ${status}`),
  });

  // listener.publicUrl is the canonical "https://{publicHost}". Strip
  // the scheme to get a bare host suitable for the patch URLs.
  const publicHost = new URL(listener.publicUrl).host;
  console.log(`Tunnel ready at ${listener.publicUrl}`);

  await patchInkboxObjectsToTunnel(inkbox, publicHost, env.INKBOX_TUNNEL_NAME);

  console.log("Waiting for traffic. Ctrl-C to stop.");
  await listener.wait();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
