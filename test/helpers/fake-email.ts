import type { EmailClient, EmailResult } from '../../src/core/email.js';

export function fakeEmail(respond: () => EmailResult = () => ({ ok: true, status: 200 })) {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  let responder = respond;
  const client: EmailClient = {
    async send(to, subject, text) {
      sent.push({ to, subject, text });
      return responder();
    },
  };
  return {
    client,
    sent,
    respondWith(r: () => EmailResult) {
      responder = r;
    },
  };
}
