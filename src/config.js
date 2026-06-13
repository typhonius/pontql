import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');

// Load .env
if (existsSync(envPath)) {
  readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
  });
}

function csvList(val) {
  return (val || '').split(',').map(s => s.trim()).filter(Boolean);
}

export const config = {
  // PromptQL
  pat: process.env.PROMPTQL_PAT || process.env.PERSONAL_PAT,
  projectName: process.env.PROMPTQL_PROJECT || null,
  roomName: process.env.PROMPTQL_ROOM || 'whatsapp',
  controlPlaneAuth: process.env.CONTROL_PLANE_AUTH || 'https://auth.pro.hasura.io',
  controlPlaneData: process.env.CONTROL_PLANE_DATA || 'https://data.pro.hasura.io/v1/graphql',
  playgroundHost: process.env.PROMPTQL_PLAYGROUND_HOST || 'https://playground.promptql.pro.hasura.io',

  // Access control — three independent axes
  // WHERE: where does it listen?
  listenDm: process.env.LISTEN_DM !== 'false',           // default true
  listenGroups: csvList(process.env.LISTEN_GROUPS),       // empty = no groups, ["*"] = all
  // WHO: who can trigger it?
  who: process.env.WHO || 'me',                           // "me" | "contacts" | "anyone"
  myNumber: process.env.MY_NUMBER || '',
  allowedContacts: csvList(process.env.ALLOWED_CONTACTS),
  // TRIGGER: require wake word?
  wakeWord: (process.env.WAKE_WORD || '').toLowerCase(),  // empty = no wake word

  // Session
  sessionTimeoutMinutes: parseInt(process.env.SESSION_TIMEOUT || '10', 10),

  // Debug
  debug: process.env.DEBUG === 'true' || process.env.DEBUG === '1',
};

/**
 * Check if an incoming message should be processed.
 *
 * Three independent checks, all must pass:
 *   1. WHERE — is this chat/group in scope?
 *   2. WHO   — is this person allowed?
 *   3. WAKE  — does it start with the wake word (if required)?
 *
 * Returns { allowed, strippedBody?, needsGroupCheck? }
 */
export function shouldProcess(msg, subscribedGroupIds = null) {
  const { listenDm, listenGroups, who, myNumber, allowedContacts, wakeWord } = config;
  const isGroup = msg.from.endsWith('@g.us');
  const senderNumber = msg.author || msg.from.replace('@c.us', '');
  const isSelf = (myNumber && senderNumber.includes(myNumber)) || msg.fromMe;
  let body = msg.body?.trim();
  if (!body) return { allowed: false };

  // ── 1. WHERE ──
  if (isGroup) {
    const isDynamicSub = subscribedGroupIds?.has(msg.from);
    if (listenGroups.length === 0 && !isDynamicSub) return { allowed: false };
    // If dynamically subscribed, skip the group name check
    // If not wildcard and not dynamic, we need to check group name later
    const needsGroupCheck = !isDynamicSub && !listenGroups.includes('*');
    if (needsGroupCheck) {
      // Pass through — will be verified against group name in index.js
    }
  } else {
    // DM
    if (!listenDm) return { allowed: false };
  }

  // ── 2. WHO ──
  if (who === 'me') {
    if (!isSelf) return { allowed: false };
  } else if (who === 'contacts') {
    const isAllowed = isSelf || allowedContacts.some(n => senderNumber.includes(n));
    if (!isAllowed) return { allowed: false };
  }
  // who === 'anyone' → no identity check

  // ── 3. WAKE WORD ──
  if (wakeWord) {
    const lower = body.toLowerCase();
    if (!lower.startsWith(wakeWord)) return { allowed: false };
    body = body.slice(wakeWord.length).trim();
    if (!body) return { allowed: false }; // wake word alone, no actual message
  }

  return {
    allowed: true,
    strippedBody: body,
    needsGroupCheck: isGroup && listenGroups.length > 0 && !listenGroups.includes('*'),
  };
}
