import { test } from "node:test";
import assert from "node:assert/strict";
import { InkboxAPIError, type Inkbox } from "@inkbox/sdk";
import { ensureReceivedSubscription, patchInkboxObjectsToTunnel } from "../src/patch.js";
const url = "https://example.test/webhook";
function row(overrides: Record<string, unknown> = {}) {
  return { id: "sub", agentIdentityId: "identity", ownerIdentityId: "identity", url,
    eventTypes: ["message.received"], hasAuthToken: false, authToken: null, revision: 3, ...overrides };
}
function setup(pages: ReturnType<typeof row>[][]) {
  const updates: unknown[][] = [], creates: unknown[] = [], calls: unknown[] = [];
  let reads = 0;
  const subs = {
    async list(options: unknown) { assert.deepEqual(options, { agentIdentityId: "identity" }); return pages[Math.min(reads++, pages.length - 1)]; },
    async update(...args: unknown[]) { updates.push(args); },
    async create(options: unknown) { creates.push(options); },
  };
  const identity = { id: "identity", phoneNumber: null, imessageEnabled: false,
    async setIncomingCallAction(options: unknown) { calls.push(options); } };
  const client = { webhooks: { subscriptions: subs }, async getIdentity(handle: string) {
    assert.equal(handle, "configured"); return identity;
  }} as unknown as Inkbox;
  return { client, subs, identity, updates, creates, calls, reads: () => reads };
}
test("creates mixed received subscription without channels only on configured identity", async () => {
  const s = setup([[]]);
  await patchInkboxObjectsToTunnel(s.client, "example.test", "configured");
  assert.deepEqual(s.creates, [{ agentIdentityId: "identity", url, eventTypes: ["message.received", "text.received"] }]);
  assert.deepEqual(s.calls, []);
});
test("union preserves extra events and leaves other destinations alone", async () => {
  const s = setup([[row({ eventTypes: ["message.received", "call.ended"] }), row({ url: "https://other.test" })]]);
  await ensureReceivedSubscription(s.client, "identity", url);
  assert.deepEqual(s.updates, [["sub", { eventTypes: ["message.received", "call.ended", "text.received"], expectedRevision: 3 }]]);
});
test("superset requires no mutation", async () => {
  const s = setup([[row({ eventTypes: ["message.received", "text.received", "call.ended"] })]]);
  await ensureReceivedSubscription(s.client, "identity", url);
  assert.deepEqual(s.updates, []);
});
for (const rows of [[row(), row({ id: "second" })], [row({ hasAuthToken: true })], [row({ authToken: "token" })], [row({ agentIdentityId: "other" })]]) {
  test("ambiguous destination fails without mutations", async () => {
    const s = setup([rows]);
    await assert.rejects(ensureReceivedSubscription(s.client, "identity", url), /ambiguous/);
    assert.deepEqual([s.updates, s.creates], [[], []]);
  });
}
test("revision conflict rereads and preserves concurrent event", async () => {
  const s = setup([[row()], [row({ revision: 4, eventTypes: ["message.received", "call.ended"] })]]);
  const update = s.subs.update;
  s.subs.update = async (...args) => { await update(...args); if (s.updates.length === 1) throw new InkboxAPIError(409, "changed"); };
  await ensureReceivedSubscription(s.client, "identity", url);
  assert.equal(s.reads(), 2);
  assert.deepEqual(s.updates[1], ["sub", { eventTypes: ["message.received", "call.ended", "text.received"], expectedRevision: 4 }]);
});
test("create conflict rereads a concurrent superset", async () => {
  const s = setup([[], [row({ eventTypes: ["message.received", "text.received"] })]]);
  s.subs.create = async () => { throw new InkboxAPIError(409, "overlap"); };
  await ensureReceivedSubscription(s.client, "identity", url);
  assert.equal(s.reads(), 2);
  assert.deepEqual(s.updates, []);
});
test("retries are bounded", async () => {
  const s = setup([[row()]]);
  s.subs.update = async () => { throw new InkboxAPIError(409, "changed"); };
  await assert.rejects(ensureReceivedSubscription(s.client, "identity", url), /repeatedly/);
  assert.equal(s.reads(), 3);
});
test("non-conflict errors are not retried", async () => {
  const s = setup([[row()]]);
  s.subs.update = async () => { throw new InkboxAPIError(401, "unauthorized"); };
  await assert.rejects(ensureReceivedSubscription(s.client, "identity", url), /401/);
  assert.equal(s.reads(), 1);
});
test("incoming-call action remains separate", async () => {
  const s = setup([[]]); s.identity.imessageEnabled = true;
  await patchInkboxObjectsToTunnel(s.client, "example.test", "configured");
  assert.deepEqual(s.calls, [{ incomingCallWebhookUrl: url, clientWebsocketUrl: "wss://example.test/phone/media/ws", incomingCallAction: "webhook" }]);
});
test("legacy split coverage is adopted without replacement", async () => {
  const s = setup([[row({ agentIdentityId: null, eventTypes: ["message.received"] }),
    row({ id: "text", agentIdentityId: null, eventTypes: ["text.received"], contextConfig: { email: null, texts: null, calls: null } })]]);
  await ensureReceivedSubscription(s.client, "identity", url);
  assert.deepEqual([s.updates, s.creates], [[], []]);
});
test("different legacy contexts remain ambiguous", async () => {
  const s = setup([[row({ eventTypes: ["message.received"], contextConfig: { email: { mode: "count", count: 2 } } }),
    row({ id: "text", eventTypes: ["text.received"], contextConfig: null })]]);
  await assert.rejects(ensureReceivedSubscription(s.client, "identity", url), /ambiguous/);
  assert.deepEqual([s.updates, s.creates], [[], []]);
});
test("deleted during update rereads merged survivor", async () => {
  const s = setup([[row()], [row({ id: "survivor", eventTypes: ["message.received", "text.received"] })]]);
  s.subs.update = async () => { throw new InkboxAPIError(404, "deleted"); };
  await ensureReceivedSubscription(s.client, "identity", url);
  assert.equal(s.reads(), 2);
  assert.deepEqual(s.creates, []);
});
