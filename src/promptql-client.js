import { config } from './config.js';

// Shared GQL endpoint (not project-specific, used for discovery + all queries)
const SHARED_GQL = 'https://data.prompt.ql.app/promptql/playground-v2-hge/v1/graphql';

// Derive endpoint URLs from the project endpoint.
// Project endpoint looks like: https://data.prompt.ql.app/amql
// Playground v2 host:          https://data.prompt.ql.app/amql/promptql-v2
function deriveEndpoints(projectEndpoint) {
  const ep = projectEndpoint.replace(/\/$/, '');
  return { gqlEndpoint: SHARED_GQL, playground2Host: `${ep}/promptql-v2`, apiEndpoint: ep };
}

const cache = {
  gqlEndpoint: null,
  playground2Host: null,
  apiEndpoint: null,
  roomId: null,
  initialized: false,
};

const authHeaders = () => ({ Authorization: `pat ${config.token}` });

async function graphqlRequest({ url, query, variables = {}, headers = {} }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(json.errors.map(e => e.message).join(', '));
  }
  return json.data;
}

async function ensureRoom() {
  if (cache.roomId) return cache.roomId;
  const headers = authHeaders();

  // Try to find existing room
  try {
    const data = await graphqlRequest({
      url: cache.gqlEndpoint,
      query: `
        query FindRoom($name: String!) {
          rooms(where: { name: { _eq: $name } }, limit: 1) {
            room_id
            name
          }
        }
      `,
      variables: { name: config.roomName },
      headers,
    });
    if (data.rooms?.length > 0) {
      cache.roomId = data.rooms[0].room_id;
      console.log(`[pql] Found room: ${config.roomName} (${cache.roomId})`);
      return cache.roomId;
    }
  } catch (err) {
    console.log('[pql] Room lookup failed:', err.message);
  }

  // Create room
  try {
    const data = await graphqlRequest({
      url: cache.gqlEndpoint,
      query: `
        mutation CreateRoom($name: String!, $description: String) {
          create_room(name: $name, description: $description, visibility: "public") {
            room_id
          }
        }
      `,
      variables: {
        name: config.roomName,
        description: 'WhatsApp ↔ PromptQL bridge',
      },
      headers,
    });
    cache.roomId = data.create_room?.room_id;
    console.log(`[pql] Created room: ${config.roomName} (${cache.roomId})`);
    return cache.roomId;
  } catch (err) {
    console.log('[pql] Room creation failed:', err.message);
    return null;
  }
}

export async function ensureTokens() {
  if (cache.initialized) return cache;

  if (config.projectEndpoint) {
    // Explicit endpoint provided
    const { gqlEndpoint, playground2Host, apiEndpoint } = deriveEndpoints(config.projectEndpoint);
    cache.gqlEndpoint = gqlEndpoint;
    cache.playground2Host = playground2Host;
    cache.apiEndpoint = apiEndpoint;
  } else {
    // Auto-discover project from token
    cache.gqlEndpoint = SHARED_GQL;
    const data = await graphqlRequest({
      url: SHARED_GQL,
      query: `query { project_info { project_name } }`,
      headers: authHeaders(),
    });
    const projects = data.project_info;
    if (!projects?.length) {
      throw new Error('Token has no project access. Set PROMPTQL_ENDPOINT manually.');
    }
    const projectName = projects[0].project_name;
    const ep = `https://data.prompt.ql.app/${projectName}`;
    cache.playground2Host = `${ep}/promptql-v2`;
    cache.apiEndpoint = ep;
    console.log(`[pql] Auto-discovered project: ${projectName}`);
  }

  // Validate the token works
  try {
    await graphqlRequest({
      url: cache.gqlEndpoint,
      query: `query { rooms(limit: 1) { room_id } }`,
      headers: authHeaders(),
    });
  } catch (err) {
    throw new Error(`Token validation failed: ${err.message}`);
  }

  console.log(`[pql] Endpoint: ${cache.gqlEndpoint}`);
  cache.initialized = true;

  await ensureRoom();
  return cache;
}

/**
 * Start a new PromptQL thread.
 * Returns { thread_id, title, created_at }
 */
export async function startThread(message) {
  const c = await ensureTokens();
  const hasRoom = !!c.roomId;

  const query = `
    mutation StartThread(
      $message: String!
      $timezone: String!
      ${hasRoom ? '$roomId: String' : ''}
    ) {
      start_thread(
        message: $message
        timezone: $timezone
        ${hasRoom ? 'roomId: $roomId' : ''}
      ) {
        thread_id
        title
        created_at
        thread_events {
          thread_event_id
          created_at
          event_data
        }
      }
    }
  `;

  const variables = {
    message,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  if (hasRoom) variables.roomId = c.roomId;

  const data = await graphqlRequest({
    url: c.gqlEndpoint,
    query,
    variables,
    headers: authHeaders(),
  });

  return data.start_thread;
}

/**
 * Send a follow-up message to an existing thread.
 * @param {string} threadId
 * @param {string} message
 * @param {Array<{artifact_name: string, artifact_reference: {artifact_id: string, version: number}}>} [uploads]
 */
export async function sendMessage(threadId, message, uploads) {
  const c = await ensureTokens();

  const data = await graphqlRequest({
    url: c.gqlEndpoint,
    query: `
      mutation SendThreadMessage(
        $message: String!
        $timezone: String!
        $threadId: String!
        $uploads: [UserUploadInput!]
      ) {
        send_thread_message(
          threadId: $threadId
          timezone: $timezone
          message: $message
          uploads: $uploads
        ) {
          thread_event_id
          event_data
          created_at
        }
      }
    `,
    variables: {
      message,
      threadId,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(uploads ? { uploads } : {}),
    },
    headers: authHeaders(),
  });

  return data.send_thread_message;
}

/**
 * Create an empty thread (used when we need to upload artifacts before sending the first message).
 */
export async function createEmptyThread() {
  const c = await ensureTokens();
  const hasRoom = !!c.roomId;

  const query = `
    mutation CreateEmptyThread(
      ${hasRoom ? '$roomId: String' : ''}
    ) {
      create_empty_thread(
        ${hasRoom ? 'roomId: $roomId' : ''}
      ) {
        thread_id
        title
        created_at
      }
    }
  `;

  const variables = {};
  if (hasRoom) variables.roomId = c.roomId;

  const data = await graphqlRequest({
    url: c.gqlEndpoint,
    query,
    variables,
    headers: authHeaders(),
  });

  return data.create_empty_thread;
}

/**
 * Upload a file as an artifact scoped to a thread.
 * Uses the multipart REST API (same as the console's ArtifactsV2Client).
 *
 * @param {string} threadId
 * @param {Buffer} buffer - The file data
 * @param {string} filename
 * @param {string} mimetype
 * @returns {{ artifact_id: string, version: number }}
 */
export async function uploadArtifact(threadId, buffer, filename, mimetype) {
  const c = await ensureTokens();
  const baseUrl = c.playground2Host;

  const request = {
    scope: {
      type: 'thread',
      thread_id: threadId,
      identifier: filename,
    },
    operation: {
      type: 'upload',
      title: filename,
      description: filename,
      artifact_type: 'file',
    },
  };

  const formData = new FormData();
  formData.append(
    'artifact_request',
    new Blob([JSON.stringify(request)], { type: 'application/json' })
  );
  formData.append(
    'artifact_data',
    new Blob([buffer], { type: mimetype || 'application/octet-stream' }),
    filename
  );

  const res = await fetch(`${baseUrl}/artifacts`, {
    method: 'POST',
    headers: authHeaders(),
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Artifact upload failed: ${res.status} ${text}`);
  }

  return res.json(); // { artifact_id, version }
}

/**
 * Stream thread events via SSE. Calls onEvent for each parsed event,
 * and onDone when the stream ends.
 * Returns an abort function.
 */
export async function streamThreadEvents(threadId, { onEvent, onDone, onError }) {
  const c = await ensureTokens();
  const baseUrl = c.playground2Host;
  if (!baseUrl) {
    onError?.(new Error('No playground host configured'));
    return () => {};
  }

  const sseUrl = `${baseUrl}/threads/${threadId}`;
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(sseUrl, {
        headers: {
          Accept: 'text/event-stream',
          ...authHeaders(),
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        onError?.(new Error(`SSE error: ${res.status}`));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const raw = line.slice(6).trim();
            if (!raw) continue;
            try {
              const event = JSON.parse(raw);
              onEvent?.(event);
            } catch {
              // Not JSON - might be a keepalive or other SSE data
            }
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        onError?.(err);
      }
    }
    onDone?.();
  })();

  return () => controller.abort();
}

/**
 * Poll for thread events (fallback when SSE isn't suitable).
 */
export async function pollThreadEvents(threadId, afterEventId = '0') {
  const c = await ensureTokens();

  const data = await graphqlRequest({
    url: c.gqlEndpoint,
    query: `
      query GetThreadEvents($threadId: uuid!, $afterEventId: bigint!) {
        thread_events(
          where: {
            thread_id: { _eq: $threadId }
            thread_event_id: { _gt: $afterEventId }
          }
          order_by: { thread_event_id: asc }
        ) {
          thread_event_id
          created_at
          event_data
        }
      }
    `,
    variables: { threadId, afterEventId: String(afterEventId) },
    headers: authHeaders(),
  });

  return data.thread_events || [];
}

/**
 * Fetch artifact data by artifact ID.
 */
export async function fetchArtifactData(artifactId) {
  const c = await ensureTokens();

  const url = `${c.playground2Host}/artifacts/${artifactId}/data`;
  const res = await fetch(url, {
    headers: authHeaders(),
  });

  if (!res.ok) throw new Error(`Artifact fetch failed: ${res.status}`);

  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const body = await res.arrayBuffer();
  return { contentType, data: Buffer.from(body) };
}

/**
 * Submit a wiki teaching.
 */
export async function submitTeaching(threadId, agentMessageId, teaching) {
  const c = await ensureTokens();

  const data = await graphqlRequest({
    url: c.gqlEndpoint,
    query: `
      mutation SubmitTeaching(
        $teachings: String!
        $threadId: uuid!
        $agentMessageId: String!
      ) {
        submit_user_teaching(
          teachings: $teachings
          threadId: $threadId
          agentMessageId: $agentMessageId
        ) {
          thread_event_id
          event_data
          created_at
        }
      }
    `,
    variables: { teachings: teaching, threadId, agentMessageId },
    headers: authHeaders(),
  });

  return data.submit_user_teaching;
}

/**
 * List available rooms for the current project.
 */
export async function listRooms() {
  const c = await ensureTokens();

  const data = await graphqlRequest({
    url: c.gqlEndpoint,
    query: `
      query GetRooms {
        rooms(where: { deleted_at: { _is_null: true } }, order_by: { name: asc }) {
          room_id
          name
          description
        }
      }
    `,
    headers: authHeaders(),
  });

  return data.rooms || [];
}

/**
 * Switch to a different room by name. Updates the cached room ID.
 */
export async function switchRoom(roomName) {
  const c = await ensureTokens();

  const data = await graphqlRequest({
    url: c.gqlEndpoint,
    query: `
      query FindRoom($name: String!) {
        rooms(where: { name: { _eq: $name } }, limit: 1) {
          room_id
          name
        }
      }
    `,
    variables: { name: roomName },
    headers: authHeaders(),
  });

  if (!data.rooms?.length) return null;
  cache.roomId = data.rooms[0].room_id;
  return data.rooms[0];
}

/**
 * List recent threads (optionally for a specific room).
 */
export async function listThreads(roomId = null, limit = 10) {
  const c = await ensureTokens();
  const useRoom = roomId || c.roomId;

  const where = useRoom
    ? `where: { room_id: { _eq: "${useRoom}" }, deleted_at: { _is_null: true } }`
    : `where: { deleted_at: { _is_null: true } }`;

  const data = await graphqlRequest({
    url: c.gqlEndpoint,
    query: `
      query GetThreads {
        threads_v2(${where}, order_by: { updated_at: desc }, limit: ${limit}) {
          thread_id
          title
          custom_title
          updated_at
        }
      }
    `,
    headers: authHeaders(),
  });

  return data.threads_v2 || [];
}

/**
 * List all artifacts for a thread. Returns [{ artifact_id, identifier }]
 */
export async function listThreadArtifacts(threadId) {
  const c = await ensureTokens();

  const data = await graphqlRequest({
    url: c.gqlEndpoint,
    query: `
      query GetThreadArtifacts($tid: uuid!) {
        thread_artifacts(where: { thread_id: { _eq: $tid } }) {
          artifact_id
          identifier
        }
      }
    `,
    variables: { tid: threadId },
    headers: authHeaders(),
  });

  return data.thread_artifacts || [];
}

export function getCache() {
  return { ...cache };
}
