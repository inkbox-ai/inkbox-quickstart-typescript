/**
 * Boot-time helper: repoint every phone number + mailbox in the org
 * at the tunnel's public host. Mirrors the Python sample's
 * `_patch_inkbox_objects_to_tunnel` exactly.
 *
 * Webhook fan-out lives on `inkbox.webhooks.subscriptions` as of
 * SDK 0.4.x; only `incoming_call` stays on the phone-number resource
 * because that callback's response body drives call routing.
 */

import type { Inkbox } from "@inkbox/sdk";

type SubscriptionOwner =
  | { mailboxId: string; phoneNumberId?: undefined }
  | { mailboxId?: undefined; phoneNumberId: string };

async function upsertSubscription(
  inkbox: Inkbox,
  owner: SubscriptionOwner,
  url: string,
  eventTypes: string[],
): Promise<void> {
  const existing = await inkbox.webhooks.subscriptions.list(owner);
  const match = existing.find((s) => s.url === url);
  if (match) {
    await inkbox.webhooks.subscriptions.update(match.id, { eventTypes });
    return;
  }
  await inkbox.webhooks.subscriptions.create({ ...owner, url, eventTypes });
}

export async function patchInkboxObjectsToTunnel(
  inkbox: Inkbox,
  publicHost: string,
): Promise<void> {
  const webhookUrl = `https://${publicHost}/webhook`;
  const wsUrl = `wss://${publicHost}/phone/media/ws`;

  const numbers = await inkbox.phoneNumbers.list();
  for (const n of numbers) {
    await inkbox.phoneNumbers.update(n.id, {
      incomingCallWebhookUrl: webhookUrl,
      clientWebsocketUrl: wsUrl,
      incomingCallAction: "webhook",
    });
    await upsertSubscription(inkbox, { phoneNumberId: n.id }, webhookUrl, [
      "text.received",
    ]);
    console.log(`Patched phone number ${n.number} -> ${webhookUrl} / ${wsUrl}`);
  }

  const mailboxes = await inkbox.mailboxes.list();
  for (const m of mailboxes) {
    await upsertSubscription(inkbox, { mailboxId: m.id }, webhookUrl, [
      "message.received",
    ]);
    console.log(`Patched mailbox ${m.emailAddress} -> ${webhookUrl}`);
  }

  console.log(
    `Inkbox objects patched: ${numbers.length} phone number(s), ${mailboxes.length} mailbox(es) -> ${publicHost}`,
  );
}
