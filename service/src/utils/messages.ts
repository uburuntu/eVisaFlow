import type { Api } from "grammy";

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

  /** Delete a single message immediately (e.g. user's sensitive input). */
  async deleteNow(messageId: number): Promise<void> {
    try {
      await this.api.deleteMessage(this.chatId, messageId);
    } catch {
      // Message may already be gone
    }
  }

  /** Delete all tracked transient messages. Call in finally block. */
  async cleanup(): Promise<void> {
    const ids = this.transient.splice(0);
    await Promise.allSettled(
      ids.map((id) => this.api.deleteMessage(this.chatId, id)),
    );
  }
}
