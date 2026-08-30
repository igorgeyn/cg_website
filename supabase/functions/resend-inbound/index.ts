type ResendEvent = {
  type?: string;
  data?: {
    email_id?: string;
    from?: string;
    to?: string[];
    subject?: string;
  };
};

type ReceivedEmail = {
  id: string;
  from: string;
  to: string[];
  subject: string | null;
  html: string | null;
  text: string | null;
  attachments?: Array<{ filename?: string }>;
};

const inboundAddress = (Deno.env.get("INBOUND_EMAIL") || "orders@igorgeyn.com").trim().toLowerCase();
const forwardTo = (Deno.env.get("INBOUND_FORWARD_TO") || Deno.env.get("ADMIN_EMAIL") || "igorgeyn@gmail.com").trim();

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[char]!);
}

function extractAddress(value: string) {
  const bracketed = value.match(/<([^>]+)>/);
  return (bracketed?.[1] || value).trim().toLowerCase();
}

function decodeBase64(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function verifyWebhook(request: Request, payload: string) {
  const secret = Deno.env.get("RESEND_WEBHOOK_SECRET")?.trim();
  if (!secret) throw new Error("Webhook signing secret is unavailable");

  const id = request.headers.get("svix-id");
  const timestamp = request.headers.get("svix-timestamp");
  const signatureHeader = request.headers.get("svix-signature");
  if (!id || !timestamp || !signatureHeader) throw new Error("Missing webhook signature");

  const timestampNumber = Number(timestamp);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(timestampNumber) || Math.abs(now - timestampNumber) > 300) {
    throw new Error("Expired webhook signature");
  }

  const encodedSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const key = await crypto.subtle.importKey(
    "raw",
    decodeBase64(encodedSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signedPayload = new TextEncoder().encode(`${id}.${timestamp}.${payload}`);
  const signatures = signatureHeader.split(" ")
    .map((signature) => signature.split(",", 2))
    .filter(([version, signature]) => version === "v1" && Boolean(signature));

  for (const [, signature] of signatures) {
    if (await crypto.subtle.verify("HMAC", key, decodeBase64(signature), signedPayload)) return id;
  }
  throw new Error("Invalid webhook signature");
}

async function retrieveEmail(emailId: string) {
  const apiKey = Deno.env.get("RESEND_INBOUND_API_KEY")?.trim();
  if (!apiKey) throw new Error("Inbound Resend API key is unavailable");
  if (!/^re_[A-Za-z0-9_-]+$/.test(apiKey)) {
    throw new Error("Inbound Resend API key has an invalid format; copy the key value again without labels or punctuation");
  }
  let response: Response;
  try {
    response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    throw new Error(`Could not request inbound email: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`Could not retrieve inbound email: ${await response.text()}`);
  return await response.json() as ReceivedEmail;
}

async function forwardEmail(email: ReceivedEmail, webhookId: string) {
  const apiKey = Deno.env.get("RESEND_API_KEY")?.trim();
  const from = Deno.env.get("FROM_EMAIL")?.trim();
  if (!apiKey || !from) throw new Error("Outbound email configuration is unavailable");
  if (!/^re_[A-Za-z0-9_-]+$/.test(apiKey)) throw new Error("Outbound Resend API key has an invalid format");

  const senderAddress = extractAddress(email.from);
  const subject = email.subject?.trim() || "(no subject)";
  const attachmentNames = (email.attachments || []).map((attachment) => attachment.filename).filter(Boolean);
  const body = email.html || `<pre style="white-space:pre-wrap;font:inherit">${escapeHtml(email.text || "")}</pre>`;
  const attachmentNote = attachmentNames.length
    ? `<p><strong>Attachments:</strong> ${attachmentNames.map((name) => escapeHtml(name!)).join(", ")} (available in Resend)</p>`
    : "";

  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `noris-inbound-${webhookId}`,
      },
      body: JSON.stringify({
        from,
        to: [forwardTo],
        reply_to: senderAddress,
        subject: `[Nori's Nibbles inquiry] ${subject}`,
        html: `<div style="font-family:Arial,sans-serif;line-height:1.5"><p><strong>From:</strong> ${escapeHtml(email.from)}<br><strong>To:</strong> ${escapeHtml(email.to.join(", "))}</p>${attachmentNote}<hr>${body}</div>`,
      }),
    });
  } catch (error) {
    throw new Error(`Could not request outbound forward: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`Could not forward inbound email: ${await response.text()}`);
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const payload = await request.text();
    const webhookId = await verifyWebhook(request, payload);
    const event = JSON.parse(payload) as ResendEvent;

    if (event.type !== "email.received") return json({ ok: true, ignored: true });
    const emailId = event.data?.email_id;
    if (!emailId) throw new Error("Inbound email ID is missing");
    const recipients = event.data?.to || [];
    if (!recipients.some((recipient) => extractAddress(recipient) === inboundAddress)) {
      return json({ ok: true, ignored: true });
    }

    const email = await retrieveEmail(emailId);
    await forwardEmail(email, webhookId);
    return json({ ok: true });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Inbound email could not be processed";
    const status = /signature/i.test(message) ? 401 : 500;
    return json({ error: message }, status);
  }
});
