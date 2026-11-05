// Contact form handler for doublenworks.com (Vercel serverless function).
// Receives the homepage form and emails it to Nate through Resend.
//
// Vercel environment variables:
//   RESEND_API_KEY  (required)  API key from resend.com
//   CONTACT_TO      (optional)  where submissions go, default nate@doublenworks.com
//   CONTACT_FROM    (optional)  sender, default "Double N Works Website <website@doublenworks.com>"

const TO = process.env.CONTACT_TO || 'nate@doublenworks.com';
const FROM = process.env.CONTACT_FROM || 'Double N Works Website <website@doublenworks.com>';

const ROLES = ['Contracting officer', 'COR', 'Small business specialist', 'Prime contractor', 'Business owner', 'Other'];
const LIMITS = { name: 120, organization: 160, role: 40, email: 200, phone: 40, reference: 120, message: 5000 };

// Best-effort rate limit per IP (resets when the function instance recycles).
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 5;
}

function allowedOrigin(origin) {
  if (!origin) return true; // plain HTML form posts from some browsers omit Origin
  try {
    const host = new URL(origin).hostname;
    return host === 'doublenworks.com' || host === 'www.doublenworks.com' ||
      host === 'localhost' || host.endsWith('.vercel.app');
  } catch { return false; }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);

module.exports = async function handler(req, res) {
  const wantsJson = (req.headers['accept'] || '').includes('application/json');
  const reply = (status, body) => {
    if (wantsJson) return res.status(status).json(body);
    // No-JavaScript fallback: send the visitor back to the contact section.
    res.setHeader('Location', body.ok ? '/?sent=1#contact' : '/?sent=0#contact');
    return res.status(303).end();
  };

  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false, error: 'Method not allowed' }); }
  if (!allowedOrigin(req.headers.origin)) return reply(403, { ok: false, error: 'Not allowed' });

  const b = typeof req.body === 'object' && req.body ? req.body : {};

  // Spam traps: a hidden field people never fill in, and a minimum time on the page.
  if (b.website) return reply(200, { ok: true });
  const elapsed = Number(b.elapsed || 0);
  if (elapsed && elapsed < 3000) return reply(200, { ok: true });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) return reply(429, { ok: false, error: 'Too many messages. Please email nate@doublenworks.com directly.' });

  const f = {};
  for (const k of Object.keys(LIMITS)) f[k] = clean(b[k], LIMITS[k]);
  if (!ROLES.includes(f.role)) f.role = 'Other';

  if (!f.name || !f.email || !f.message) return reply(400, { ok: false, error: 'Please add your name, email and a message.' });
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(f.email)) return reply(400, { ok: false, error: 'Please check your email address.' });

  if (!process.env.RESEND_API_KEY) {
    console.error('contact: RESEND_API_KEY is not set');
    return reply(503, { ok: false, error: 'The form is not connected yet. Please email nate@doublenworks.com.' });
  }

  const rows = [
    ['Name', f.name], ['Organization', f.organization || '(not given)'], ['Role', f.role],
    ['Email', f.email], ['Phone', f.phone || '(not given)'], ['Solicitation / contract', f.reference || '(not given)'],
  ];
  const subject = `Website inquiry: ${f.role}${f.organization ? ' | ' + f.organization : ''} (${f.name})`.slice(0, 200);
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\nMessage:\n${f.message}\n\nSent from the doublenworks.com contact form.`;
  const html = `<table style="font:14px/1.5 Arial,sans-serif;border-collapse:collapse">${rows.map(([k, v]) =>
    `<tr><td style="padding:4px 16px 4px 0;color:#5b6570;vertical-align:top"><b>${esc(k)}</b></td><td style="padding:4px 0">${esc(v)}</td></tr>`).join('')}</table>
<p style="font:14px/1.5 Arial,sans-serif;margin-top:16px"><b>Message</b></p>
<p style="font:14px/1.6 Arial,sans-serif;white-space:pre-wrap">${esc(f.message)}</p>
<p style="font:12px/1.5 Arial,sans-serif;color:#8a939c">Sent from the doublenworks.com contact form. Reply to this email to answer ${esc(f.name)} directly.</p>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [TO], reply_to: f.email, subject, text, html }),
    });
    if (!r.ok) {
      console.error('contact: Resend error', r.status, await r.text());
      return reply(502, { ok: false, error: 'Something went wrong sending your message. Please email nate@doublenworks.com.' });
    }
    return reply(200, { ok: true });
  } catch (e) {
    console.error('contact: send failed', e);
    return reply(502, { ok: false, error: 'Something went wrong sending your message. Please email nate@doublenworks.com.' });
  }
};
