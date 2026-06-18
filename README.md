# PontQL

Talk to [PromptQL](https://promptql.io) from WhatsApp — multiplayer AI with shared context.

PontQL bridges WhatsApp messages to the PromptQL API. It renders artifacts (tables, charts, dashboards) as images, streams live status updates, and manages conversation threads per chat.

*Pont* is French for *bridge* — because that's exactly what this is.

## Quick Start

### Option 1: Docker (easiest)

```bash
docker compose up -d

# Open http://localhost:3099
# Enter your PromptQL token and phone number
# Scan the QR code with WhatsApp — done
```

### Option 2: Run directly

```bash
npm install
npm start

# Open http://localhost:3099 and follow the setup wizard
```

### Option 3: Server (24/7)

```bash
# On your server
npm install
npm install -g pm2

pm2 start npm --name pontql -- start
pm2 save

# Access dashboard remotely
ssh -L 3099:localhost:3099 user@your-server
# Then open http://localhost:3099
```

All setup happens through the web dashboard — no need to edit config files. Just open http://localhost:3099, enter your token and phone number, scan the QR code, and send a message.

## Requirements

**Docker:** Just Docker. Everything else is included.

**Without Docker:**
- Node.js 18+
- Chrome or Chromium (auto-detected, or set `CHROME_PATH`)

**Both need:**
- A PromptQL user token (`pql_ut_...`)

## Configuration

Everything is configured through the dashboard at `http://localhost:3099`. On first run, you'll be prompted for:

- **PromptQL token** (`pql_ut_...`) — get one from Settings > Access Tokens in the PromptQL console
- **Phone number** — your number with country code, no `+`

The project is auto-detected from your token. All other settings (rooms, access control, wake word) can be changed from the dashboard after setup.

You can also pre-configure via `.env` if you prefer:

| Variable | Required | Description |
|----------|----------|-------------|
| `PROMPTQL_TOKEN` | Yes | Your PromptQL user token (`pql_ut_...`) |
| `MY_NUMBER` | Yes | Your phone number (country code, no +) |

### Access Control

Three independent axes — combine freely:

| Axis | Variable | Options |
|------|----------|---------|
| **Where** | `LISTEN_DM` | `true` (default) / `false` |
| | `LISTEN_GROUPS` | empty (none), `*` (all), or `group1,group2` |
| **Who** | `WHO` | `me` (default), `contacts`, `anyone` |
| | `ALLOWED_CONTACTS` | phone numbers (when `WHO=contacts`) |
| **Trigger** | `WAKE_WORD` | empty (always respond) or a word like `pql` |

**Example: Personal assistant** — `WHO=me` (default). Only you can use it.

**Example: Group bot** — `LISTEN_GROUPS=my-team`, `WHO=anyone`, `WAKE_WORD=pql`. Anyone in the group can ask questions by starting with "pql".

**Example: Shared with friends** — `WHO=contacts`, `ALLOWED_CONTACTS=61412345678,44771234567`. Only listed numbers.

## WhatsApp Commands

| Command | Description |
|---------|-------------|
| `/new` | Start a new conversation thread |
| `/threads` | List recent threads |
| `/resume <n>` | Resume thread #n |
| `/rooms` | List available PromptQL rooms |
| `/room <name>` | Switch to a room |
| `/teach <text>` | Submit knowledge to the wiki |
| `/status` | Show current bridge state |
| `/help` | Show all commands |

## Artifacts

PromptQL artifacts are automatically converted for WhatsApp:

- **Tables** — rendered as styled images
- **Charts / Dashboards** — React visualizations screenshot with data injection
- **Text** — formatted for WhatsApp (markdown to bold/italic)
- **Files** — sent as WhatsApp attachments (PDFs, CSVs, images)

## Troubleshooting

| Problem | Fix |
|---------|-----|
| QR code not showing | Make sure Chrome is installed, or set `CHROME_PATH` |
| Stuck on "authenticating" | Restart — the bridge auto-restarts after 3 min |
| Bot not responding | Check if your message includes the wake word (if set) |
| Session expired | Run `npm run reset` then restart and re-scan QR |
| Docker Chrome crashes | Increase `shm_size` in docker-compose.yml |

## How It Works

```
WhatsApp <-> whatsapp-web.js (headless Chrome)
                |
            index.js — message routing, access control, resilience
                |
            message-handler.js — thread management, event polling
                |
            promptql-client.js — PromptQL GraphQL API
                |
            event-parser.js — V3 event stream parsing
                |
            artifact-handler.js — render artifacts as images
```

### Resilience

The bridge self-heals automatically:

- Heartbeat checks client health every 2 minutes
- Dead Puppeteer contexts trigger immediate restart
- Stuck authentication times out after 3 minutes
- Cache cleared on every startup to prevent stale sync
- pm2 / Docker `restart: unless-stopped` brings it back

## Development

```bash
npm run dev        # Watch mode — auto-restart on file changes
npm run reset      # Clear session (re-scan QR needed)
npm run restart    # Clear cache only (keep session)
```

## License

MIT
