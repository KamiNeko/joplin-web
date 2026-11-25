/**
 * Cloudflare Email Worker for Email-to-Note (note@example.com -> POST /api/webhooks/email).
 *
 * Required encrypted Worker secrets / env bindings:
 *   WEBHOOK_URL              https://notes.example.com/api/webhooks/email
 *   WEBHOOK_SECRET           Shared secret matching EMAIL_INGEST_WEBHOOK_SECRET
 *   CF_ACCESS_CLIENT_ID      Cloudflare Access service token client id
 *   CF_ACCESS_CLIENT_SECRET  Cloudflare Access service token client secret
 *   ALLOWED_FROM             Comma-separated allowed envelope senders (e.g. you@example.com)
 */
export default {
  async email(message, env) {
    const allowed = String(env.ALLOWED_FROM || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const sender = String(message.from || '').trim().toLowerCase();
    if (allowed.length === 0 || !allowed.includes(sender)) {
      message.setReject('Unauthorized sender');
      return;
    }

    if (!env.WEBHOOK_URL || !env.WEBHOOK_SECRET || !env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) {
      throw new Error('Missing email worker configuration');
    }

    const raw = await new Response(message.raw).arrayBuffer();
    const headers = {
      'Content-Type': 'message/rfc822',
      'X-Webhook-Secret': env.WEBHOOK_SECRET,
      'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
      'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
    };

    const toLocal = String(message.to || '').split('@')[0] || '';
    const plusIdx = toLocal.indexOf('+');
    if (plusIdx > 0) {
      const subTag = toLocal
        .slice(plusIdx + 1)
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .trim();
      if (subTag) {
        headers['X-Joplin-Tags'] = `email, ${subTag}`;
      }
    }

    const response = await fetch(env.WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: raw,
    });
    if (response.ok) return;
    if (response.status === 400 || response.status === 413) {
      message.setReject(`Rejected (${response.status})`);
      return;
    }
    throw new Error(`Note mail ingest failed (${response.status})`);
  },
};
