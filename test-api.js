// Direct test of PromptQL API - no WhatsApp needed
import { ensureTokens, startThread, pollThreadEvents } from './src/promptql-client.js';
import { parseEvent } from './src/event-parser.js';

async function test() {
  console.log('--- Connecting to PromptQL ---');
  const cache = await ensureTokens();
  console.log(`Project: ${cache.projectName}`);
  console.log(`Room: whatsapp`);
  console.log();

  console.log('--- Starting thread with "hello, this is a test" ---');
  const result = await startThread('hello, this is a test');
  const threadId = result.thread_id;
  console.log(`Thread: ${threadId}`);
  console.log(`Title: ${result.title}`);
  console.log(`Initial events: ${result.thread_events?.length || 0}`);
  console.log();

  // Show initial events if any
  if (result.thread_events?.length) {
    for (const evt of result.thread_events) {
      console.log('--- Initial event ---');
      console.log(JSON.stringify(evt.event_data, null, 2).slice(0, 500));
      const parsed = parseEvent(evt);
      console.log('Parsed:', parsed);
      console.log();
    }
  }

  // Poll for response
  let lastEventId = '0';
  let done = false;
  let pollCount = 0;

  while (!done && pollCount < 60) {
    await new Promise(r => setTimeout(r, 2000));
    pollCount++;

    console.log(`--- Poll #${pollCount} (after eventId=${lastEventId}) ---`);
    try {
      const events = await pollThreadEvents(threadId, lastEventId);
      console.log(`Got ${events.length} events`);

      for (const event of events) {
        lastEventId = String(event.thread_event_id);

        // Show raw event structure
        const data = event.event_data;
        const preview = JSON.stringify(data, null, 2);
        console.log(`\nEvent ${event.thread_event_id}:`);
        console.log(preview.slice(0, 800));
        if (preview.length > 800) console.log('  ... (truncated)');

        // Parse it
        const parsed = parseEvent(event);
        console.log('Parsed items:', parsed.map(p => `${p.type}${p.text ? ': "' + p.text.slice(0,60) + '"' : ''}`));

        // Check for done
        if (parsed.some(p => p.type === 'done')) {
          done = true;
        }
      }

      if (events.length === 0) {
        console.log('(no new events)');
      }
    } catch (err) {
      console.error('Poll error:', err.message);
    }
  }

  console.log('\n--- Done ---');
  console.log(`Finished after ${pollCount} polls, done=${done}`);
}

test().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
