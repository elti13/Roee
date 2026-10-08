// POST /api/feedback — texts every guest note from /work/eyerus-reviews to the owner's phone, automatically.
// SMS provider, whichever is configured in Vercel → Settings → Environment Variables:
//   Textbelt (simplest, pay per text):  TEXTBELT_KEY
//   Twilio:                             TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (number or MG… service SID)
// FEEDBACK_SMS_TO overrides the owner's number.

const RESTAURANT = 'Eyerus';
const OWNER = process.env.FEEDBACK_SMS_TO || '+17703691014';
const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');

const textbelt = () => Boolean(process.env.TEXTBELT_KEY);
const twilio = () => Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);

// Light per-instance rate limit: a handful of notes per minute per IP.
const hits = new Map();
function limited(req, max = 6, windowMs = 60_000) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  recent.push(now); hits.set(ip, recent);
  return recent.length > max;
}

async function sendSms(body) {
  if (textbelt()) {
    const r = await fetch('https://textbelt.com/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ phone: OWNER, message: body, key: process.env.TEXTBELT_KEY })
    });
    const j = await r.json().catch(() => ({}));
    if (!j.success) throw new Error(`textbelt: ${j.error || r.status}`);
    return;
  }
  const sid = process.env.TWILIO_ACCOUNT_SID, from = process.env.TWILIO_FROM;
  const form = new URLSearchParams({ To: OWNER, Body: body });
  form.set(from.startsWith('MG') ? 'MessagingServiceSid' : 'From', from);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64') },
    body: form
  });
  if (!r.ok) throw new Error(`twilio ${r.status}: ${await r.text()}`);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!textbelt() && !twilio()) return res.status(501).json({ error: 'not_configured' });
  if (limited(req)) return res.status(429).json({ error: 'rate_limited' });

  let b;
  try { b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); }
  catch { return res.status(400).json({ error: 'bad_json' }); }

  const stars = Math.round(Number(b.stars));
  const issue = clip(b.issue, 60);
  const message = clip(b.message, 900).trim();
  if (!(stars >= 1 && stars <= 5) || !(message || issue)) return res.status(400).json({ error: 'invalid_feedback' });

  const followUp = Boolean(b.followUp);
  const name = clip(b.name, 80).trim(), phone = clip(b.phone, 30).trim();
  if (followUp && (!name || phone.replace(/\D/g, '').length < 10)) return res.status(400).json({ error: 'invalid_contact' });

  // Guests who want to talk are flagged on the first line so the owner spots them at a glance.
  const body = [
    followUp && `📞 WANTS TO TALK — ${name} ${phone}`,
    `${stars >= 4 ? '⭐ ' : stars <= 2 ? '⚠️ ' : ''}${RESTAURANT} feedback: ${stars}/5`,
    issue && `Issue: ${issue}`,
    message && `"${message}"`,
    b.posted && `Tapped: Post on ${clip(b.posted, 10)}`,
    clip(b.coupon, 12) && `Coupon ${clip(b.coupon, 12)}`
  ].filter(Boolean).join('\n');

  try {
    await sendSms(body);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ ok: false, error: 'send_failed' });
  }
}
