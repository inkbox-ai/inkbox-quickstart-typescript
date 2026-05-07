/**
 * Centralized env loading. Mirrors the Python sample's env_config.py
 * shape, plus a couple of TS-specific knobs.
 */

import "dotenv/config";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optional(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

export const env = {
  INKBOX_API_KEY: required("INKBOX_API_KEY"),
  INKBOX_SIGNING_KEY: optional("INKBOX_SIGNING_KEY"),
  INKBOX_REQUIRE_SIGNATURE: bool("INKBOX_REQUIRE_SIGNATURE", true),
  INKBOX_BASE_URL: optional("INKBOX_BASE_URL", "https://development.inkbox.ai"),

  INKBOX_TUNNEL_NAME: required("INKBOX_TUNNEL_NAME"),
  INKBOX_TUNNEL_TLS_MODE: (optional("INKBOX_TUNNEL_TLS_MODE", "edge") as "edge" | "passthrough"),
  INKBOX_TUNNEL_SECRET: optional("INKBOX_TUNNEL_SECRET"),
  INKBOX_TUNNEL_ZONE: optional("INKBOX_TUNNEL_ZONE", "development.inkboxwire.com"),
  INKBOX_TUNNEL_STATE_DIR: optional("INKBOX_TUNNEL_STATE_DIR", "./.inkbox-tunnel-state"),

  // When true, bypass Inkbox-managed STT/TTS and bridge call audio
  // directly to the OpenAI Realtime API (g711_ulaw both ways).
  USE_OPENAI_REALTIME: bool("USE_OPENAI_REALTIME", false),
  OPENAI_API_KEY: optional("OPENAI_API_KEY"),
  OPENAI_REALTIME_MODEL: optional("OPENAI_REALTIME_MODEL", "gpt-realtime"),
} as const;

if (env.USE_OPENAI_REALTIME && !env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is required when USE_OPENAI_REALTIME=true.");
}

if (env.INKBOX_REQUIRE_SIGNATURE && !env.INKBOX_SIGNING_KEY) {
  throw new Error(
    "INKBOX_SIGNING_KEY is required when INKBOX_REQUIRE_SIGNATURE=true. " +
      "Set the key in .env or export INKBOX_REQUIRE_SIGNATURE=false for local testing.",
  );
}
