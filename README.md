<p align="right">
  <a href="./README.zh-CN.md"><strong>简体中文</strong></a>
</p>

<div align="center">

<img src="./public/icons/rai-app-icon.svg" width="92" alt="RAI logo">

# RAI

### Human-centered conversational AI for thinking, researching, and building ideas together.

RAI brings adaptive model routing, web-grounded answers, multi-model research,
visual ChatFlow canvases, and contextual explanations into one calm, responsive workspace.

<p>
  <a href="https://rai.rick.sarl"><strong>Try RAI live →</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/Rick-953/RAI/releases/latest">Latest release</a>
  &nbsp;·&nbsp;
  <a href="#self-hosting">Self-host</a>
</p>

[![Latest release](https://img.shields.io/github/v/release/Rick-953/RAI?display_name=tag&sort=semver&style=flat-square&color=F2B84B)](https://github.com/Rick-953/RAI/releases/latest)
[![Node.js 20.17+](https://img.shields.io/badge/Node.js-20.17%2B-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![SQLite](https://img.shields.io/badge/SQLite-3-003B57?style=flat-square&logo=sqlite&logoColor=white)](https://sqlite.org/)
[![Source available](https://img.shields.io/badge/License-Personal%20%26%20Non--Commercial-F2B84B?style=flat-square)](./LICENSE)

</div>

![RAI home screen with writing, finance, code, translation, and smart model controls](./docs/readme/rai-home.jpg)

<p align="center"><em>Ask naturally, choose the depth, and keep the interaction under your control.</em></p>

## Why RAI

RAI is a source-available conversational AI application designed around **human–AI interaction**, not just access to another model endpoint.

- Start in **Smart Model** mode or choose a model yourself.
- Decide when RAI should answer quickly, reason more deeply, search the web, or run research.
- Edit, quote, regenerate, interrupt, and continue without losing the thread.
- Move from a conversation into a visual canvas without changing tools.
- Highlight unfamiliar language and receive an explanation exactly where you encountered it.
- Use the same responsive interface in English, Simplified Chinese, or Traditional Chinese.

The official hosted instance is available at **[rai.rick.sarl](https://rai.rick.sarl)**, so you can experience RAI before deciding whether to self-host it.

## Core experiences

### Adaptive conversation

Let RAI route across the models available to your account, or directly control the model, reasoning mode, and web access. Streaming responses can be stopped, edited, quoted, regenerated, or interrupted with a follow-up while generation is still in progress.

### Research with multiple perspectives

Fast and Deep Research can plan a task, run up to four specialist sub-agents in parallel, synthesize their findings, and verify the result. Tavily-backed web search adds current sources when freshness matters, while the finance tool can retrieve market quotes and history.

### ChatFlow: conversation becomes structure

ChatFlow places a persistent conversation beside a node-based canvas. Drag ideas into the canvas, connect them, ask AI to reorganize or decompose the graph, review proposed changes before applying them, undo edits, auto-layout the result, and export to PNG, SVG, Mermaid, or JSON.

### Explain anything in place

Select a term, sentence, or formula inside a message, ChatFlow, or another explanation card. RAI streams a focused explanation into a lightweight card that can be moved, minimized, continued as a branch, and found later in an account-synced explanation tree.

### Rich answers on one surface

RAI renders Markdown, syntax-highlighted code, KaTeX mathematics, Mermaid diagrams, images, and cited web results. It can extract context from modern PDF, DOCX, XLSX/CSV, PPTX, text, and code files; compatible multimodal models can also receive images.

### Accounts, memory, and security

The server includes email-based accounts, bcrypt password storage, JWT sessions, Authenticator 2FA, Passkeys/WebAuthn, optional long-term memory, temporary chats, quotas, announcements, and an administration console. Feature and model availability remains under the instance administrator's control.

## See RAI in action

### Choose how RAI should work

![RAI fast, think, research, and model-selection menu](./docs/readme/rai-modes.jpg)

<p align="center"><em>Move between Fast, Think, Research, and direct model selection without leaving the composer.</em></p>

### Turn dialogue into a visual workspace

![RAI ChatFlow node canvas](./docs/readme/rai-chatflow.jpg)

<p align="center"><em>ChatFlow keeps a structured, editable canvas beside the conversation.</em></p>

### Build a tree of explanations

![RAI explanation history with a nested explanation card](./docs/readme/rai-explanations.jpg)

<p align="center"><em>Selected text and its follow-up explanations live in a searchable tree, separate from chat history.</em></p>

## Capabilities at a glance

| Area | Highlights |
| --- | --- |
| Conversation | Streaming, stop, edit, quote, regenerate, feedback, mid-generation interjection, synchronized history, temporary chats |
| Models | Smart routing plus configurable DeepSeek, Qwen, Kimi, OpenRouter, Gemini, Claude, Nemotron, Mimo Code, and Gemma routes |
| Research | Web search with sources, Fast/Deep multi-agent research, synthesis and verification, Yahoo Finance data |
| ChatFlow | Persistent canvases, reviewed AI changes, undo, semantic links, auto-layout, PNG/SVG/Mermaid/JSON export |
| Understanding | Selection explanation cards, nested follow-ups, drag/minimize, searchable tree history |
| Content | Markdown, code highlighting, KaTeX, Mermaid, images, and modern document extraction |
| Personalization | Optional long-term memory, light/dark/system themes, three interface languages, notifications |
| Access & operations | Email auth, password reset, TOTP 2FA, Passkeys, quotas, points/membership, admin controls and statistics |

> Model, reasoning, search, research, image, and email capabilities depend on the providers configured by the instance administrator.

## Try the hosted version

Open **[https://rai.rick.sarl](https://rai.rick.sarl)** in a modern browser. The hosted site is the fastest way to see RAI's current interaction design and feature set.

## Self-hosting

### Requirements

- Linux, macOS, or another environment supported by Node.js
- **Node.js 20.17.0 or newer** and npm
- Writable persistent storage for `ai_data.db*`, `uploads/`, `avatars/`, and generated images
- `unzip` for XLSX/PPTX extraction; build tools and Python may be needed if a native dependency has no prebuilt binary for your platform
- At least one configured chat provider for useful AI responses
- HTTPS and a real domain for production Passkeys

RAI currently targets a **single Node.js process**. Its SQLite database and some in-memory coordination are not designed for PM2 cluster mode or horizontal multi-instance deployment.

### Quick start

```bash
git clone https://github.com/Rick-953/RAI.git
cd RAI
npm ci --omit=dev

cp .env.example .env
# Edit .env: replace every placeholder and all official RAI domain values.

npm run check
node --env-file=.env server.js
```

Then open `http://127.0.0.1:3009` or verify the service with:

```bash
curl -fsS http://127.0.0.1:3009/api/version
```

RAI reads **process environment variables**; the server does not load `.env` by itself. Use `node --env-file=.env server.js`, or let systemd, PM2, or another process manager inject the environment. Plain `npm start` is correct only when those variables are already present in the process environment.

### Required secrets

Startup requires these values:

- `JWT_SECRET` — at least 32 characters
- `ADMIN_JWT_SECRET` — at least 32 characters and different from `JWT_SECRET`
- `ADMIN_PASSWORD_HASH` — a bcrypt hash, not a plaintext password

Generate suitable values locally:

```bash
openssl rand -hex 32
openssl rand -hex 32
node -e 'require("bcrypt").hash(process.argv[1], 12).then(console.log)' \
  'replace-with-a-strong-admin-password'
```

Paste the two random values and the resulting bcrypt hash into `.env`. Never commit that file.

For local development, replace the official domain defaults in `.env.example` with your local origin, set `TRUST_PROXY=0`, and set `RAI_DEFAULT_DOMAIN_NOTICE_ENABLED=false`. For production, configure the exact public origin and keep Passkey relying-party settings aligned with that domain.

### Provider configuration

| Variable | Enables |
| --- | --- |
| `DEEPSEEK_API_KEY` | DeepSeek chat and reasoning routes |
| `SILICONFLOW_API_KEY` | Configured Qwen/Kimi routes and image generation |
| `OPENROUTER_API_KEY` | OpenRouter-backed model routes |
| `GOOGLE_GEMINI_API_KEY` | Gemini routes |
| `TAVILY_API_KEY` | Web search and cited current information |
| `RESEND_API_KEY` + `RESEND_FROM_EMAIL` | Registration verification, email-code login, and password reset |
| `ZTX6D_APP_ID` + `ZTX6D_APP_KEY` | Optional ZTX6D sign-in |

You do not need every provider, but each advertised capability requires its matching service. Review upstream billing, quotas, data policies, and model availability before opening registration publicly.

## Production deployment

### 1. Prepare the application

Create an unprivileged `rai` service account and give it ownership of a dedicated application directory such as `/opt/rai`. Then install the application as that account:

```bash
sudo -u rai git clone https://github.com/Rick-953/RAI.git /opt/rai
sudo -u rai npm ci --omit=dev --prefix /opt/rai
sudo -u rai cp /opt/rai/.env.example /opt/rai/.env
sudo chmod 600 /opt/rai/.env
```

Edit `.env` and set at least:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3009
TRUST_PROXY=1
PUBLIC_BASE_URL=https://rai.example.com
CORS_ORIGINS=https://rai.example.com
RAI_PASSKEY_ALLOW_LOCALHOST=false
RAI_DEFAULT_DOMAIN_NOTICE_ENABLED=false
```

Also replace the JWT secrets, administrator hash, provider keys, email settings, callbacks, HTTP referer, and runtime-report path. Use `TRUST_PROXY=1` only when requests reach RAI through exactly one trusted proxy hop.

### 2. Run it with systemd

Create `/etc/systemd/system/rai.service` and replace the user, group, Node path, and application path for your server:

```ini
[Unit]
Description=RAI conversational AI
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=rai
Group=rai
WorkingDirectory=/opt/rai
ExecStart=/usr/bin/node --env-file=/opt/rai/.env /opt/rai/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Find the correct Node path with `command -v node`, then enable the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rai
sudo systemctl status rai
```

PM2 is also suitable in **fork mode** when it injects the complete environment. Do not use cluster mode for this application.

### 3. Put HTTPS in front of RAI

An Nginx location should preserve proxy headers, allow uploads, and disable buffering for streamed responses:

```nginx
server {
    listen 443 ssl http2;
    server_name rai.example.com;

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:3009;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        add_header X-Accel-Buffering no;
    }
}
```

Use Certbot, Caddy, or another trusted ACME client to provision TLS. Passkeys require HTTPS and an exact allowed origin outside localhost development.

### 4. Persist, back up, and verify

Persist and back up these paths before every upgrade:

- `ai_data.db`, `ai_data.db-wal`, and `ai_data.db-shm`
- `uploads/` and generated images
- `avatars/`
- `.env` and any external runtime report

Use a SQLite-aware online backup while the service is live, or stop the process before copying the database files. Never deploy a new release over secrets, databases, uploads, avatars, or user data.

After deployment:

```bash
cd /opt/rai
npm run check
curl -fsS http://127.0.0.1:3009/api/version
curl -fsS https://rai.example.com/api/version
```

For a source checkout with the complete test environment, run the broader regression gate:

```bash
npm run test:formal-audit
```

## Security and data notes

- Never commit `.env`, provider keys, JWT secrets, administrator credentials, databases, uploads, avatars, logs, or runtime reports.
- Self-hosting controls the RAI server and database, but prompts and files may still be sent to the AI, search, email, finance, and image providers you configure.
- Bind Node to localhost behind a trusted HTTPS reverse proxy, keep CORS narrow, and enable `TRUST_PROXY` only for a known proxy topology.
- User uploads are access-controlled; avatars and generated images use static delivery paths. Review that exposure for your deployment.
- Configure request limits, upload quotas, provider budgets, and registration policy before serving untrusted users.
- Back up SQLite together with its WAL state and test restoration—not just backup creation.

## Releases and development checks

The README intentionally contains no changelog. Current release notes, migration details, and downloadable artifacts live on the **[GitHub Releases](https://github.com/Rick-953/RAI/releases)** page.

Useful local checks:

```bash
npm run check
npm run test:formal-audit
npm audit --omit=dev
```

Focused issues and pull requests are welcome. Please keep real secrets, user data, databases, and generated runtime artifacts out of commits and bug reports.

## License

RAI's source is publicly available for personal, educational, research, evaluation, and other non-commercial use. Commercial use—including company-internal deployment, paid hosting, SaaS, consulting, and commercial redistribution—requires prior written permission from the maintainer.

See **[LICENSE](./LICENSE)** for the complete terms. This is a source-available personal and non-commercial license, not an OSI-approved open-source license.
