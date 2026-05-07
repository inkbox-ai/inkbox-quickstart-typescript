/**
 * OpenAI Realtime API bridge for the Inkbox phone-media WebSocket.
 *
 * When `USE_OPENAI_REALTIME=true`, we opt out of Inkbox-managed STT/TTS
 * via the WS handshake response headers and run the call in raw-audio
 * bridge mode: caller audio arrives as `media` events with base64 PCMU
 * payload, and we send `media` events back to play to the caller.
 *
 * PCMU @ 8 kHz is the same wire format OpenAI Realtime calls
 * `g711_ulaw`, so we don't transcode — just pass the base64 payload
 * through both directions.
 *
 * Direct port of `~/sample-client-server/src/realtime_phone_agent.py`.
 */

import type { InkboxWebSocket } from "@inkbox/sdk/tunnels/connect";
import WebSocket from "ws";

const REALTIME_SYSTEM_PROMPT =
  "You are the Inkbox interactive demo AI phone assistant on a live phone " +
  "call. Speak naturally, briefly, one or two sentences at a time. " +
  "Greet the caller once at the start, then continue the conversation " +
  "normally. Inkbox is an identity and communications platform for AI " +
  "agents — phone numbers, mailboxes, signed webhooks, and a tunneled " +
  "dev surface. Help the caller understand what Inkbox does or answer " +
  "anything else they want to try.";

const REALTIME_VOICE = "alloy";

interface RuntimeOpts {
  ws: InkboxWebSocket;
  apiKey: string;
  model: string;
  callId: string;
}

/**
 * Bridge an accepted Inkbox phone-media WebSocket to OpenAI Realtime.
 * Returns when either side closes or errors.
 */
export async function runRealtimeBridge(opts: RuntimeOpts): Promise<void> {
  const { ws: inkbox, apiKey, model, callId } = opts;

  const openai = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  await new Promise<void>((resolve, reject) => {
    openai.once("open", resolve);
    openai.once("error", reject);
  });

  const sendOpenAI = (msg: object): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      openai.send(JSON.stringify(msg), (err) => (err ? reject(err) : resolve()));
    });

  await sendOpenAI({
    type: "session.update",
    session: {
      modalities: ["audio", "text"],
      instructions: REALTIME_SYSTEM_PROMPT,
      voice: REALTIME_VOICE,
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw",
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 600,
      },
    },
  });
  console.log(`[realtime ${callId}] session.update sent (model=${model})`);

  let streamId: string | null = null;
  let greeted = false;
  let mediaCount = 0;
  let audioOutCount = 0;
  const eventTypeCounts: Record<string, number> = {};

  // OpenAI → Inkbox pump. Reads server events on the openai socket;
  // forwards audio deltas back as `media` frames the platform plays.
  const openaiPromise = new Promise<void>((resolve) => {
    openai.on("message", (data: Buffer) => {
      void (async () => {
        let evt: { type?: string; delta?: string; error?: unknown };
        try {
          evt = JSON.parse(data.toString("utf8"));
        } catch {
          return;
        }
        const etype = evt.type ?? "<unknown>";
        eventTypeCounts[etype] = (eventTypeCounts[etype] ?? 0) + 1;
        if (eventTypeCounts[etype] <= 2) {
          console.log(`[realtime ${callId}] openai event type=${etype}`);
        }

        if (etype === "response.audio.delta" && evt.delta) {
          audioOutCount += 1;
          if ([1, 5, 50].includes(audioOutCount)) {
            console.log(
              `[realtime ${callId}] forwarded outbound audio chunk count=${audioOutCount} bytes_b64=${evt.delta.length}`,
            );
          }
          const out: Record<string, unknown> = {
            event: "media",
            media: { payload: evt.delta, track: "outbound" },
          };
          if (streamId) out.stream_id = streamId;
          try {
            await inkbox.send(JSON.stringify(out));
          } catch {
            // Inkbox WS gone — let the close handler tear us down.
          }
          return;
        }

        if (etype === "response.audio.done") {
          const out: Record<string, unknown> = { event: "audio_done" };
          if (streamId) out.stream_id = streamId;
          try {
            await inkbox.send(JSON.stringify(out));
          } catch {
            /* same as above */
          }
          return;
        }

        if (etype === "input_audio_buffer.speech_started") {
          try {
            await inkbox.send(JSON.stringify({ event: "clear" }));
          } catch {
            /* same as above */
          }
          return;
        }

        if (etype === "error") {
          console.warn(`[realtime ${callId}] error event payload=${JSON.stringify(evt.error)}`);
        }
      })();
    });
    openai.on("close", () => {
      console.log(
        `[realtime ${callId}] openai WS closed (audio_out=${audioOutCount} types=${JSON.stringify(eventTypeCounts)})`,
      );
      resolve();
    });
    openai.on("error", (err) => {
      console.warn(`[realtime ${callId}] openai WS error:`, err);
    });
  });

  // Inkbox → OpenAI pump. Iterates inbound text frames; forwards
  // `media` events into the realtime input buffer.
  const inkboxPromise = (async () => {
    try {
      for await (const frame of inkbox) {
        const text = typeof frame === "string" ? frame : frame.toString("utf8");
        let msg: {
          event?: string;
          stream_id?: string;
          start?: unknown;
          media?: { payload?: string };
        };
        try {
          msg = JSON.parse(text);
        } catch {
          continue;
        }

        if (msg.event === "start") {
          streamId = msg.stream_id ?? streamId;
          console.log(
            `[realtime ${callId}] start event stream_id=${streamId} start=${JSON.stringify(msg.start)}`,
          );
          if (!greeted) {
            greeted = true;
            await sendOpenAI({
              type: "response.create",
              response: {
                instructions:
                  "Greet the caller in one short sentence. Mention this is the " +
                  "Inkbox AI phone agent demo, and offer to explain how this " +
                  "sample is set up or answer whatever else they want to try.",
              },
            });
            console.log(`[realtime ${callId}] greeting response.create sent`);
          }
          continue;
        }

        if (msg.event === "media" && msg.media?.payload) {
          mediaCount += 1;
          if ([1, 5, 50, 200].includes(mediaCount)) {
            console.log(
              `[realtime ${callId}] forwarded inbound media count=${mediaCount} bytes_b64=${msg.media.payload.length}`,
            );
          }
          await sendOpenAI({
            type: "input_audio_buffer.append",
            audio: msg.media.payload,
          });
          continue;
        }

        if (msg.event === "stop") {
          console.log(`[realtime ${callId}] stop event`);
          return;
        }
      }
    } catch (err) {
      console.warn(
        `[realtime ${callId}] inkbox→openai loop crashed (media_count=${mediaCount}):`,
        err,
      );
    }
  })();

  // Wait for either side to drop, then drain the other.
  await Promise.race([openaiPromise, inkboxPromise]);
  try {
    if (openai.readyState === WebSocket.OPEN) openai.close();
  } catch {
    /* ignore */
  }
}
