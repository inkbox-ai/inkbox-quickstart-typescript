/**
 * HTTP + WebSocket handlers passed to inkbox.tunnels.connect().
 *
 * The handlers are dispatched in-process by the SDK runtime — no
 * uvicorn/express equivalent needed. The HTTP handler matches the
 * Fetch API shape (Request → Response). The WS handler gets an
 * InkboxWebSocket with an async-iterator of inbound frames + an
 * async send() for outbound.
 */

import { Buffer } from "node:buffer";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { verifyWebhook } from "@inkbox/sdk";
import type {
  MailWebhookPayload,
  PhoneIncomingCallWebhookPayload,
  TextWebhookPayload,
} from "@inkbox/sdk";
import type {
  InkboxHandler,
  InkboxWebSocket,
  InkboxWsHandler,
} from "@inkbox/sdk/tunnels/connect";

import { env } from "./env.js";
import { runRealtimeBridge } from "./realtime_phone_agent.js";

const PAYLOADS_DIR = "./payloads";

// Inkbox-managed STT/TTS: the platform turns caller speech into
// transcript events for us, and speaks our `text` events back. Used
// when USE_OPENAI_REALTIME=false.
const WS_HANDSHAKE_HEADERS_INKBOX_STT_TTS: Array<[string, string]> = [
  ["X-Use-Inkbox-Text-To-Speech", "true"],
  ["X-Use-Inkbox-Speech-To-Text", "true"],
];

// Raw-audio bridge: opt OUT of Inkbox-managed STT/TTS so caller audio
// arrives as `media` events and our outbound `media` events play
// directly. Used when USE_OPENAI_REALTIME=true and we run the OpenAI
// Realtime bridge.
const WS_HANDSHAKE_HEADERS_REALTIME: Array<[string, string]> = [
  ["X-Use-Inkbox-Text-To-Speech", "false"],
  ["X-Use-Inkbox-Speech-To-Text", "false"],
];

async function ensurePayloadsDir(): Promise<void> {
  await mkdir(PAYLOADS_DIR, { recursive: true });
}

async function persistPayload(
  path: string,
  body: Uint8Array,
  req: Request,
): Promise<string> {
  await ensurePayloadsDir();
  const filename = join(PAYLOADS_DIR, `${Date.now()}.json`);
  const wrapper = {
    received_at: new Date().toISOString(),
    path,
    inkbox_request_id: req.headers.get("x-inkbox-request-id") ?? null,
    headers: {
      "content-type": req.headers.get("content-type") ?? null,
      "x-inkbox-timestamp": req.headers.get("x-inkbox-timestamp") ?? null,
      "x-inkbox-signature": req.headers.get("x-inkbox-signature") ?? null,
    },
    payload: tryParseJson(body),
  };
  await writeFile(filename, JSON.stringify(wrapper, null, 2), "utf8");
  return filename;
}

function tryParseJson(body: Uint8Array): unknown {
  const text = new TextDecoder("utf-8").decode(body);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function logSummary(payload: unknown): void {
  const p = payload as
    | MailWebhookPayload
    | TextWebhookPayload
    | PhoneIncomingCallWebhookPayload
    | Record<string, unknown>;
  const contactNames = (cs?: ReadonlyArray<{ name?: string | null }>): string =>
    (cs ?? []).map((c) => c.name).filter(Boolean).join(", ") || "<none>";
  const event_type = (p as { event_type?: string }).event_type;

  if (event_type === "message.received") {
    const mp = p as MailWebhookPayload;
    console.log(
      `[mail] message.received from=${mp.data.message.from_address} subject=${JSON.stringify(mp.data.message.subject)} status=${mp.data.message.status} contacts=${contactNames(mp.data.contacts)}`,
    );
    return;
  }
  if (event_type?.startsWith("text.")) {
    const tp = p as TextWebhookPayload;
    const t = tp.data.text_message;
    console.log(
      `[text] ${event_type} from=${t.remote_phone_number} -> ${t.local_phone_number} text=${JSON.stringify(t.text ?? "")} contacts=${contactNames(tp.data.contacts)}`,
    );
    return;
  }
  if ((p as PhoneIncomingCallWebhookPayload).status === "ringing" && (p as PhoneIncomingCallWebhookPayload).local_phone_number) {
    const cp = p as PhoneIncomingCallWebhookPayload;
    console.log(
      `[phone] incoming_call id=${cp.id} from=${cp.remote_phone_number} -> ${cp.local_phone_number} contacts=${contactNames(cp.contacts)}`,
    );
    return;
  }
  console.log(`[webhook] event_type=${JSON.stringify(event_type ?? "?")}`);
}

/** HTTP handler: /webhook (everything else 404). */
export const httpHandler: InkboxHandler = async (req, _ctx) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/__health") {
    return new Response("OK", { status: 200 });
  }
  if (req.method !== "POST" || url.pathname !== "/webhook") {
    return new Response("Not Found", { status: 404 });
  }

  const body = new Uint8Array(await req.arrayBuffer());

  // Signature verification. The SDK's verifyWebhook() takes the raw
  // body bytes + a headers object; matches the Python side exactly.
  if (env.INKBOX_REQUIRE_SIGNATURE) {
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const ok = verifyWebhook({
      payload: Buffer.from(body),
      headers,
      secret: env.INKBOX_SIGNING_KEY,
    });
    if (!ok) {
      console.warn("[webhook] REJECTED — invalid signature");
      return new Response(JSON.stringify({ detail: "Missing or invalid signature" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
  }

  const filename = await persistPayload(url.pathname, body, req);
  console.log(`Saved -> ${filename}`);
  logSummary(tryParseJson(body));

  // For incoming-call webhooks the platform expects an action payload
  // back. For everything else, plain "OK" is fine.
  const payload = tryParseJson(body) as { status?: string; local_phone_number?: string };
  if (payload?.status === "ringing" && payload?.local_phone_number) {
    return new Response(JSON.stringify({ action: "answer" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("OK", { status: 200 });
};

/** WebSocket handler: /phone/media/ws. Branches on USE_OPENAI_REALTIME. */
export const wsHandler: InkboxWsHandler = async (ws: InkboxWebSocket) => {
  // INSTRUMENTATION: log on entry so we can tell whether the SDK
  // dispatched to us at all. If this line never appears, the SDK's
  // CallableDispatch.dispatchWebSocket isn't being called.
  console.log(`[ws] handler entered url=${ws.url} offered=${ws.offeredProtocols.join(",") || "<none>"}`);
  const url = new URL(ws.url, "https://placeholder.local");
  if (url.pathname !== "/phone/media/ws") {
    await ws.close(1003, "unknown-path");
    return;
  }

  if (env.USE_OPENAI_REALTIME) {
    console.log("[ws] calling ws.accept() with realtime headers");
    await ws.accept({ headers: WS_HANDSHAKE_HEADERS_REALTIME });
    console.log("[ws] /phone/media/ws accepted (OpenAI Realtime bridge)");
    const callId = ws.headers.get("x-inkbox-call-id") ?? "unknown";
    try {
      await runRealtimeBridge({
        ws,
        apiKey: env.OPENAI_API_KEY,
        model: env.OPENAI_REALTIME_MODEL,
        callId,
      });
    } catch (err) {
      console.warn("[ws] realtime bridge crashed:", err);
    }
    console.log("[ws] /phone/media/ws closed (OpenAI Realtime)");
    return;
  }

  await ws.accept({ headers: WS_HANDSHAKE_HEADERS_INKBOX_STT_TTS });
  console.log("[ws] /phone/media/ws accepted (Inkbox STT/TTS mode)");

  // Inkbox-managed TTS expects a streaming-text contract:
  //   {"event":"text","delta":"..."}   <- one or more content frames
  //   {"event":"text","done":true}     <- sentinel that flushes + speaks
  // Sending a single `text` field (or omitting `done`) buffers silently
  // and never plays.
  async function speak(utterance: string): Promise<void> {
    await ws.send(JSON.stringify({ event: "text", delta: utterance }));
    await ws.send(JSON.stringify({ event: "text", done: true }));
  }

  let greeted = false;
  let frames = 0;
  try {
    for await (const frame of ws) {
      frames += 1;
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      let evt: { event?: string; transcript?: string } = {};
      try {
        evt = JSON.parse(text);
      } catch {
        continue;
      }

      if (evt.event === "start" && !greeted) {
        await speak(
          "Hi! You've reached the TypeScript sample server. Say something and I'll repeat it back.",
        );
        greeted = true;
        console.log("[ws] sent greeting");
        continue;
      }

      if (evt.event === "transcript" && evt.transcript) {
        await speak(`You said: ${evt.transcript}`);
        console.log(`[ws] echoed transcript: ${JSON.stringify(evt.transcript)}`);
      }
    }
  } catch (err) {
    console.warn(`[ws] inbound iterator threw after ${frames} frames:`, err);
  }
  console.log(`[ws] /phone/media/ws closed (Inkbox STT/TTS, frames=${frames})`);
};
