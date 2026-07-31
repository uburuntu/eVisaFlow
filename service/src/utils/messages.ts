import type { Api } from "grammy";

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Tracks message IDs for cleanup after a flow completes. */
export class MessageTracker {
  private chatId: number;
  private api: Api;
  private transient: number[] = [];

  constructor(chatId: number, api: Api) {
    this.chatId = chatId;
    this.api = api;
  }

  /** Track a message to be deleted later. */
  track(messageId: number): void {
    this.transient.push(messageId);
  }

  /** Delete all tracked transient messages. Call in finally block. */
  async cleanup(): Promise<void> {
    const ids = this.transient.splice(0);
    await Promise.allSettled(ids.map((id) => this.api.deleteMessage(this.chatId, id)));
  }
}
