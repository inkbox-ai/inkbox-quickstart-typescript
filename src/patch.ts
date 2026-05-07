/**
 * Boot-time helper: repoint every phone number + mailbox in the org
 * at the tunnel's public host. Mirrors the Python sample's
 * `_patch_inkbox_objects_to_tunnel` function exactly, but uses the TS
 * SDK resources (`inkbox.phoneNumbers.*`, `inkbox.mailboxes.*`).
 */

import type { Inkbox } from "@inkbox/sdk";

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
      incomingTextWebhookUrl: webhookUrl,
      clientWebsocketUrl: wsUrl,
    });
    console.log(`Patched phone number ${n.number} -> ${webhookUrl} / ${wsUrl}`);
  }

  const mailboxes = await inkbox.mailboxes.list();
  for (const m of mailboxes) {
    await inkbox.mailboxes.update(m.emailAddress, { webhookUrl });
    console.log(`Patched mailbox ${m.emailAddress} -> ${webhookUrl}`);
  }

  console.log(
    `Inkbox objects patched: ${numbers.length} phone number(s), ${mailboxes.length} mailbox(es) -> ${publicHost}`,
  );
}
