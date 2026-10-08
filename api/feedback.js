// POST /api/feedback — texts guest feedback from /work/eyerus-reviews to the owner's phone (Twilio),
// and optionally emails it too (Resend). Low ratings arrive as full notes; happy ratings as a one-line heads-up.
import { isEmail, clip, limited } from './_lib/roee.js';

const RESTAURANT = 'Eyerus';
const smsConfigured = () => Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM && process.env.FEEDBACK_SMS_TO);
const emailConfigured = () => Boolean(process.env.RESEND_API_KEY && process.env.FEEDBACK_TO);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function sendSms(body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const from = process.env.TWILIO_FROM;
  const form = new URLSearchParams({ To: process.env.FEEDBACK_SMS_TO, Body: body });
  form.set(from.startsWith('MG') ? 'MessagingServiceSid' : 'From', from);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64') },
    body: form
  });
  if (!r.ok) throw new Error(`twilio ${r.status}: ${await r.text()}`);
}

async function sendEmail({ subject, rows, message, replyTo }) {
  const html = `<table cellpadding="6" style="font:14px sans-serif">${rows.map(([k, v]) => `<tr><td style="color:#666">${k}</td><td>${esc(v)}</td></tr>`).join('')}</table>`
    + `<p style="font:15px sans-serif;white-space:pre-wrap;border-left:3px solid #E3A93B;padding-left:12px">${esc(message)}</p>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.FEEDBACK_FROM || 'Guest feedback <onboarding@resend.dev>',
      to: process.env.FEEDBACK_TO.split(',').map((s) => s.trim()).filter(Boolean),
      reply_to: replyTo, subject, html
    })
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${await r.text()}`);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!smsConfigured() && !emailConfigured()) return res.status(501).json({ error: 'not_configured' });
  if (limited(req, 5)) return res.status(429).json({ error: 'rate_limited' });

  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const stars = Math.round(Number(b.stars));
  const issue = clip(b.issue, 60);
  const message = clip(b.message, 1500).trim();
  if (!(stars >= 1 && stars <= 5) || !(message || issue)) return res.status(400).json({ error: 'invalid_feedback' });

  const quick = b.kind === 'rating';
  const followUp = !quick && Boolean(b.followUp);
  const name = clip(b.name, 80).trim(), phone = clip(b.phone, 30).trim(), email = isEmail(b.email) ? clip(b.email, 200) : '';
  if (followUp && (!name || phone.replace(/\D/g, '').length < 10)) return res.status(400).json({ error: 'invalid_contact' });

  const coupon = clip(b.coupon, 12);
  const contact = followUp ? [name, phone, email].filter(Boolean).join(' · ') : '';

  const sms = quick
    ? [`⭐ ${stars}/5 at ${RESTAURANT}`, message !== '(no comment)' && `"${clip(message, 300)}"`, coupon && `10% coupon: ${coupon}`]
    : [
        followUp && `📞 WANTS TO TALK — ${contact}`,
        `${stars <= 2 ? '⚠️ ' : ''}${RESTAURANT} feedback: ${stars}/5`,
        issue && `Issue: ${issue}`, clip(b.orderType, 30) && `Order: ${clip(b.orderType, 30)}`,
        message && `"${clip(message, 900)}"`,
        coupon && `10% coupon: ${coupon}`
      ];

  try {
    const jobs = [];
    if (smsConfigured()) jobs.push(sendSms(sms.filter(Boolean).join('\n')));
    if (emailConfigured()) jobs.push(sendEmail({
      subject: `${!quick && stars <= 2 ? '⚠️ ' : ''}${stars}/5 guest ${quick ? 'rating' : 'feedback'} · ${RESTAURANT}${followUp ? ' · wants a call back' : ''}`,
      rows: [['Rating', `${'★'.repeat(stars)}${'☆'.repeat(5 - stars)} (${stars}/5)`], ['Issue', issue || '—'],
        ['Order', clip(b.orderType, 30) || '—'], ['Follow up', contact || 'Not requested'], ['Coupon', coupon || '—']],
      message: message || '(no details written)', replyTo: email || undefined
    }));
    const results = await Promise.allSettled(jobs);
    results.filter((r) => r.status === 'rejected').forEach((r) => console.error(r.reason));
    if (!results.some((r) => r.status === 'fulfilled')) throw new Error('all channels failed');
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ ok: false, error: 'send_failed' });
  }
}
