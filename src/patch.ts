/** Configure only the tunnel's identity, without replacing other subscriptions. */
import { InkboxAPIError, IncomingCallAction, type Inkbox } from "@inkbox/sdk";

const RECEIVED_EVENTS = ["message.received", "text.received"];

export async function ensureReceivedSubscription(
  inkbox: Inkbox,
  agentIdentityId: string,
  url: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const rows = await inkbox.webhooks.subscriptions.list({ agentIdentityId });
    const matches = rows.filter((s) => s.url === url);
    // This receiver authenticates signatures, not delivery bearer tokens. Do not
    // take over another configuration or guess between distinct contexts.
    if (matches.some((s) =>
      (s.agentIdentityId ?? s.ownerIdentityId) !== agentIdentityId ||
      s.hasAuthToken || s.authToken != null)) {
      throw new Error("Webhook destination has an ambiguous owner or configuration; reconcile it before startup.");
    }
    if (matches.length > 1) {
      // Existing split subscriptions can cover this receiver without choosing a survivor.
      const contexts = matches.map((row) => JSON.stringify(
        (["email", "texts", "calls"] as const).map((key) => {
          const value = row.contextConfig?.[key];
          return value ? [value.mode, value.mode === "count" ? value.count : value.hours] : null;
        }),
      ));
      const covered = new Set(matches.flatMap((row) => row.eventTypes));
      if (RECEIVED_EVENTS.every((event) => covered.has(event)) && contexts.every((context) => context === contexts[0])) return;
      throw new Error("Webhook destination has ambiguous event coverage or contexts; reconcile it before startup.");
    }
    const match = matches[0];
    try {
      if (!match) {
        await inkbox.webhooks.subscriptions.create({ agentIdentityId, url, eventTypes: RECEIVED_EVENTS });
      } else {
        const eventTypes = [...new Set([...match.eventTypes, ...RECEIVED_EVENTS])];
        if (eventTypes.length === new Set(match.eventTypes).size) return;
        if (!Number.isSafeInteger(match.revision) || match.revision < 1) {
          throw new Error("Webhook revision is unavailable; update the API before reconciling subscriptions.");
        }
        await inkbox.webhooks.subscriptions.update(match.id, {
          eventTypes, expectedRevision: match.revision,
        });
      }
      return;
    } catch (error) {
      if (!(error instanceof InkboxAPIError) || ![404, 409].includes(error.statusCode)) throw error;
      if (/active webhook subscriptions/i.test(error.message)) throw error;
    }
  }
  throw new Error("Webhook configuration changed repeatedly; retry startup after concurrent edits finish.");
}

export async function patchInkboxObjectsToTunnel(
  inkbox: Inkbox,
  publicHost: string,
  identityHandle: string,
): Promise<void> {
  const identity = await inkbox.getIdentity(identityHandle);
  const webhookUrl = `https://${publicHost}/webhook`;
  await ensureReceivedSubscription(inkbox, identity.id, webhookUrl);
  // Incoming-call responses control routing and remain separate from events.
  if (identity.phoneNumber || identity.imessageEnabled) {
    await identity.setIncomingCallAction({
      incomingCallWebhookUrl: webhookUrl,
      clientWebsocketUrl: `wss://${publicHost}/phone/media/ws`,
      incomingCallAction: IncomingCallAction.WEBHOOK,
    });
  }
  console.log(`Configured identity ${identityHandle} for tunnel ${publicHost}`);
}
