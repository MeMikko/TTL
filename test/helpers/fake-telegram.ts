import type { TelegramClient, TelegramResult } from '../../src/core/telegram.js';

export function fakeTelegram(respond: () => TelegramResult = () => ({ ok: true, status: 200 })) {
  const sent: Array<{ chatId: string; text: string }> = [];
  let responder = respond;
  const client: TelegramClient = {
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
      return responder();
    },
    async setWebhook() {
      return { ok: true, status: 200 };
    },
  };
  return {
    client,
    sent,
    respondWith(r: () => TelegramResult) {
      responder = r;
    },
  };
}
