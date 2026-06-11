import { fetchArtifactData, listThreadArtifacts } from './promptql-client.js';
import { existsSync } from 'fs';

// Find system Chrome for screenshots
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];
const chromePath = process.env.CHROME_PATH || CHROME_PATHS.find(p => existsSync(p));

let puppeteer;
try {
  puppeteer = (await import('puppeteer-core')).default;
} catch {
  try {
    puppeteer = (await import('puppeteer')).default;
  } catch {
    console.warn('[artifact] Puppeteer not available - HTML artifacts will be text-only');
  }
}

/**
 * Render HTML string to a PNG screenshot buffer.
 */
const POLYFILLS = `<script>
if(typeof crypto!=='undefined'&&!crypto.randomUUID){crypto.randomUUID=()=>'10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c=>(+c^(crypto.getRandomValues(new Uint8Array(1))[0]&(15>>(+c/4)))).toString(16))}
if(typeof structuredClone==='undefined'){globalThis.structuredClone=o=>JSON.parse(JSON.stringify(o))}
if(typeof requestIdleCallback==='undefined'){globalThis.requestIdleCallback=cb=>setTimeout(()=>cb({didTimeout:false,timeRemaining:()=>50}),1);globalThis.cancelIdleCallback=id=>clearTimeout(id)}
window.addEventListener('error',e=>e.preventDefault());
</script>`;

/**
 * Render simple HTML (tables, basic markup) to a PNG screenshot.
 */
async function htmlToImage(html, width = 800) {
  if (!puppeteer || !chromePath) return null;

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width, height: 600 });

    const wrappedHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
${POLYFILLS}
<style>
  body { background: #14151b; color: #e5e5e5; font-family: -apple-system, system-ui, sans-serif;
         margin: 0; padding: 20px; font-size: 14px; }
  table { border-collapse: collapse; width: 100%; }
  th { background: #1c1d24; color: #9CA3AF; font-size: 12px; text-transform: uppercase;
       letter-spacing: 0.5px; padding: 10px 12px; text-align: left; border-bottom: 1px solid #272932; }
  td { padding: 8px 12px; border-bottom: 1px solid #1c1d24; }
  tr:hover td { background: rgba(255,255,255,0.03); }
  h1,h2,h3 { color: #fff; }
  a { color: #B6FC34; }
</style>
</head><body>${html}</body></html>`;

    await page.setContent(wrappedHtml, { waitUntil: 'networkidle0', timeout: 10000 });

    const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
    await page.setViewport({ width, height: Math.min(bodyHeight + 40, 4000) });

    const screenshot = await page.screenshot({ type: 'png', fullPage: true });
    return Buffer.from(screenshot);
  } catch (err) {
    console.error('[artifact] Screenshot failed:', err.message);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Render a PromptQL React app artifact to PNG.
 *
 * Protocol (reverse-engineered from bundled promptQlHostHooks):
 *   App → parent: { type: "PROMPTQL_GET_THREAD_ARTIFACT_REQUEST", requestId, name }
 *   Parent → app: { type: "PROMPTQL_GET_THREAD_ARTIFACT_RESPONSE", requestId, success, data, artifactReference, artifactType }
 *
 * Strategy: write the HTML to a temp file, inject a mock parent hook that
 * intercepts postMessage before the app's listener fires, and load via file:// URL.
 */
async function reactAppToImage(appHtml, artifactDataMap = {}, width = 900) {
  if (!puppeteer || !chromePath) return null;

  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpFile = path.join(os.tmpdir(), `pql_artifact_${Date.now()}.html`);

  let browser;
  try {
    // Inject our mock host script at the very top of <head> in the artifact HTML.
    // This overrides window.parent.postMessage so the app gets data synchronously.
    // Escape </ in JSON to prevent breaking the script tag
    const safeDataJson = JSON.stringify(artifactDataMap).replace(/<\//g, '<\\/');
    const mockScript = `<script>
(function() {
  const _dataMap = ${safeDataJson};
  const _origParent = window.parent;
  const _origPostMessage = window.postMessage.bind(window);

  // Intercept messages sent to parent (which is ourselves since no iframe)
  const _origParentPostMessage = _origParent.postMessage.bind(_origParent);

  // Listen for the app's requests and respond
  window.addEventListener('message', function(e) {
    const msg = e.data;
    if (!msg || !msg.type) return;
    if (msg.type === 'PROMPTQL_GET_THREAD_ARTIFACT_REQUEST') {
      const name = msg.name;
      const data = name ? _dataMap[name] : Object.values(_dataMap)[0];
      const encoder = new TextEncoder();
      const encoded = data ? encoder.encode(JSON.stringify(data)).buffer : null;
      setTimeout(function() {
        window.postMessage({
          type: 'PROMPTQL_GET_THREAD_ARTIFACT_RESPONSE',
          requestId: msg.requestId,
          success: !!data,
          data: encoded,
          artifactReference: { version: 0, artifact_id: 'mock' },
          artifactType: Array.isArray(data) ? 'table' : 'text',
          error: data ? null : 'Data not available'
        }, '*');
      }, 10);
    }
    if (msg.type === 'PROMPTQL_EXECUTE_PROGRAM_REQUEST') {
      setTimeout(function() {
        window.postMessage({
          type: 'PROMPTQL_EXECUTE_PROGRAM_RESPONSE',
          requestId: msg.requestId,
          success: false,
          error: 'Not available'
        }, '*');
      }, 10);
    }
  });

  // Make window.parent point to window itself so postMessage goes to our listener
  try { Object.defineProperty(window, 'parent', { get: () => window }); } catch(e) {}
})();
</script>`;

    // Also inject polyfills
    const fullInject = POLYFILLS + mockScript;

    // Insert after <head> tag
    let modifiedHtml;
    const headIdx = appHtml.indexOf('<head');
    if (headIdx !== -1) {
      const closeIdx = appHtml.indexOf('>', headIdx);
      modifiedHtml = appHtml.slice(0, closeIdx + 1) + fullInject + appHtml.slice(closeIdx + 1);
    } else {
      modifiedHtml = fullInject + appHtml;
    }

    fs.writeFileSync(tmpFile, modifiedHtml);

    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
    });
    const page = await browser.newPage();
    // Start with a normal viewport — React components using 100vh will fit naturally
    await page.setViewport({ width, height: 900 });

    await page.goto('file://' + tmpFile, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Wait for React to render
    await new Promise(r => setTimeout(r, 4000));

    // Check content
    const pageText = await page.evaluate(() => document.body?.innerText?.trim() || '');
    if (!pageText || /^(loading|error|estimating)/i.test(pageText)) {
      console.log('[artifact] React app text:', pageText?.slice(0, 100));
      await new Promise(r => setTimeout(r, 3000));
    }

    const finalText = await page.evaluate(() => document.body?.innerText?.trim() || '');
    if (!finalText || finalText.length < 20) {
      console.log('[artifact] React app empty after wait:', finalText?.slice(0, 100));
      return null;
    }

    // Measure actual content height (not viewport height)
    const contentHeight = await page.evaluate(() => {
      const root = document.getElementById('root');
      // Get the natural content height, ignoring viewport-based sizing
      const elements = document.querySelectorAll('body > *, #root > *');
      let maxBottom = 0;
      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        if (rect.bottom > maxBottom) maxBottom = rect.bottom;
      }
      return Math.max(maxBottom, root?.scrollHeight || 0, 600);
    });
    // Resize viewport to content, then screenshot with fullPage
    await page.setViewport({ width, height: Math.min(Math.ceil(contentHeight) + 40, 8000) });

    const screenshot = await page.screenshot({ type: 'png', fullPage: true });
    return Buffer.from(screenshot);
  } catch (err) {
    console.error('[artifact] React app screenshot failed:', err.message);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Convert a PromptQL artifact into WhatsApp-sendable content.
 * Returns { type, content, caption?, filename? }
 */
// Cache of recently fetched artifact data — keyed by identifier.
// React HTML artifacts use these via usePromptQlArtifact hooks.
const recentArtifactData = {};

// Track current thread for fetching sibling artifacts
let currentThreadId = null;

export function setCurrentThread(threadId) {
  currentThreadId = threadId;
}

export async function artifactToWhatsApp(artifact) {
  let { identifier, title, artifact_type, data, artifact_reference } = artifact;

  // If no inline data, try fetching via artifact reference before dispatching.
  // modified_artifacts from PromptQL always have data: null.
  if (data == null && artifact_reference?.artifact_id) {
    try {
      const fetched = await fetchArtifactData(artifact_reference.artifact_id);
      const contentType = fetched.contentType || '';
      if (contentType.includes('html')) {
        data = fetched.data.toString('utf-8');
      } else if (contentType.startsWith('image/')) {
        return { type: 'image', content: fetched.data, caption: title || 'Image' };
      } else if (contentType.includes('json') || contentType.includes('text')) {
        // Try JSON first (PromptQL often uses text/plain for JSON data)
        const text = fetched.data.toString('utf-8');
        try { data = JSON.parse(text); } catch { data = text; }
        if (identifier) recentArtifactData[identifier] = data;
      } else {
        // Binary file — send as document
        const ext = mimeToExt(contentType);
        return {
          type: 'document',
          content: fetched.data,
          caption: title || 'File',
          filename: `${sanitizeFilename(title || 'artifact')}.${ext}`,
          mimetype: contentType,
        };
      }
    } catch (err) {
      console.log('[artifact] Failed to pre-fetch artifact data:', err.message);
    }
  }

  switch (artifact_type) {
    case 'text':
      return formatTextArtifact(title, data);

    case 'table':
      return await formatTableArtifact(title, data, artifact_reference);

    case 'visualization':
    case 'html':
      return await formatHtmlArtifact(title, data, artifact_reference);

    case 'file':
      return await formatFileArtifact(title, artifact_reference);

    default:
      return { type: 'text', content: `_[Artifact: ${title}] (type: ${artifact_type})_` };
  }
}

function formatTextArtifact(title, data) {
  let text;
  if (typeof data === 'string') {
    text = data;
  } else if (data != null && typeof data === 'object') {
    // Format JSON data as readable WhatsApp text
    text = formatJsonForWhatsApp(data);
  } else {
    text = '_(no data)_';
  }
  text = markdownToWhatsApp(text);
  return {
    type: 'text',
    content: title ? `*${title}*\n\n${text}` : text,
  };
}

/**
 * Format a JSON object as readable WhatsApp text.
 */
function formatJsonForWhatsApp(obj, indent = 0) {
  if (obj == null) return '_(empty)_';
  if (typeof obj !== 'object') return String(obj);
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '_(none)_';
    // Array of objects → format each as a block
    if (typeof obj[0] === 'object' && obj[0] !== null) {
      return obj.map((item, i) => {
        const prefix = obj.length > 1 ? `*${i + 1}.* ` : '';
        return prefix + formatJsonForWhatsApp(item, indent);
      }).join('\n\n');
    }
    // Simple array
    return obj.map(item => `• ${item}`).join('\n');
  }
  // Object → key-value pairs
  const lines = [];
  for (const [key, value] of Object.entries(obj)) {
    const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    if (value == null) continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      // Nested object — inline if small, block if large
      const entries = Object.entries(value);
      if (entries.length <= 4 && entries.every(([, v]) => typeof v !== 'object')) {
        const inline = entries.map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ');
        lines.push(`*${label}:* ${inline}`);
      } else {
        lines.push(`*${label}:*`);
        lines.push(formatJsonForWhatsApp(value, indent + 1));
      }
    } else if (Array.isArray(value)) {
      lines.push(`*${label}:*`);
      lines.push(formatJsonForWhatsApp(value, indent + 1));
    } else {
      lines.push(`*${label}:* ${value}`);
    }
  }
  return lines.join('\n');
}

async function formatTableArtifact(title, data, artifactReference) {
  let rows;
  if (data?.Table) {
    rows = data.Table.preview_rows || [];
  } else if (Array.isArray(data)) {
    rows = data;
  } else {
    rows = [];
  }

  // If no inline data, try fetching via artifact reference
  if (rows.length === 0 && artifactReference?.artifact_id) {
    try {
      const fetched = await fetchArtifactData(artifactReference.artifact_id);
      const contentType = fetched.contentType || '';
      if (contentType.includes('json')) {
        const parsed = JSON.parse(fetched.data.toString('utf-8'));
        if (parsed?.Table) {
          rows = parsed.Table.preview_rows || [];
          if (!data) data = parsed;
        } else if (Array.isArray(parsed)) {
          rows = parsed;
        }
      }
    } catch (err) {
      console.log('[artifact] Failed to fetch table data:', err.message);
    }
  }

  if (rows.length === 0) {
    return { type: 'text', content: `*${title}*\n_(empty table)_` };
  }

  const columns = Object.keys(rows[0]);
  const totalRows = data?.Table?.total_row_count || rows.length;

  // Try to render as image
  const tableHtml = buildTableHtml(title, columns, rows.slice(0, 50), totalRows);
  const image = await htmlToImage(tableHtml);

  if (image) {
    return {
      type: 'image',
      content: image,
      caption: `${title}${totalRows > 50 ? ` (showing 50 of ${totalRows} rows)` : ''}`,
    };
  }

  // Fallback: simple text table
  let text = `*${title}*\n\`\`\`\n`;
  const maxRows = 10;
  const colWidths = columns.map(col =>
    Math.min(Math.max(col.length, ...rows.slice(0, maxRows).map(r => String(r[col] ?? '').length)), 18)
  );
  text += columns.map((c, i) => c.slice(0, colWidths[i]).padEnd(colWidths[i])).join(' | ') + '\n';
  text += colWidths.map(w => '-'.repeat(w)).join('-+-') + '\n';
  for (const row of rows.slice(0, maxRows)) {
    text += columns.map((c, i) => String(row[c] ?? '').slice(0, colWidths[i]).padEnd(colWidths[i])).join(' | ') + '\n';
  }
  text += '```';
  if (totalRows > maxRows) text += `\n_(showing ${maxRows} of ${totalRows} rows)_`;
  return { type: 'text', content: text };
}

function buildTableHtml(title, columns, rows, totalRows) {
  let html = `<h3 style="margin:0 0 12px 0;font-size:16px">${escapeHtml(title)}</h3>`;
  html += '<table><thead><tr>';
  for (const col of columns) {
    html += `<th>${escapeHtml(col)}</th>`;
  }
  html += '</tr></thead><tbody>';
  for (const row of rows) {
    html += '<tr>';
    for (const col of columns) {
      html += `<td>${escapeHtml(String(row[col] ?? ''))}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  if (totalRows > rows.length) {
    html += `<p style="color:#6B7280;font-size:12px;margin-top:8px">Showing ${rows.length} of ${totalRows} rows</p>`;
  }
  return html;
}

async function formatHtmlArtifact(title, data, artifactReference) {
  let html = null;

  if (artifactReference?.artifact_id) {
    try {
      const fetched = await fetchArtifactData(artifactReference.artifact_id);
      if (fetched.contentType.includes('html')) {
        html = fetched.data.toString('utf-8');
      } else if (fetched.contentType.includes('image')) {
        return {
          type: 'image',
          content: fetched.data,
          caption: title || 'Visualization',
        };
      }
    } catch (err) {
      console.log('[artifact] Failed to fetch artifact data:', err.message);
    }
  }

  if (!html && typeof data === 'string') {
    html = data;
  } else if (!html && data?.html) {
    html = data.html;
  }

  if (html) {
    // Detect if this is a PromptQL React app that needs host data
    // The minified bundle contains PROMPTQL_GET_THREAD_ARTIFACT protocol strings
    const isReactApp = html.includes('PROMPTQL_GET_THREAD_ARTIFACT') ||
                        html.includes('promptQlHostHooks') || html.includes('usePromptQlArtifact');

    if (isReactApp) {
      // Fetch all sibling artifact data for this thread so the React app can load them
      const dataMap = { ...recentArtifactData };
      if (currentThreadId) {
        try {
          const threadArtifacts = await listThreadArtifacts(currentThreadId);
          for (const ta of threadArtifacts) {
            if (ta.identifier && !dataMap[ta.identifier]) {
              try {
                const fetched = await fetchArtifactData(ta.artifact_id);
                const ct = fetched.contentType || '';
                const text = fetched.data.toString('utf-8');
                // Try parsing as JSON regardless of content-type (PromptQL often uses text/plain for JSON)
                if (ct.includes('json') || ct.includes('text')) {
                  try {
                    dataMap[ta.identifier] = JSON.parse(text);
                  } catch {
                    dataMap[ta.identifier] = text;
                  }
                }
              } catch { /* skip unfetchable artifacts */ }
            }
          }
        } catch (err) {
          console.log('[artifact] Failed to list thread artifacts:', err.message);
        }
      }

      const image = await reactAppToImage(html, dataMap, 900);
      if (image) {
        return { type: 'image', content: image, caption: title || 'Visualization' };
      }
      return {
        type: 'text',
        content: `*${title || 'Visualization'}*\n_Interactive visualization — open PromptQL to view._`,
      };
    }

    // Simple HTML (tables, static content) — render directly
    const image = await htmlToImage(html, 900);
    if (image) {
      return { type: 'image', content: image, caption: title || 'Visualization' };
    }
  }

  return {
    type: 'text',
    content: `*${title || 'Visualization'}*\n_Interactive visualization — open PromptQL to view._`,
  };
}

async function formatFileArtifact(title, artifactReference) {
  if (!artifactReference?.artifact_id) {
    return { type: 'text', content: `_[File: ${title}]_` };
  }

  try {
    const { contentType, data } = await fetchArtifactData(artifactReference.artifact_id);

    if (contentType.startsWith('image/')) {
      return { type: 'image', content: data, caption: title || 'Image' };
    }

    // PDFs, CSVs, Excel, etc → send as document attachment
    const ext = mimeToExt(contentType);
    return {
      type: 'document',
      content: data,
      caption: title || 'File',
      filename: `${sanitizeFilename(title || 'artifact')}.${ext}`,
      mimetype: contentType,
    };
  } catch (err) {
    console.log('[artifact] Failed to fetch file:', err.message);
    return { type: 'text', content: `_[File: ${title}] (failed to fetch)_` };
  }
}

function mimeToExt(mime) {
  const map = {
    'application/pdf': 'pdf',
    'text/csv': 'csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/json': 'json',
    'text/plain': 'txt',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/svg+xml': 'svg',
  };
  return map[mime] || mime.split('/')[1] || 'bin';
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9_\- ]/g, '').slice(0, 60);
}

function escapeHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function markdownToWhatsApp(text = '') {
  text = text.replace(/\*\*(.+?)\*\*/g, '*$1*');
  text = text.replace(/__(.+?)__/g, '*$1*');
  text = text.replace(/~~(.+?)~~/g, '~$1~');
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
  text = text.replace(/^[-*]\s+/gm, '• ');
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  return text;
}
