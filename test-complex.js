// Test with a complex prompt that should generate artifacts
import { ensureTokens, startThread, pollThreadEvents } from './src/promptql-client.js';
import { parseEvent } from './src/event-parser.js';

async function test() {
  console.log('--- Connecting ---');
  await ensureTokens();

  console.log('--- Starting thread ---');
  const result = await startThread('Show me a summary of what data you have access to. If you can, create a simple chart or table showing something interesting.');
  const threadId = result.thread_id;
  console.log(`Thread: ${threadId}`);

  let lastEventId = '0';
  let done = false;
  let pollCount = 0;
  const allText = [];
  const allArtifacts = [];
  const statuses = [];

  while (!done && pollCount < 90) {
    await new Promise(r => setTimeout(r, 2000));
    pollCount++;

    const events = await pollThreadEvents(threadId, lastEventId);
    if (events.length > 0) {
      console.log(`\n[poll #${pollCount}] ${events.length} events`);
    }

    for (const event of events) {
      lastEventId = String(event.thread_event_id);
      const parsed = parseEvent(event);

      for (const item of parsed) {
        switch (item.type) {
          case 'text':
            if (!allText.includes(item.text)) {
              console.log(`  TEXT: "${item.text.slice(0, 100)}${item.text.length > 100 ? '...' : ''}"`);
              allText.push(item.text);
            }
            break;
          case 'artifact':
            console.log(`  ARTIFACT: ${item.artifact.artifact_type} "${item.artifact.title}" ref=${JSON.stringify(item.artifact.artifact_reference)?.slice(0,80)}`);
            allArtifacts.push(item.artifact);
            break;
          case 'status':
            if (!statuses.includes(item.status)) {
              console.log(`  STATUS: ${item.status}`);
              statuses.push(item.status);
            }
            break;
          case 'done':
            console.log(`  DONE${item.summary ? ': ' + item.summary.slice(0,80) : ''}`);
            done = true;
            break;
        }
      }
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Polls: ${pollCount}`);
  console.log(`Text parts: ${allText.length}`);
  console.log(`Artifacts: ${allArtifacts.length}`);
  allArtifacts.forEach(a => console.log(`  - ${a.artifact_type}: ${a.title}`));
  console.log(`Statuses seen: ${statuses.join(' → ')}`);
}

test().catch(err => { console.error('Fatal:', err); process.exit(1); });
