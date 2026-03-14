const { normalizeJid } = require('./config');

function serializeMessageId(message) {
  if (!message || !message.id) {
    return null;
  }

  return serializeMessageKey(message.id);
}

function serializeMessageKey(key) {
  if (!key) {
    return null;
  }

  if (typeof key === 'string') {
    return key;
  }

  if (typeof key._serialized === 'string') {
    return key._serialized;
  }

  if (typeof key.id === 'string') {
    return key.id;
  }

  if (key.id && typeof key.id._serialized === 'string') {
    return key.id._serialized;
  }

  return null;
}

function extractParentMessageId(voteUpdate) {
  const candidates = [
    voteUpdate?.parentMessage?.id,
    voteUpdate?.parentMsgKey,
    voteUpdate?.msgKey,
    voteUpdate?.id
  ];

  for (const candidate of candidates) {
    const serialized = serializeMessageKey(candidate);
    if (serialized) {
      return serialized;
    }
  }

  return null;
}

function getMessageSenderJid(message) {
  const sender = message?.author || message?.id?.participant || message?.from;
  if (!sender) {
    return null;
  }

  try {
    return normalizeJid(sender);
  } catch {
    return null;
  }
}

module.exports = {
  extractParentMessageId,
  getMessageSenderJid,
  serializeMessageId,
  serializeMessageKey
};
