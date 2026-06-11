// Direct test — dump ALL raw events to understand structure
import { ensureTokens, startThread, pollThreadEvents } from './src/promptql-client.js';

const PROMPT = 'can you get me my schedule for the next 3 days. render as a calendar too';

async function test() {
  console.log('--- Connecting to PromptQL ---');
  const cache = await ensureTokens();
  console.log(`Project: ${cache.projectName}\n`);

  console.log(`--- Starting thread: "${PROMPT}" ---`);
  const result = await startThread(PROMPT);
  const threadId = result.thread_id;
  console.log(`Thread: ${threadId}\n`);

  let lastEventId = '0';
  let done = false;
  let pollCount = 0;
  const allEvents = [];

  while (!done && pollCount < 120) {
    await new Promise(r => setTimeout(r, 2000));
    pollCount++;

    try {
      const events = await pollThreadEvents(threadId, lastEventId);
      if (events.length === 0) continue;

      for (const event of events) {
        lastEventId = String(event.thread_event_id);
        allEvents.push(event);
        const data = event.event_data;

        // Identify event type
        if (data.UserMessage) {
          console.log(`\n=== EVENT ${event.thread_event_id}: UserMessage ===`);
          console.log(`  message: "${data.UserMessage.message?.slice(0, 100)}"`);
          continue;
        }

        const agentMsg = data.AgentMessage;
        if (!agentMsg?.update?.content) {
          console.log(`\n=== EVENT ${event.thread_event_id}: Unknown ===`);
          console.log(JSON.stringify(data, null, 2).slice(0, 300));
          continue;
        }

        const content = agentMsg.update.content;

        // Top-level signals
        if (content.interaction_started) {
          console.log(`\n=== EVENT ${event.thread_event_id}: interaction_started ===`);
          console.log(JSON.stringify(content.interaction_started, null, 2).slice(0, 300));
          continue;
        }

        if (content.interaction_finished) {
          console.log(`\n=== EVENT ${event.thread_event_id}: interaction_finished ===`);
          console.log(JSON.stringify(content.interaction_finished, null, 2).slice(0, 500));
          done = true;
          continue;
        }

        const update = content.interaction_update;
        if (!update) {
          console.log(`\n=== EVENT ${event.thread_event_id}: content (no interaction_update) ===`);
          console.log(JSON.stringify(content, null, 2).slice(0, 300));
          continue;
        }

        // Wiki selection
        if (update.wiki_selection) {
          console.log(`\n=== EVENT ${event.thread_event_id}: wiki_selection ===`);
          console.log(JSON.stringify(update.wiki_selection, null, 2).slice(0, 800));
          continue;
        }

        // Decision
        if (update.interaction_decision) {
          console.log(`\n=== EVENT ${event.thread_event_id}: interaction_decision ===`);
          console.log(JSON.stringify(update.interaction_decision, null, 2).slice(0, 300));
          continue;
        }

        // Wiki learning
        if (update.wiki_learning_suggestion) {
          console.log(`\n=== EVENT ${event.thread_event_id}: wiki_learning_suggestion ===`);
          console.log(JSON.stringify(update.wiki_learning_suggestion, null, 2).slice(0, 500));
          continue;
        }

        // Main agent
        const agent = update.main_agent;
        if (!agent) {
          console.log(`\n=== EVENT ${event.thread_event_id}: interaction_update (no main_agent) ===`);
          console.log(JSON.stringify(update, null, 2).slice(0, 300));
          continue;
        }

        // Identify which main_agent sub-event
        const subType = agent.started !== undefined ? 'started'
          : agent.turn_started ? 'turn_started'
          : agent.llm_response ? 'llm_response'
          : agent.actions_parsed ? 'actions_parsed'
          : agent.action_started ? 'action_started'
          : agent.action_progress ? 'action_progress'
          : agent.action_completed ? 'action_completed'
          : agent.turn_completed ? 'turn_completed'
          : agent.completed !== undefined ? 'completed'
          : 'unknown';

        console.log(`\n=== EVENT ${event.thread_event_id}: main_agent.${subType} ===`);

        switch (subType) {
          case 'started':
          case 'turn_started':
          case 'turn_completed':
          case 'completed':
            console.log(JSON.stringify(agent[subType] ?? {}, null, 2).slice(0, 300));
            break;

          case 'llm_response':
            console.log(`  response_text: "${(agent.llm_response.response_text || '').slice(0, 200)}..."`);
            break;

          case 'actions_parsed':
            for (const action of agent.actions_parsed.actions || []) {
              const actionType = Object.keys(action)[0];
              console.log(`  action: ${actionType}`);
              if (action.final_response) {
                console.log(`    message: "${action.final_response.message?.slice(0, 200)}..."`);
              } else if (action.responding_to_user) {
                console.log(`    message: "${action.responding_to_user.message?.slice(0, 200)}..."`);
              } else if (action.run_program) {
                console.log(`    code: "${(action.run_program.code || action.run_program.program || '').slice(0, 150)}..."`);
              } else {
                console.log(`    ${JSON.stringify(action[actionType], null, 2).slice(0, 200)}`);
              }
            }
            break;

          case 'action_started':
            console.log(JSON.stringify(agent.action_started, null, 2).slice(0, 400));
            break;

          case 'action_progress': {
            const progress = agent.action_progress.update;
            if (!progress) {
              console.log('  (no update)');
              break;
            }
            // Show artifact updates in detail
            const runEvt = progress.program_run_event || progress.ProgramRunEvent || progress;
            if (runEvt.DataArtifactUpdated || runEvt.type === 'DataArtifactUpdated') {
              const art = runEvt.DataArtifactUpdated || runEvt;
              console.log(`  ARTIFACT: ${art.artifact_type} "${art.title || art.identifier}"`);
              console.log(`    identifier: ${art.identifier || art.artifact_identifier}`);
              console.log(`    has data: ${art.data != null}`);
              console.log(`    has artifact_reference: ${art.artifact_reference != null}`);
              if (art.artifact_reference) {
                console.log(`    artifact_reference: ${JSON.stringify(art.artifact_reference)}`);
              }
              if (art.data) {
                const dataStr = JSON.stringify(art.data);
                console.log(`    data preview (${dataStr.length} chars): ${dataStr.slice(0, 300)}`);
              }
            } else if (runEvt.OutputEmitted || runEvt.type === 'OutputEmitted') {
              const output = runEvt.OutputEmitted || runEvt;
              console.log(`  OUTPUT: "${(output.output || output.data || '').slice(0, 200)}"`);
            } else if (progress.artifact_modified) {
              console.log(`  ARTIFACT_MODIFIED: ${JSON.stringify(progress.artifact_modified, null, 2).slice(0, 400)}`);
            } else {
              console.log(`  ${JSON.stringify(progress, null, 2).slice(0, 400)}`);
            }
            break;
          }

          case 'action_completed':
            console.log(`  result_type: ${agent.action_completed.result?.agent_loop_action_result_type}`);
            console.log(`  ${JSON.stringify(agent.action_completed.result || {}, null, 2).slice(0, 400)}`);
            break;

          default:
            console.log(JSON.stringify(agent, null, 2).slice(0, 400));
        }
      }
    } catch (err) {
      console.error('Poll error:', err.message);
    }
  }

  console.log(`\n\n--- SUMMARY ---`);
  console.log(`Total events: ${allEvents.length}`);
  console.log(`Polls: ${pollCount}`);
  console.log(`Done: ${done}`);
}

test().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
