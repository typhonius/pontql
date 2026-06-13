import {
  startThread,
  sendMessage,
  streamThreadEvents,
  pollThreadEvents,
  listRooms,
  switchRoom,
  listThreads,
  switchProject,
  listProjects,
  submitTeaching,
  getCache,
} from './promptql-client.js';
import { sessions } from './session-store.js';
import { parseEvent } from './event-parser.js';
import { artifactToWhatsApp, setCurrentThread } from './artifact-handler.js';
import { trackStat, logActivity } from './admin-server.js';
import pkg from 'whatsapp-web.js';
const { Poll } = pkg;

// Track active SSE streams so we don't double-subscribe
const activeStreams = new Map(); // threadId → abort function

// Pending learning approvals: pollMsgSerializedId → { chatId, text, threadId, agentMessageId }
export const pendingLearnings = new Map();

/**
 * Handle an incoming message from WhatsApp.
 * @param {string} chatId - The WhatsApp chat ID
 * @param {string} body - The message text
 * @param {function} reply - Async function to send text back (fire and forget)
 * @param {function} sendMedia - Async function to send media (buffer, options)
 * @param {function} replySave - Async function to send text and return the message object (for editing)
 */
export async function handleMessage(chatId, body, reply, sendMedia, replySave) {
  if (!body || !body.trim()) return;
  const text = body.trim();

  // Check for commands
  if (text.startsWith('/')) {
    return handleCommand(chatId, text, reply, sendMedia);
  }

  // Regular message → send to PromptQL
  try {
    const session = sessions.get(chatId);
    let threadId = session?.thread_id;

    if (threadId) {
      sessions.touch(chatId);
      trackStat('messagesSent');
      logActivity('msg', `→ ${text.slice(0, 80)}`);
      const statusMsg = await replySave('_thinking..._');
      const result = await sendMessage(threadId, text);
      logActivity('api', `send_thread_message → ${threadId.slice(0, 8)}`);
      await waitForResponse(chatId, threadId, reply, sendMedia, replySave, statusMsg);
    } else {
      trackStat('messagesSent');
      trackStat('threadsCreated');
      logActivity('msg', `→ [new] ${text.slice(0, 80)}`);
      const statusMsg = await replySave('_thinking..._');
      const result = await startThread(text);
      threadId = result.thread_id;
      logActivity('api', `start_thread → ${threadId.slice(0, 8)} "${result.title || ''}"`);
      sessions.setThread(chatId, threadId, result.title);
      await waitForResponse(chatId, threadId, reply, sendMedia, replySave, statusMsg);
    }
  } catch (err) {
    console.error('[handler] Error:', err.message);
    await reply(`Something went wrong: ${err.message}`);
  }
}

async function handleCommand(chatId, text, reply, sendMedia) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  switch (cmd) {
    case '/new':
      sessions.clearThread(chatId);
      await reply('Thread cleared. Your next message will start a new conversation.');
      break;

    case '/threads': {
      try {
        const threads = await listThreads();
        if (threads.length === 0) {
          await reply('No recent threads found.');
          return;
        }
        let msg = '*Recent threads:*\n\n';
        threads.forEach((t, i) => {
          const title = t.custom_title || t.title || '(untitled)';
          const date = new Date(t.updated_at).toLocaleDateString();
          msg += `${i + 1}. ${title} _(${date})_\n`;
        });
        msg += '\nUse /resume <number> to continue a thread.';
        await reply(msg);
      } catch (err) {
        await reply('Failed to list threads: ' + err.message);
      }
      break;
    }

    case '/resume': {
      const num = parseInt(args, 10);
      if (!num || num < 1) {
        await reply('Usage: /resume <number>\nUse /threads to see available threads.');
        return;
      }
      try {
        const threads = await listThreads();
        if (num > threads.length) {
          await reply(`Only ${threads.length} threads available.`);
          return;
        }
        const thread = threads[num - 1];
        sessions.setThread(chatId, thread.thread_id, thread.custom_title || thread.title);
        await reply(`Resumed: *${thread.custom_title || thread.title || '(untitled)'}*\nSend a message to continue.`);
      } catch (err) {
        await reply('Failed to resume thread: ' + err.message);
      }
      break;
    }

    case '/rooms': {
      try {
        const rooms = await listRooms();
        if (rooms.length === 0) {
          await reply('No rooms found.');
          return;
        }
        let msg = '*Available rooms:*\n\n';
        rooms.forEach(r => {
          msg += `• *${r.name}*${r.description ? ` - ${r.description}` : ''}\n`;
        });
        msg += '\nUse /room <name> to switch.';
        await reply(msg);
      } catch (err) {
        await reply('Failed to list rooms: ' + err.message);
      }
      break;
    }

    case '/room': {
      if (!args) {
        const cache = getCache();
        await reply(`Current room: *${cache.roomName || 'default'}*\nUsage: /room <name>`);
        return;
      }
      try {
        const room = await switchRoom(args);
        if (!room) {
          await reply(`Room "${args}" not found. Use /rooms to see available rooms.`);
          return;
        }
        sessions.clearThread(chatId);
        await reply(`Switched to room *${room.name}*. Next message starts a new thread here.`);
      } catch (err) {
        await reply('Failed to switch room: ' + err.message);
      }
      break;
    }

    case '/teach': {
      if (!args) {
        await reply('Usage: /teach <knowledge to add>\nExample: /teach Our fiscal year starts in April');
        return;
      }
      const session = sessions.get(chatId);
      if (!session?.thread_id || !session?.last_agent_message_id) {
        await reply('Start a conversation first, then use /teach to add knowledge based on the discussion.');
        return;
      }
      try {
        await submitTeaching(session.thread_id, session.last_agent_message_id, args);
        await reply('Teaching submitted. PromptQL will use this knowledge going forward.');
      } catch (err) {
        await reply('Failed to submit teaching: ' + err.message);
      }
      break;
    }

    case '/project': {
      if (!args) {
        const cache = getCache();
        await reply(`Current project: *${cache.projectName || 'none'}*\nUsage: /project <name>`);
        return;
      }
      try {
        const result = await switchProject(args);
        if (!result) {
          const projects = await listProjects();
          const names = projects.map(p => `• ${p.name}`).join('\n');
          await reply(`Project "${args}" not found.\n\n*Available projects:*\n${names}`);
          return;
        }
        sessions.clearThread(chatId);
        await reply(`Switched to project *${result.name}*`);
      } catch (err) {
        await reply('Failed to switch project: ' + err.message);
      }
      break;
    }

    case '/projects': {
      try {
        const projects = await listProjects();
        const cache = getCache();
        let msg = '*Projects:*\n\n';
        projects.forEach(p => {
          const current = p.name === cache.projectName ? ' (current)' : '';
          msg += `• *${p.name}*${p.title ? ` - ${p.title}` : ''}${current}\n`;
        });
        msg += '\nUse /project <name> to switch.';
        await reply(msg);
      } catch (err) {
        await reply('Failed to list projects: ' + err.message);
      }
      break;
    }

    case '/status': {
      const session = sessions.get(chatId);
      const cache = getCache();
      let msg = '*Bridge Status*\n\n';
      msg += `Project: *${cache.projectName || 'none'}*\n`;
      msg += `Room: *${session?.room_name || cache.roomName || 'default'}*\n`;
      msg += `Active thread: ${session?.thread_id ? `*${session.thread_title || 'untitled'}*` : '_none_'}\n`;
      await reply(msg);
      break;
    }

    case '/help':
      await reply(
        '*WhatsApp PromptQL Bridge*\n\n' +
        'Just type a message to talk to PromptQL.\n\n' +
        '*Commands:*\n' +
        '• /new - Start a new thread\n' +
        '• /threads - List recent threads\n' +
        '• /resume <n> - Resume thread #n\n' +
        '• /rooms - List available rooms\n' +
        '• /room <name> - Switch to a room\n' +
        '• /teach <text> - Submit a wiki teaching\n' +
        '• /projects - List projects\n' +
        '• /project <name> - Switch project\n' +
        '• /status - Show current state\n' +
        '• /help - This message'
      );
      break;

    default:
      await reply(`Unknown command: ${cmd}\nType /help for available commands.`);
  }
}

/**
 * Stream PromptQL response to WhatsApp in real time.
 *
 * - Status updates ("thinking...", "running code...") → edit a single status message
 * - Intermediate text (responding_to_user) → send as new message immediately
 * - Final response → send as new message
 * - Artifacts → send as new messages (images, tables, etc)
 * - No batching — everything goes out as it arrives
 *
 * @param {object} statusMsg - The initial "_thinking..._" or "_starting new thread..._" message object
 */
async function waitForResponse(chatId, threadId, reply, sendMedia, replySave, statusMsg) {
  // Track thread for artifact handler
  setCurrentThread(threadId);

  // Abort any existing stream for this thread
  if (activeStreams.has(threadId)) {
    activeStreams.get(threadId)();
    activeStreams.delete(threadId);
  }

  let lastAgentMessageId = null;
  let isDone = false;
  let lastStatus = '';
  const sentTexts = new Set(); // Deduplicate

  // Resume from where we left off to avoid re-sending old messages
  const session = sessions.get(chatId);
  const storedEventId = session?.last_event_id || '0';

  return new Promise((resolve) => {
    let pollCount = 0;
    const maxPolls = 150; // ~3 minutes max
    let lastEventId = storedEventId;

    const editStatus = async (text) => {
      if (text === lastStatus) return;
      lastStatus = text;
      try {
        if (statusMsg?.edit) {
          await statusMsg.edit(`_${text}_`);
        }
      } catch {
        // Edit might fail on some WhatsApp versions — that's ok
      }
    };

    const poll = async () => {
      try {
        const events = await pollThreadEvents(threadId, lastEventId);
        if (events.length > 0) {
          logActivity('poll', `#${pollCount} got ${events.length} events`);
        }

        for (const event of events) {
          lastEventId = String(event.thread_event_id);
          sessions.setLastEventId(chatId, lastEventId);

          const parsed = parseEvent(event);
          for (const item of parsed) {
            switch (item.type) {
              case 'text':
                // Strip artifact reference tags (e.g. <artifact type="table" ... />)
                let cleanText = item.text.replace(/<artifact\b[^>]*\/>/gi, '').trim();
                // Convert wiki links [Title](<wiki://Page>) → just the title
                cleanText = cleanText.replace(/\[([^\]]+)\]\(<wiki(?:-promptql)?:\/\/[^>]+>\)/g, '$1');
                // Strip any leftover empty bullet lines after removal
                cleanText = cleanText.replace(/^\s*[•\-\*]\s*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
                if (!cleanText) break;
                // Send each text response immediately, deduplicated
                if (!sentTexts.has(cleanText)) {
                  sentTexts.add(cleanText);
                  trackStat('messagesReceived');
                  logActivity('reply', `← ${cleanText.slice(0, 80)}`);
                  // Clear the status message before sending real content
                  await editStatus('...');
                  const chunks = splitMessage(cleanText, 4000);
                  for (const chunk of chunks) {
                    await reply(chunk);
                  }
                }
                break;

              case 'artifact':
                trackStat('artifactsGenerated');
                logActivity('artifact', `${item.artifact.artifact_type}: ${item.artifact.title || item.artifact.identifier}`);
                // Send artifact immediately
                try {
                  const wa = await artifactToWhatsApp(item.artifact);
                  if (wa.type === 'text') {
                    await reply(wa.content);
                  } else if (wa.type === 'image') {
                    await sendMedia(wa.content, { mimetype: 'image/png', caption: wa.caption });
                  } else if (wa.type === 'document') {
                    await sendMedia(wa.content, { mimetype: 'application/octet-stream', filename: wa.filename, caption: wa.caption });
                  }
                } catch (err) {
                  console.error('[artifact] Error:', err.message);
                  await reply(`_[Artifact: ${item.artifact.title || 'unknown'}] (failed to render)_`);
                }
                break;

              case 'learning':
                // Send formatted learning text + approval poll
                if (!sentTexts.has('learning:' + item.text)) {
                  sentTexts.add('learning:' + item.text);
                  await editStatus('...');
                  await reply(`*Suggested learning:*\n\n${item.text}`);
                  const poll = new Poll(
                    'Add this to the wiki?',
                    ['Yes, add it', 'No, skip it'],
                  );
                  const pollMsg = await replySave(poll);
                  if (pollMsg?.id?._serialized) {
                    pendingLearnings.set(pollMsg.id._serialized, {
                      chatId,
                      text: item.text,
                      threadId,
                      agentMessageId: lastAgentMessageId,
                    });
                    logActivity('learning', `Poll sent for: ${item.text.slice(0, 60)}`);
                  }
                }
                break;

              case 'agent_message_id':
                lastAgentMessageId = item.id;
                break;

              case 'title':
                sessions.setTitle(chatId, item.title);
                break;

              case 'status':
                await editStatus(item.status + '...');
                break;

              case 'done':
                isDone = true;
                if (item.summary && sentTexts.size === 0) {
                  await reply(item.summary);
                }
                break;
            }
          }
        }

        if (isDone || pollCount >= maxPolls) {
          if (lastAgentMessageId) {
            sessions.setAgentMessageId(chatId, lastAgentMessageId);
          }
          // Clean up status message if no real content was sent
          if (sentTexts.size === 0 && !isDone) {
            await editStatus('timed out waiting for response');
          } else if (isDone) {
            // Delete or minimize the status message
            try { await statusMsg?.delete(true); } catch {}
          }
          resolve();
          return;
        }

        pollCount++;
        const delay = pollCount < 10 ? 1000 : pollCount < 30 ? 2000 : 3000;
        setTimeout(poll, delay);
      } catch (err) {
        console.error('[poll] Error:', err.message);
        logActivity('error', `poll: ${err.message}`);
        pollCount++;
        if (pollCount >= maxPolls) {
          if (sentTexts.size > 0) {
            resolve(); // We sent some content, just finish
          } else {
            await editStatus('error: ' + err.message);
            resolve();
          }
        } else {
          setTimeout(poll, 2000);
        }
      }
    };

    // Start polling after a brief delay
    setTimeout(poll, 1500);
  });
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}
