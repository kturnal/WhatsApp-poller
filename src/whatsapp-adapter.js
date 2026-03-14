class WhatsAppAdapter {
  constructor({ client, groupId, ownerJid }) {
    this.client = client;
    this.groupId = groupId;
    this.ownerJid = ownerJid;
  }

  bindEventHandlers(handlers) {
    for (const [eventName, handler] of Object.entries(handlers)) {
      if (typeof handler === 'function') {
        this.client.on(eventName, handler);
      }
    }
  }

  async initialize() {
    await this.client.initialize();
  }

  async destroy() {
    await this.client.destroy();
  }

  async getGroupChat() {
    return this.client.getChatById(this.groupId);
  }

  async getOwnerChat() {
    return this.client.getChatById(this.ownerJid);
  }

  async sendGroupMessage(text) {
    const chat = await this.getGroupChat();
    return chat.sendMessage(text);
  }

  async sendOwnerMessage(text) {
    const chat = await this.getOwnerChat();
    return chat.sendMessage(text);
  }

  async sendGroupPoll(poll) {
    const chat = await this.getGroupChat();
    return chat.sendMessage(poll);
  }

  supportsPollVoteLookup() {
    return typeof this.client.getPollVotes === 'function';
  }

  async getPollVotes(messageId) {
    return this.client.getPollVotes(messageId);
  }

  supportsContactLookup() {
    return typeof this.client.getContactLidAndPhone === 'function';
  }

  async getContactLidAndPhone(userIds) {
    return this.client.getContactLidAndPhone(userIds);
  }
}

module.exports = {
  WhatsAppAdapter
};
