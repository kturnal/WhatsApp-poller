require('dotenv').config();

const path = require('node:path');
const qrcodeTerminal = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const { loadClientRuntimeConfig } = require('./config');
const { errorMetadata, log, setLogOptions } = require('./logger');
const { enforceSecureRuntimePermissions } = require('./runtime-security');

function serializeChatId(chat) {
  if (!chat || !chat.id) {
    return null;
  }

  if (typeof chat.id === 'string') {
    return chat.id;
  }

  if (typeof chat.id._serialized === 'string') {
    return chat.id._serialized;
  }

  return null;
}

function isGroupChat(chat) {
  if (chat?.isGroup === true) {
    return true;
  }

  const chatId = serializeChatId(chat);
  return typeof chatId === 'string' && chatId.endsWith('@g.us');
}

function getChatLabel(chat) {
  const name = [chat?.name, chat?.formattedTitle, chat?.pushname].find(
    (value) => typeof value === 'string' && value.trim().length > 0
  );

  if (name) {
    return name.trim();
  }

  const chatId = serializeChatId(chat);
  return chatId ? `Unnamed group (${chatId})` : 'Unnamed group';
}

function collectGroupCandidates(chats) {
  return chats
    .filter((chat) => isGroupChat(chat))
    .map((chat) => {
      const id = serializeChatId(chat);
      if (!id) {
        return null;
      }

      return {
        id,
        name: getChatLabel(chat)
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      const byName = left.name.localeCompare(right.name, 'en', { sensitivity: 'base' });
      if (byName !== 0) {
        return byName;
      }

      return left.id.localeCompare(right.id, 'en', { sensitivity: 'base' });
    });
}

function printGroupCandidates(output, groups) {
  if (groups.length === 0) {
    output.write(
      'No WhatsApp groups were found for this account. Join the target group first, then rerun this helper.\n'
    );
    return;
  }

  output.write('Available WhatsApp groups:\n');
  for (const [index, group] of groups.entries()) {
    output.write(`${index + 1}. ${group.name}\n`);
    output.write(`   GROUP_ID=${group.id}\n`);
  }
}

async function runGroupDiscovery({ output = process.stdout, clientFactory } = {}) {
  let config;

  try {
    config = loadClientRuntimeConfig();
  } catch (error) {
    log('ERROR', 'Invalid runtime configuration for group discovery.', errorMetadata(error));
    process.exitCode = 1;
    return;
  }

  setLogOptions({
    redactSensitive: config.logRedactSensitive,
    includeStack: config.logIncludeStack
  });

  try {
    enforceSecureRuntimePermissions(config.dataDir);
  } catch (error) {
    log('ERROR', 'Failed to secure DATA_DIR before group discovery.', errorMetadata(error));
    process.exitCode = 1;
    return;
  }

  const puppeteerArgs = [];
  if (config.allowInsecureChromium) {
    puppeteerArgs.push('--no-sandbox', '--disable-setuid-sandbox');
    log('WARN', 'Chromium sandbox is disabled by ALLOW_INSECURE_CHROMIUM=true.');
  }

  const client =
    clientFactory ||
    new Client({
      authStrategy: new LocalAuth({
        clientId: config.clientId,
        dataPath: path.join(config.dataDir, 'session')
      }),
      puppeteer: {
        headless: config.headless,
        args: puppeteerArgs
      }
    });

  try {
    const groups = await new Promise((resolve, reject) => {
      let settled = false;
      const resolveOnce = (value) => {
        if (settled) {
          return;
        }

        settled = true;
        resolve(value);
      };
      const rejectOnce = (error) => {
        if (settled) {
          return;
        }

        settled = true;
        reject(error);
      };

      client.on('qr', (qr) => {
        output.write('Scan the QR code with WhatsApp to list your available groups.\n');
        qrcodeTerminal.generate(qr, { small: true });
      });

      client.once('ready', async () => {
        try {
          const chats = await client.getChats();
          resolveOnce(collectGroupCandidates(Array.isArray(chats) ? chats : []));
        } catch (error) {
          rejectOnce(error);
        }
      });

      client.once('auth_failure', (message) => {
        rejectOnce(new Error(`Authentication failure during group discovery: ${message}`));
      });

      client.once('disconnected', (reason) => {
        rejectOnce(
          new Error(`WhatsApp client disconnected before group discovery completed: ${reason}`)
        );
      });

      client.initialize().catch(rejectOnce);
    });

    printGroupCandidates(output, groups);
    output.write('\nCopy the correct GROUP_ID into .env, then run npm run doctor.\n');
  } catch (error) {
    log('ERROR', 'Failed to discover WhatsApp groups.', errorMetadata(error));
    process.exitCode = 1;
  } finally {
    try {
      await client.destroy();
    } catch (error) {
      log('ERROR', 'Failed to close WhatsApp client after group discovery.', errorMetadata(error));
      process.exitCode = 1;
    }
  }
}

if (require.main === module) {
  runGroupDiscovery();
}

module.exports = {
  collectGroupCandidates,
  getChatLabel,
  isGroupChat,
  printGroupCandidates,
  runGroupDiscovery,
  serializeChatId
};
