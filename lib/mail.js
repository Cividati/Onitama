// Outgoing email, sent through Resend's HTTP API (https://resend.com). Mail is
// on when RESEND_API_KEY and MAIL_FROM are set; MAIL_TO_CONSOLE=1 prints
// messages to the log instead, for development.
'use strict';

const KEY = process.env.RESEND_API_KEY;
const FROM = process.env.MAIL_FROM; // e.g. "Onitama <noreply@onitama.org>"
const toConsole = process.env.MAIL_TO_CONSOLE === '1';
const enabled = toConsole || (!!KEY && !!FROM);

// Rejects when the message could not be handed over.
async function send({ to, subject, text, html }) {
  if (toConsole) {
    console.log(`--- mail to ${to}: ${subject}\n${text}\n---`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [to], subject, text, html }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Mail provider answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

module.exports = { enabled, send };
