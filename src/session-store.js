import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const db = new Database(join(dataDir, 'sessions.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    chat_id TEXT PRIMARY KEY,
    thread_id TEXT,
    thread_title TEXT,
    room_name TEXT,
    last_activity TEXT DEFAULT (datetime('now')),
    last_agent_message_id TEXT,
    last_event_id TEXT DEFAULT '0'
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS thread_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    thread_title TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

const upsertSession = db.prepare(`
  INSERT INTO sessions (chat_id, thread_id, thread_title, room_name, last_activity, last_event_id)
  VALUES (?, ?, ?, ?, datetime('now'), '0')
  ON CONFLICT(chat_id) DO UPDATE SET
    thread_id = excluded.thread_id,
    thread_title = excluded.thread_title,
    last_activity = datetime('now'),
    last_event_id = '0'
`);

const getSession = db.prepare('SELECT * FROM sessions WHERE chat_id = ?');
const touchSession = db.prepare("UPDATE sessions SET last_activity = datetime('now') WHERE chat_id = ?");
const updateLastEventId = db.prepare('UPDATE sessions SET last_event_id = ? WHERE chat_id = ?');
const updateAgentMessageId = db.prepare('UPDATE sessions SET last_agent_message_id = ? WHERE chat_id = ?');
const updateThreadTitle = db.prepare('UPDATE sessions SET thread_title = ? WHERE chat_id = ?');
const clearThread = db.prepare('UPDATE sessions SET thread_id = NULL, thread_title = NULL, last_event_id = \'0\' WHERE chat_id = ?');

const insertHistory = db.prepare(
  'INSERT INTO thread_history (chat_id, thread_id, thread_title) VALUES (?, ?, ?)'
);
const getHistory = db.prepare(
  'SELECT * FROM thread_history WHERE chat_id = ? ORDER BY id DESC LIMIT ?'
);

export const sessions = {
  /**
   * Get or create a session for a chat. Returns null thread_id if session
   * has expired (idle too long).
   */
  get(chatId) {
    const row = getSession.get(chatId);
    if (!row) return null;

    // Check if session has expired
    if (row.thread_id) {
      const lastActivity = new Date(row.last_activity + 'Z');
      const elapsed = (Date.now() - lastActivity.getTime()) / 1000 / 60;
      if (elapsed > config.sessionTimeoutMinutes) {
        // Session expired - archive thread and clear
        insertHistory.run(chatId, row.thread_id, row.thread_title);
        clearThread.run(chatId);
        return { ...row, thread_id: null, thread_title: null };
      }
    }

    return row;
  },

  /**
   * Set the active thread for a chat.
   */
  setThread(chatId, threadId, title, roomName) {
    // Archive previous thread if exists
    const existing = getSession.get(chatId);
    if (existing?.thread_id && existing.thread_id !== threadId) {
      insertHistory.run(chatId, existing.thread_id, existing.thread_title);
    }
    upsertSession.run(chatId, threadId, title, roomName || config.roomName);
  },

  /**
   * Touch the session to keep it alive.
   */
  touch(chatId) {
    touchSession.run(chatId);
  },

  /**
   * Update the last event ID we've processed for this chat.
   */
  setLastEventId(chatId, eventId) {
    updateLastEventId.run(eventId, chatId);
  },

  /**
   * Store the last agent message ID (needed for /teach).
   */
  setAgentMessageId(chatId, messageId) {
    updateAgentMessageId.run(messageId, chatId);
  },

  /**
   * Update thread title.
   */
  setTitle(chatId, title) {
    updateThreadTitle.run(title, chatId);
  },

  /**
   * Clear the active thread (for /new).
   */
  clearThread(chatId) {
    const existing = getSession.get(chatId);
    if (existing?.thread_id) {
      insertHistory.run(chatId, existing.thread_id, existing.thread_title);
    }
    clearThread.run(chatId);
  },

  /**
   * Get recent thread history for a chat.
   */
  history(chatId, limit = 10) {
    return getHistory.all(chatId, limit);
  },
};
