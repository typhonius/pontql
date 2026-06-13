/**
 * Parse PromptQL V3 thread events.
 *
 * Key learnings from raw event analysis:
 *
 * 1. Artifacts in action_progress (DataArtifactUpdated) have NO data and NO artifact_reference.
 *    The real artifact data comes in action_completed.result.modified_artifacts.
 *
 * 2. main_agent.completed is NOT a termination signal — the interaction continues
 *    (wiki learnings, etc). Only interaction_finished is the true done signal.
 *
 * 3. Wiki page reads appear as action_started.read_wiki_page — good for status.
 *
 * 4. HTTP calls appear in action_progress.program_run_event.HttpExecuteStarted.
 *
 * 5. responding_to_user messages are duplicated in action_completed (message_sent) —
 *    skip message_sent in action_completed to avoid dupes.
 *
 * 6. actions_parsing_failed can occur — just a status, not fatal.
 */

export function parseEvent(event) {
  const results = [];
  const data = event.event_data || event;

  // Skip user messages
  if (data.UserMessage) return results;

  // Extract agent message content
  const agentMsg = data.AgentMessage;
  if (!agentMsg?.update?.content) return results;

  const content = agentMsg.update.content;
  const messageId = agentMsg.message_id;

  if (messageId) {
    results.push({ type: 'agent_message_id', id: messageId });
  }

  // interaction_started
  if (content.interaction_started) {
    results.push({ type: 'status', status: 'thinking' });
  }

  // interaction_finished — the ONLY true done signal
  if (content.interaction_finished) {
    const outcome = content.interaction_finished.outcome;
    const summary = outcome?.completed?.summary;
    results.push({ type: 'done', summary: summary || null });
    return results;
  }

  // interaction_update
  const update = content.interaction_update;
  if (!update) return results;

  // Decision
  if (update.interaction_decision) {
    if (update.interaction_decision.DeclineInteraction) {
      results.push({ type: 'done', summary: 'Agent declined to respond.' });
    }
  }

  // Wiki selection — show which pages matched
  if (update.wiki_selection) {
    if (update.wiki_selection.started !== undefined) {
      results.push({ type: 'status', status: 'selecting context' });
    }
    if (update.wiki_selection.wiki_pages_selected) {
      const hits = update.wiki_selection.wiki_pages_selected.search_hits || [];
      if (hits.length > 0) {
        const names = hits
          .map(h => h.target?.PromptQlPage?.title || h.target?.RegularPage?.title)
          .filter(Boolean)
          .slice(0, 4);
        if (names.length > 0) {
          results.push({ type: 'status', status: `context: ${names.join(', ')}` });
        }
      } else {
        results.push({ type: 'status', status: 'reading wiki pages' });
      }
    }
    if (update.wiki_selection.completed !== undefined) {
      results.push({ type: 'status', status: 'context loaded' });
    }
  }

  // Wiki learning suggestion
  if (update.wiki_learning_suggestion) {
    const wls = update.wiki_learning_suggestion;
    if (wls.completed?.learning_suggestion?.learnings_markdown) {
      results.push({ type: 'learning', text: wls.completed.learning_suggestion.learnings_markdown });
    } else {
      results.push({ type: 'status', status: 'learning' });
    }
  }

  // Main agent loop
  const agent = update.main_agent;
  if (!agent) return results;

  // started
  if (agent.started !== undefined) {
    results.push({ type: 'status', status: 'planning' });
  }

  // turn_started / llm_response — these fire constantly and drown out
  // the useful statuses (reading wiki, running code, calling API).
  // Only show "reasoning" on the very first turn.
  if (agent.turn_started !== undefined && agent.turn_started.turn_index === 0) {
    results.push({ type: 'status', status: 'reasoning' });
  }

  // llm_response — skip status, the specific action statuses are more useful

  // actions_parsing_failed — not fatal, agent retries
  if (agent.actions_parsing_failed) {
    results.push({ type: 'status', status: 'correcting, retrying' });
  }

  // actions_parsed — user-facing text and action signals
  if (agent.actions_parsed) {
    for (const action of agent.actions_parsed.actions || []) {
      if (action.final_response) {
        results.push({ type: 'text', text: action.final_response.message });
      }
      if (action.responding_to_user) {
        results.push({ type: 'text', text: action.responding_to_user.message });
      }
      if (action.run_program) {
        results.push({ type: 'status', status: 'running code' });
      }
      if (action.read_wiki_page) {
        const title = action.read_wiki_page.page_title;
        results.push({ type: 'status', status: `reading: ${title}` });
      }
      if (action.read_wiki_page_section) {
        const title = action.read_wiki_page_section.section_title;
        results.push({ type: 'status', status: `reading: ${title}` });
      }
      if (action.write_file) {
        results.push({ type: 'status', status: `writing: ${action.write_file.path}` });
      }
      if (action.edit_file) {
        results.push({ type: 'status', status: `editing: ${action.edit_file.path}` });
      }
      if (action.propose_learnings) {
        const text = action.propose_learnings.learnings;
        if (text) {
          results.push({ type: 'learning', text });
        } else {
          results.push({ type: 'status', status: 'learning' });
        }
      } else if (action.learning_block) {
        const text = action.learning_block.learnings;
        if (text) {
          results.push({ type: 'learning', text });
        } else {
          results.push({ type: 'status', status: 'learning' });
        }
      }
    }
  }

  // action_started — detailed status for specific action types
  if (agent.action_started) {
    const action = agent.action_started.action;
    if (action?.run_program) {
      results.push({ type: 'status', status: 'running code' });
    } else if (action?.read_wiki_page) {
      const title = action.read_wiki_page.page_title;
      results.push({ type: 'status', status: `reading: ${title}` });
    } else if (action?.read_wiki_page_section) {
      const title = action.read_wiki_page_section.section_title;
      results.push({ type: 'status', status: `reading: ${title}` });
    } else if (action?.write_file) {
      results.push({ type: 'status', status: `writing: ${action.write_file.path}` });
    } else if (action?.edit_file) {
      results.push({ type: 'status', status: `editing: ${action.edit_file.path}` });
    }
  }

  // action_progress — HTTP calls, code output, artifact stubs
  if (agent.action_progress) {
    const progress = agent.action_progress.update;
    if (progress) {
      parseActionProgress(progress, results);
    }
  }

  // action_completed — THE source for artifacts with actual data/references
  if (agent.action_completed) {
    const result = agent.action_completed.result;
    if (!result) return results;

    // Skip message_sent — already captured from actions_parsed
    if (result.agent_loop_action_result_type === 'final_response_sent' ||
        result.agent_loop_action_result_type === 'message_sent') {
      // no-op — text already extracted from actions_parsed
    }

    // Artifacts with real references come from modified_artifacts
    if (result.modified_artifacts) {
      for (const art of result.modified_artifacts) {
        if (art.artifact_reference?.artifact_id) {
          results.push({
            type: 'artifact',
            artifact: {
              identifier: art.identifier,
              title: art.title,
              artifact_type: art.artifact_type,
              data: art.data,
              artifact_reference: art.artifact_reference,
            },
          });
        }
      }
    }
  }

  // completed — NOT a termination signal, learnings may follow
  if (agent.completed !== undefined) {
    results.push({ type: 'status', status: 'checking for learnings' });
  }

  return results;
}

function parseActionProgress(progress, results) {
  const runEvt = progress.program_run_event || progress.ProgramRunEvent || progress;

  // HTTP call status
  if (runEvt.type === 'HttpExecuteStarted') {
    try {
      const domain = new URL(runEvt.url).hostname.replace('www.', '');
      results.push({ type: 'status', status: `calling: ${domain}` });
    } catch {
      results.push({ type: 'status', status: 'calling API' });
    }
  }

  // HTTP completed — show status code
  if (runEvt.type === 'HttpExecuteCompleted') {
    if (runEvt.status_code && runEvt.status_code >= 400) {
      results.push({ type: 'status', status: `API error: ${runEvt.status_code}` });
    }
  }

  // DataArtifactUpdated in progress — these are stubs with NO data/reference.
  // Skip them — we capture the real artifacts from action_completed.modified_artifacts.
  // (just update status)
  if (runEvt.type === 'DataArtifactUpdated' || runEvt.DataArtifactUpdated) {
    const art = runEvt.type === 'DataArtifactUpdated' ? runEvt : runEvt.DataArtifactUpdated;
    results.push({ type: 'status', status: `building: ${art.title || art.identifier || 'artifact'}` });
  }

  // Code output
  if (runEvt.type === 'OutputEmitted' || runEvt.OutputEmitted) {
    results.push({ type: 'status', status: 'running code' });
  }

  // RunStarted
  if (runEvt.type === 'RunStarted') {
    results.push({ type: 'status', status: 'running code' });
  }

  // Direct artifact_modified (rare path)
  if (progress.artifact_modified) {
    const artifact = progress.artifact_modified.artifact_update;
    if (artifact?.artifact_reference?.artifact_id) {
      results.push({
        type: 'artifact',
        artifact: {
          identifier: artifact.identifier,
          title: artifact.title,
          artifact_type: artifact.artifact_type,
          data: artifact.data,
          artifact_reference: artifact.artifact_reference,
        },
      });
    }
  }
}

export function parseEvents(events) {
  const all = [];
  for (const event of events) {
    all.push(...parseEvent(event));
  }
  return all;
}
