import { existsSync, rmSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import qrTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import { config, shouldProcess } from './config.js';
import { ensureTokens, submitTeaching } from './promptql-client.js';
import { handleMessage, pendingLearnings } from './message-handler.js';
import { sessions } from './session-store.js';
import { startAdminServer, updateState, logActivity, registerGroupsFetcher } from './admin-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Clear stale WhatsApp cache on every startup to prevent stuck syncs
const cacheDir = join(projectRoot, '.wwebjs_cache');
if (existsSync(cacheDir)) {
  console.log('[bridge] Clearing stale WhatsApp cache...');
  rmSync(cacheDir, { recursive: true, force: true });
}

// Clear stale Chrome lock files (prevents "profile in use" after unclean kill)
const lockFile = join(projectRoot, '.wwebjs_auth', 'session', 'SingletonLock');
if (existsSync(lockFile)) {
  console.log('[bridge] Clearing stale Chrome lock file...');
  try { unlinkSync(lockFile); } catch {}
}

// Start admin UI (localhost only, access remotely via SSH tunnel)
startAdminServer();

// If no PAT configured, keep the admin server running for setup
if (!config.pat) {
  console.log('[bridge] No PAT configured — open http://localhost:3099 to set up');
  updateState({ status: 'setup', needsSetup: true });
}

if (config.who === 'me' && !config.myNumber) {
  console.warn('[warn] WHO=me but MY_NUMBER is not set. Only fromMe messages will work.');
}

console.log(`[bridge] Starting PontQL`);
console.log(`[bridge] Listen: DM=${config.listenDm}, Groups=${config.listenGroups.length ? config.listenGroups.join(',') : 'none'}`);
console.log(`[bridge] Who: ${config.who}${config.who === 'contacts' ? ' (' + config.allowedContacts.join(',') + ')' : ''}`);
if (config.wakeWord) console.log(`[bridge] Wake word: "${config.wakeWord}"`);
if (config.debug) console.log(`[bridge] Debug mode: ON`);

// Find system Chrome
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];
const chromePath = process.env.CHROME_PATH || CHROME_PATHS.find(p => existsSync(p));
if (!chromePath) {
  console.error('Chrome/Chromium not found. Install it or set CHROME_PATH env var.');
  process.exit(1);
}
console.log(`[bridge] Using Chrome: ${chromePath}`);

const client = new Client({
  authStrategy: new LocalAuth(),
  takeoverOnConflict: true, // Auto-recover from multi-device conflicts
  puppeteer: {
    headless: 'new',
    executablePath: chromePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',        // Prevents /dev/shm OOM crashes on Linux
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
    ],
  },
});

// Track message IDs we've sent so we don't process our own bot replies
const sentByBot = new Set();

// --- Resilience: restart on fatal errors ---
function triggerRestart(reason) {
  console.error(`[bridge] RESTARTING: ${reason}`);
  logActivity('error', `Restarting: ${reason}`);
  updateState({ status: 'restarting' });
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (readyTimeout) clearTimeout(readyTimeout);
  process.exit(1); // pm2 restarts us
}

// Heartbeat — proactively detect zombie state every 2 minutes
let heartbeatInterval = null;
function startHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(async () => {
    try {
      const state = await client.getState();
      if (state !== 'CONNECTED') {
        console.error('[heartbeat] Client state:', state);
        updateState({ status: 'unhealthy: ' + state });
      }
    } catch (err) {
      console.error('[heartbeat] Health check failed:', err?.message);
      updateState({ status: 'dead' });
      triggerRestart('Heartbeat failed: ' + (err?.message || 'unknown'));
    }
  }, 2 * 60 * 1000);
}

// Send failure tracking — restart on first context-death error
function checkZombie(err) {
  const msg = err?.message || '';
  if (msg.includes('detached') || msg.includes('Execution context was destroyed') ||
      msg.includes('Session closed') || msg.includes('Target closed') ||
      msg.includes('Protocol error')) {
    triggerRestart('Send failed: ' + msg);
  }
}

// QR code
client.on('qr', async (qr) => {
  console.log('\n[bridge] Scan QR code at http://localhost:3099\n');
  qrTerminal.generate(qr, { small: true });
  try {
    const qrDataUrl = await QRCode.toDataURL(qr, { width: 400, margin: 2 });
    updateState({ qrDataUrl, status: 'qr' });
  } catch {}
});

// Auth timeout — if ready doesn't fire within 3 min, restart
let readyTimeout = null;
client.on('authenticated', () => {
  console.log('[bridge] WhatsApp authenticated');
  updateState({ qrDataUrl: null, status: 'authenticating' });
  // Clear any existing timeout before setting a new one (event can fire multiple times)
  if (readyTimeout) clearTimeout(readyTimeout);
  readyTimeout = setTimeout(() => {
    triggerRestart('Stuck on authenticating for 3 minutes');
  }, 3 * 60 * 1000);
});

client.on('auth_failure', (msg) => {
  console.error('[bridge] WhatsApp auth failed:', msg);
  updateState({ status: 'auth failed' });
  triggerRestart('Auth failed: ' + msg);
});

client.on('ready', async () => {
  console.log('[bridge] WhatsApp client ready');
  if (readyTimeout) { clearTimeout(readyTimeout); readyTimeout = null; }
  const info = client.info;
  updateState({ status: 'connecting to PromptQL', phone: info?.wid?.user || config.myNumber });

  // Start heartbeat
  startHeartbeat();

  // Register groups fetcher for admin dashboard
  registerGroupsFetcher(async () => {
    const chats = await client.getChats();
    return chats
      .filter(c => c.isGroup)
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .map(c => ({ id: c.id._serialized, name: c.name, timestamp: c.timestamp || 0 }));
  });

  // Register page-level error handlers for early zombie detection
  try {
    if (client.pupPage) {
      client.pupPage.on('pageerror', (err) => {
        console.error('[page] Page error:', err?.message);
      });
      client.pupPage.on('error', (err) => {
        triggerRestart('Page crashed: ' + (err?.message || 'unknown'));
      });
      client.pupPage.on('close', () => {
        triggerRestart('Page closed unexpectedly');
      });
    }
  } catch {}

  try {
    const cache = await ensureTokens();
    console.log(`[bridge] PromptQL connected: project=${cache.projectName}, room=${config.roomName}`);
    console.log('[bridge] Ready! Send a message to get started.');
    updateState({ status: 'ready', project: cache.projectName, room: config.roomName });
    logActivity('status', 'Bridge ready');
  } catch (err) {
    console.error('[bridge] Failed to connect to PromptQL:', err.message);
    updateState({ status: 'ready (PromptQL pending)', project: 'retry on first message' });
  }
});

// Helper to create reply/sendMedia/replySave functions for a given chatId
function makeHelpers(chatId) {
  const reply = async (text) => {
    try {
      const sent = await client.sendMessage(chatId, text);
      if (sent?.id?._serialized) sentByBot.add(sent.id._serialized);
    } catch (err) {
      console.error('[reply] Failed to send:', err.message);
      checkZombie(err);
    }
  };

  const replySave = async (text) => {
    try {
      const sent = await client.sendMessage(chatId, text);
      if (sent?.id?._serialized) sentByBot.add(sent.id._serialized);
      return sent;
    } catch (err) {
      console.error('[reply] Failed to send:', err.message);
      checkZombie(err);
      return null;
    }
  };

  const sendMedia = async (buffer, options = {}) => {
    try {
      const media = new MessageMedia(
        options.mimetype || 'application/octet-stream',
        buffer.toString('base64'),
        options.filename || 'file'
      );
      const sent = await client.sendMessage(chatId, media, {
        caption: options.caption || '',
      });
      if (sent?.id?._serialized) sentByBot.add(sent.id._serialized);
    } catch (err) {
      console.error('[media] Failed to send:', err.message);
      checkZombie(err);
    }
  };

  return { reply, sendMedia, replySave };
}

async function processMessage(msg, source) {
  try {
    // Skip status updates
    if (msg.isStatus) return;

    // Allow messages with media even if body is empty (use caption or default description)
    const hasMedia = msg.hasMedia;
    if (!msg.body && !hasMedia) return;

    // Skip messages we sent as bot replies
    if (msg.id?._serialized && sentByBot.has(msg.id._serialized)) {
      sentByBot.delete(msg.id._serialized);
      return;
    }

    // Access control check (pass dynamic group subscriptions)
    const subscribedGroupIds = sessions.getSubscribedGroupIds();
    const check = shouldProcess(msg, subscribedGroupIds);
    if (!check.allowed) return;

    // Group name check if needed (static LISTEN_GROUPS config)
    if (check.needsGroupCheck) {
      try {
        const chat = await msg.getChat();
        if (!chat.isGroup) return;
        const groupName = chat.name.toLowerCase();
        const inScope = config.listenGroups.some(g =>
          groupName.includes(g.toLowerCase())
        );
        if (!inScope) return;
      } catch {
        return;
      }
    }

    // For media-only messages (no text), use a default body
    const body = check.strippedBody || (hasMedia ? '[Sent an image]' : '');
    if (!body) return;

    // For self-sent messages, reply to the chat we sent to (not our own number)
    const chatId = source === 'self' ? msg.to : msg.from;

    // Download media if present
    let media = null;
    if (hasMedia) {
      try {
        const attachment = await msg.downloadMedia();
        if (attachment) {
          const ext = (attachment.mimetype || '').split('/')[1]?.split(';')[0] || 'bin';
          media = {
            data: Buffer.from(attachment.data, 'base64'),
            mimetype: attachment.mimetype || 'application/octet-stream',
            filename: attachment.filename || `upload_${Date.now()}.${ext}`,
          };
          console.log(`[${source}] ${chatId}: media ${media.mimetype} (${media.data.length} bytes)`);
          logActivity('media', `${media.mimetype} ${media.filename} (${media.data.length} bytes)`);
        }
      } catch (err) {
        console.error(`[${source}] Failed to download media:`, err.message);
        logActivity('error', `media download: ${err.message}`);
      }
    }

    console.log(`[${source}] ${chatId}: ${body.slice(0, 80)}${body.length > 80 ? '...' : ''}${media ? ' [+media]' : ''}`);
    logActivity('msg', `[${source}] ${body.slice(0, 60)}`);

    const { reply, sendMedia, replySave } = makeHelpers(chatId);
    await handleMessage(chatId, body, reply, sendMedia, replySave, media);
  } catch (err) {
    console.error(`[${source}] Unhandled error:`, err.message);
    logActivity('error', err.message);
  }
}

// Handle incoming messages from others
client.on('message', (msg) => processMessage(msg, 'in'));

// Handle messages sent by self (e.g., "Note to Self" chat)
client.on('message_create', (msg) => {
  if (!msg.fromMe) return;
  processMessage(msg, 'self');
});

// Handle poll votes for wiki learning approvals
client.on('vote_update', async (vote) => {
  try {
    const pollId = vote.parentMessage?.id?._serialized;
    if (!pollId) return;

    const pending = pendingLearnings.get(pollId);
    if (!pending) return;

    pendingLearnings.delete(pollId);

    const selected = vote.selectedOptions?.map(o => o.name) || [];
    const { reply } = makeHelpers(pending.chatId);

    if (selected.includes('Yes, add it')) {
      try {
        await submitTeaching(pending.threadId, pending.agentMessageId, pending.text);
        await reply('Learning added to wiki.');
        logActivity('learning', 'Accepted and submitted');
      } catch (err) {
        console.error('[vote] Failed to submit teaching:', err.message);
        await reply('Failed to submit learning: ' + err.message);
      }
    } else if (selected.includes('No, skip it')) {
      await reply('Learning skipped.');
      logActivity('learning', 'Skipped by user');
    }
  } catch (err) {
    console.error('[vote] Error handling poll vote:', err.message);
  }
});

client.on('disconnected', (reason) => {
  console.log('[bridge] WhatsApp disconnected:', reason);
  updateState({ status: 'disconnected', qrDataUrl: null });
  logActivity('status', 'Disconnected: ' + reason);
  triggerRestart('Disconnected: ' + reason);
});

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('[bridge] Uncaught exception:', err.message);
  logActivity('error', 'Uncaught: ' + err.message);
});

process.on('unhandledRejection', (err) => {
  const msg = err?.message || String(err);
  console.error('[bridge] Unhandled rejection:', msg);
  logActivity('error', 'Rejection: ' + msg);
  // If it's a Puppeteer context error, restart immediately
  if (msg.includes('Execution context was destroyed') || msg.includes('detached') ||
      msg.includes('Session closed') || msg.includes('Target closed') ||
      msg.includes('Protocol error')) {
    triggerRestart('Unhandled rejection: ' + msg);
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[bridge] Shutting down...');
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  await client.destroy();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  await client.destroy();
  process.exit(0);
});

// Start — only initialize WhatsApp if PAT is configured
if (config.pat) {
  client.initialize();
} else {
  console.log('[bridge] Waiting for setup at http://localhost:3099 ...');
}
