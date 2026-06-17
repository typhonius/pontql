import { config } from './config.js';

// In-memory token cache
const cache = {
  promptqlToken: null,
  promptqlTokenExpiry: null,
  userDirectoryToken: null,
  userDirectoryTokenExpiry: null,
  projectId: null,
  projectName: null,
  playgroundV2Endpoint: null,
  playground2Host: null,
  allProjects: null,
  roomId: null,
};

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

async function getProjects() {
  const data = await graphqlRequest({
    url: config.controlPlaneData,
    query: `
      query getProjects {
        ddn_projects(order_by: { created_at: desc }) {
          id
          name
          title
          endpoint
          plan_name
          private_ddn {
            fqdn
            promptql_config
            promptql_route_config
          }
        }
      }
    `,
    headers: { Authorization: `pat ${config.pat}` },
  });
  return data.ddn_projects || [];
}

async function getPromptQLAccessToken(projectId) {
  const res = await fetch(`${config.controlPlaneAuth}/ddn/promptql/token`, {
    method: 'POST',
    headers: {
      Authorization: `pat ${config.pat}`,
      'x-hasura-project-id': projectId,
    },
  });
  if (!res.ok) throw new Error(`Failed to get PromptQL token: ${res.status}`);
  return res.json();
}

async function enrichToken({ playgroundV2Endpoint, luxJWT, projectId }) {
  const data = await graphqlRequest({
    url: playgroundV2Endpoint,
    query: `
      mutation EnrichToken($luxJWT: String!, $projectId: uuid!) {
        enrich_token(luxJWT: $luxJWT, projectId: $projectId) {
          userDirectoryJWT
        }
      }
    `,
    variables: { luxJWT, projectId },
  });
  return data.enrich_token.userDirectoryJWT;
}

function buildPlaygroundV2Endpoint(project) {
  const routeConfig = project?.private_ddn?.promptql_route_config;
  const playgroundUri = routeConfig?.playground_uri;
  const base = (playgroundUri || config.playgroundHost).replace(/\/$/, '');
  return `${base}-v2-hge/v1/graphql`;
}

function buildPlayground2Host(project) {
  const routeConfig = project?.private_ddn?.promptql_route_config;
  const playgroundUri = routeConfig?.playground_uri;
  if (playgroundUri) return playgroundUri.replace(/\/$/, '');
  const apiEndpoint = project?.endpoint;
  if (apiEndpoint) return `${apiEndpoint.replace(/\/$/, '')}/promptql-v2`;
  return null;
}

async function ensureRoom() {
  if (cache.roomId) return cache.roomId;
  const headers = { Authorization: `Bearer ${cache.userDirectoryToken}` };

  // Try to find existing room
  try {
    const data = await graphqlRequest({
      url: cache.playgroundV2Endpoint,
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
      url: cache.playgroundV2Endpoint,
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
  const now = new Date();
  if (
    cache.userDirectoryToken &&
    cache.userDirectoryTokenExpiry &&
    new Date(cache.userDirectoryTokenExpiry) > now
  ) {
    return cache;
  }

  if (!cache.projectId) {
    const projects = await getProjects();
    if (projects.length === 0) throw new Error('No projects found for this PAT');

    let project;
    if (config.projectName) {
      project = projects.find(p => p.name === config.projectName);
      if (!project) throw new Error(`Project "${config.projectName}" not found`);
    } else {
      project = projects[0];
    }

    cache.projectId = project.id;
    cache.projectName = project.name;
    cache.playgroundV2Endpoint = buildPlaygroundV2Endpoint(project);
    cache.playground2Host = buildPlayground2Host(project);
    cache.allProjects = projects;
    console.log(`[pql] Project: ${project.name} (${project.id})`);
    console.log(`[pql] Endpoint: ${cache.playgroundV2Endpoint}`);
  }

  const { token: pqlToken } = await getPromptQLAccessToken(cache.projectId);
  cache.promptqlToken = pqlToken;

  const udToken = await enrichToken({
    playgroundV2Endpoint: cache.playgroundV2Endpoint,
    luxJWT: pqlToken,
    projectId: cache.projectId,
  });
  cache.userDirectoryToken = udToken;

  try {
    const payload = JSON.parse(Buffer.from(udToken.split('.')[1], 'base64').toString());
    cache.userDirectoryTokenExpiry = new Date(payload.exp * 1000).toISOString();
  } catch {
    cache.userDirectoryTokenExpiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  }

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
      $projectId: String!
      $timezone: String!
      ${hasRoom ? '$roomId: String' : ''}
    ) {
      start_thread(
        message: $message
        projectId: $projectId
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
    projectId: c.projectId,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  if (hasRoom) variables.roomId = c.roomId;

  const data = await graphqlRequest({
    url: c.playgroundV2Endpoint,
    query,
    variables,
    headers: { Authorization: `Bearer ${c.userDirectoryToken}` },
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
    url: c.playgroundV2Endpoint,
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
    headers: { Authorization: `Bearer ${c.userDirectoryToken}` },
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
      $projectId: String!
      ${hasRoom ? '$roomId: String' : ''}
    ) {
      create_empty_thread(
        projectId: $projectId
        ${hasRoom ? 'roomId: $roomId' : ''}
      ) {
        thread_id
        title
        created_at
      }
    }
  `;

  const variables = { projectId: c.projectId };
  if (hasRoom) variables.roomId = c.roomId;

  const data = await graphqlRequest({
    url: c.playgroundV2Endpoint,
    query,
    variables,
    headers: { Authorization: `Bearer ${c.userDirectoryToken}` },
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
  const project = (c.allProjects || []).find(p => p.id === c.projectId);
  const apiEndpoint = project?.endpoint;
  if (!apiEndpoint) throw new Error('No API endpoint configured for artifact upload');
  const baseUrl = `${apiEndpoint.replace(/\/$/, '')}/promptql-v2`;

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
    headers: {
      Authorization: `Bearer ${c.userDirectoryToken}`,
    },
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
          Authorization: `Bearer ${c.userDirectoryToken}`,
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
    url: c.playgroundV2Endpoint,
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
    headers: { Authorization: `Bearer ${c.userDirectoryToken}` },
  });

  return data.thread_events || [];
}

/**
 * Fetch artifact data by artifact ID.
 */
export async function fetchArtifactData(artifactId) {
  const c = await ensureTokens();
  const project = (c.allProjects || []).find(p => p.id === c.projectId);
  const apiEndpoint = project?.endpoint;
  if (!apiEndpoint) throw new Error('No API endpoint configured');

  const url = `${apiEndpoint.replace(/\/$/, '')}/promptql-v2/artifacts/${artifactId}/data`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${c.userDirectoryToken}` },
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
    url: c.playgroundV2Endpoint,
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
    headers: { Authorization: `Bearer ${c.userDirectoryToken}` },
  });

  return data.submit_user_teaching;
}

/**
 * List available rooms for the current project.
 */
export async function listRooms() {
  const c = await ensureTokens();

  const data = await graphqlRequest({
    url: c.playgroundV2Endpoint,
    query: `
      query GetRooms {
        rooms(where: { deleted_at: { _is_null: true } }, order_by: { name: asc }) {
          room_id
          name
          description
        }
      }
    `,
    headers: { Authorization: `Bearer ${c.userDirectoryToken}` },
  });

  return data.rooms || [];
}

/**
 * Switch to a different room by name. Updates the cached room ID.
 */
export async function switchRoom(roomName) {
  const c = await ensureTokens();

  const data = await graphqlRequest({
    url: c.playgroundV2Endpoint,
    query: `
      query FindRoom($name: String!) {
        rooms(where: { name: { _eq: $name } }, limit: 1) {
          room_id
          name
        }
      }
    `,
    variables: { name: roomName },
    headers: { Authorization: `Bearer ${c.userDirectoryToken}` },
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
    url: c.playgroundV2Endpoint,
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
    headers: { Authorization: `Bearer ${c.userDirectoryToken}` },
  });

  return data.threads_v2 || [];
}

/**
 * Switch to a different project by name.
 */
export async function switchProject(projectName) {
  const projects = cache.allProjects || (await getProjects());
  const project = projects.find(p =>
    p.name.toLowerCase() === projectName.toLowerCase()
  );
  if (!project) return null;

  cache.projectId = project.id;
  cache.projectName = project.name;
  cache.playgroundV2Endpoint = buildPlaygroundV2Endpoint(project);
  cache.playground2Host = buildPlayground2Host(project);
  cache.userDirectoryToken = null;
  cache.userDirectoryTokenExpiry = null;
  cache.roomId = null;

  await ensureTokens();
  return { id: project.id, name: project.name };
}

/**
 * List all available projects.
 */
export async function listProjects() {
  const projects = cache.allProjects || (await getProjects());
  return projects.map(p => ({ id: p.id, name: p.name, title: p.title }));
}

/**
 * List all artifacts for a thread. Returns [{ artifact_id, identifier }]
 */
export async function listThreadArtifacts(threadId) {
  const c = await ensureTokens();

  const data = await graphqlRequest({
    url: c.playgroundV2Endpoint,
    query: `
      query GetThreadArtifacts($tid: uuid!) {
        thread_artifacts(where: { thread_id: { _eq: $tid } }) {
          artifact_id
          identifier
        }
      }
    `,
    variables: { tid: threadId },
    headers: { Authorization: `Bearer ${c.userDirectoryToken}` },
  });

  return data.thread_artifacts || [];
}

export function getCache() {
  return { ...cache };
}
