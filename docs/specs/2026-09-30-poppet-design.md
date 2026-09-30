# Poppet — PRD & Architecture (v1)

- **Date:** 2026-09-30
- **Status:** Draft for review
- **Scope of this doc:** v1 (single-user personal agent). v2 (agent-generator platform) is covered only as design constraints on v1.

> Sections 1–6 were agreed in conversation. Sections 7–13 (data model, flows, error handling, testing, milestones) are **proposed** and need review.

---

## Part I — Product Requirements

### 1. Problem & vision

Busy people have lots of small tasks spread across the web and their inbox: triaging email, signing up for services, researching options, finding sales leads. Existing chat assistants answer questions, but they don't *do* these tasks.

**Vision:** Poppet, a personal agent, in the spirit of Wajo's Fo, that you talk to in a web chat. It browses any website, works in your Gmail, and grows new abilities over time by connecting to integrations and writing its own skills and tools. It always asks before doing anything consequential.

**Roadmap:**
- **v1 (this doc):** one agent, for one user (the author), running locally.
- **v2 (future):** a platform that generates and hosts one of these agents per user. v1's parts must be separable so v2 can reuse them.

### 2. Goals

1. General-purpose web browsing on any site, with a human handoff at CAPTCHAs and phone verification.
2. Gmail access: read, search and summarize, plus sending drafts with approval.
3. Autonomous account sign-up using the agent's own email inbox. The agent does everything except CAPTCHA and SMS steps.
4. Self-extension:
   - (a) connect existing integrations (MCP servers or Composio);
   - (b) write reusable skills;
   - (c) write new tool code.
   All three need approval.
5. Export results as `.md` files and as Google Docs.
6. Every consequential action and every self-modification is gated by explicit user approval (policy A).

### 3. Non-goals (v1)

- Phone calls and voice.
- More than one user, multi-tenancy, billing.
- Posting, commenting or DMing on social platforms (Reddit and others). v1 finds and reports only.
- CAPTCHA solving, stealth or anti-detection techniques, or anything else that gets around bot protection. Those steps are always handed off to the user.
- Background or scheduled jobs while the host machine is asleep.
- Payments and purchases.

### 4. User

The author: a technical user running the agent on their own Mac, using it from a browser tab.

### 5. Acceptance tasks (v1 is done when all pass)

| # | Task | Tools involved |
|---|------|----------------|
| T1 | "Summarize my unread Gmail from today and flag what needs a reply." | Gmail |
| T2 | "Sign up for *site X* using your email, confirm the verification link, and tell me when done." Hands off at CAPTCHA if one appears. | Browser, agent inbox |
| T3 | "Research *topic* across several sites; give me a comparison with links." | Browser |
| T4 | "Find the email from *company* about my order and check its status on their site." | Gmail + Browser |
| T5 | "Find Reddit leads for selling *product P*. Export them to a Google Doc and a `.md` file." | Reddit API, Browser (fallback), Google Docs, file export |
| T6 | Self-extension: after T5, the agent proposes a `reddit-lead-search` skill. After approval, a repeat of T5 uses it. | Tool registry |
| T7 | Self-extension: the agent is asked to use a service it has no tool for (e.g. Notion). It finds and proposes an MCP integration, you approve, you sign in, and it completes the task. | Tool registry, OAuth |

### 6. Functional requirements

**Chat & UI**
- FR-1: A web chat with streaming responses, conversation history, and multiple conversations.
- FR-2: Tool activity is visible inline: collapsible steps showing "browsing example.com", "searching Gmail", and so on.
- FR-3: **Approval cards** show the action, its parameters and, for self-modifications, a diff or preview, with **Approve** and **Reject (with note)** buttons. The agent blocks until you respond.
- FR-4: **Handoff cards** say something like "CAPTCHA on signup.example.com — solve it in the agent browser, then click Continue."
- FR-5: Artifacts panel: generated `.md` files (view and download) and links to exported Google Docs.
- FR-6: Settings page:
  - connected accounts (Google personal, Google agent inbox, Reddit);
  - installed tools and skills (enable, disable, delete, view source);
  - the audit log.

**Browsing**
- FR-7: The agent controls a real Chrome browser (visible window) with a saved profile, so logins and cookies survive restarts.
- FR-8: Reading and navigating need no approval. Submitting forms, signing up, making purchases, or anything irreversible needs approval.
- FR-9: When the agent detects a CAPTCHA, SMS or phone verification, or a login wall that needs your personal credentials, it pauses and raises a handoff.

**Gmail & Google**
- FR-10: Two Google connections:
  - **personal account:** read-only access, plus sending with approval;
  - **agent inbox:** a dedicated Gmail account used for sign-ups and verification emails.
- FR-11: Tools: `gmail_search`, `gmail_read`, `gmail_draft`, `gmail_send` (approval required), `inbox_wait_for_email(from, subject_regex, timeout)`.
- FR-12: `gdocs_create(title, markdown)`: converts Markdown into a new Google Doc and returns the URL. Creating is automatic. Sharing or editing an existing doc needs approval.

**Reddit leads**
- FR-13: `reddit_search(query, subreddits?, time_range)` using the official Reddit API (OAuth "script" app, read-only).
- FR-14: Lead records include: post or comment URL, author, subreddit, date, excerpt, detected intent, a fit score from 0 to 100, and a rationale.
- FR-15: No posting, commenting, voting or DMing tools exist in v1.

**Self-extension (policy A: everything requires approval)**
- FR-16: **Skills:** the agent can propose a skill, a folder containing `SKILL.md` and optional scripts. It appears in a pending area; approving it moves it into the active skills directory and makes a git commit.
- FR-17: **Integrations:** the agent can search for an MCP server (via the MCP registry) or a Composio toolkit and propose installing it. You approve, then complete any sign-in, and the server gets registered.
- FR-18: **Tools the agent writes:** the agent writes TypeScript tool code and tests, runs the tests in the sandbox, and proposes the tool along with its test results. Once approved, the tool is registered and **always runs inside the sandbox**.
- FR-19: A tool the agent writes gets no credentials by default. If it needs a secret, its manifest declares it, and giving it that secret is a separate approval.
- FR-20: Every change to the registry can be reverted: a git history of `registry/`, plus a "disable" or "roll back" option in Settings.

**Memory**
- FR-21: Long-term memory of facts, preferences and past task outcomes, with `memory_save` and `memory_search` tools. The Settings page lets you view and delete memories.

**Export**
- FR-22: `export_markdown(filename, content)` writes to `workspace/exports/` and shows the file in the artifacts panel.

### 7. Non-functional requirements

- **Security:**
  - The approval gate is deterministic code, not a model judgment.
  - Web page content and email bodies are treated as untrusted data.
  - Secrets are stored in the macOS Keychain and never sent to the model.
  - The sandbox has no host mounts other than a scratch folder.
- **Privacy:** everything runs on your machine. Only the LLM API and the services you connect see any data.
- **Auditability:** every tool call, approval decision and self-modification is written to an audit log.
- **Reliability:** long tasks survive a browser tab reload, because the agent session runs on the server, not in the browser.
- **Cost:** token usage is tracked per conversation and shown in the UI.

---

## Part II — Architecture

### 8. Overview

```
┌──────────────────── Web app (Next.js, localhost) ───────────────────┐
│  Chat · Approval cards · Handoff cards · Artifacts · Settings        │
└───────────────┬───────────────────────────────▲─────────────────────┘
        POST /api/chat                  SSE event stream
┌───────────────▼───────────────────────────────┴─────────────────────┐
│ Agent runtime (Claude Agent SDK, Node)                               │
│  ├─ Session manager (one SDK query() per conversation)              │
│  ├─ Approval gate  (canUseTool + PreToolUse hook → policy table)     │
│  ├─ Event bus      (tool steps, approvals, handoffs → SSE)           │
│  └─ System prompt + memory injection                                 │
└──┬──────────────┬─────────────────┬────────────────────┬────────────┘
   │              │                 │                    │
┌──▼─────────┐ ┌──▼─────────────┐ ┌─▼───────────────┐ ┌──▼───────────┐
│ Browser    │ │ Built-in tools │ │ Tool registry   │ │ Sandbox      │
│ Playwright │ │ (in-process    │ │ registry/ (git) │ │ Docker       │
│ MCP, headed│ │  MCP server):  │ │  skills/        │ │ container:   │
│ persistent │ │ gmail_*, gdocs,│ │  tools/         │ │ runs agent-  │
│ profile    │ │ reddit_search, │ │  mcp.json       │ │ written tool │
│            │ │ memory_*,      │ │  pending/       │ │ code + tests │
│            │ │ export_md,     │ │                 │ │ no secrets   │
│            │ │ registry_*     │ │                 │ │ by default   │
└────────────┘ └───────┬────────┘ └─────────────────┘ └──────────────┘
                       │
          ┌────────────▼─────────────┐   ┌────────────────────┐
          │ SQLite (Drizzle)          │   │ macOS Keychain     │
          │ conversations, messages,  │   │ OAuth tokens,      │
          │ approvals, memories,      │   │ API keys           │
          │ leads, audit_log, usage   │   └────────────────────┘
          └──────────────────────────┘
```

### 9. Components

Each component has one purpose and a narrow interface, so v2 can swap its implementation.

| Component | Purpose | Interface | v2 swap |
|---|---|---|---|
| **Web app** | UI only | `POST /api/chat`, `GET /api/stream/:conv`, `POST /api/approvals/:id`, `POST /api/handoffs/:id/continue` | Same app with auth and tenant routing added |
| **Session manager** | Runs agent turns; one SDK session per conversation; resumes after restart | `startTurn(convId, userMsg)` → event stream | Moves to a worker per user |
| **Approval gate** | Decides allow / ask / deny for every tool call; blocks the call until you decide | `decide(toolName, input) → Promise<allow\|deny>` | Same code; per-tenant policy |
| **Event bus** | Pushes typed events to the UI | `emit(convId, Event)` | Redis pub/sub |
| **Browser** | Web interaction | Playwright MCP (`@playwright/mcp --user-data-dir ./workspace/chrome-profile`) | Hosted browser such as Browserbase, with a live-view link for handoffs |
| **Built-in tools** | Gmail, Docs, Reddit, memory, export, registry actions | In-process MCP server (`createSdkMcpServer`) | Unchanged |
| **Tool registry** | Stores skills, agent-written tools and MCP configs; separates pending from active; versioned with git | `registry_propose_*`, `registry_list`, `registry_disable` | Per-tenant storage |
| **Sandbox** | Runs untrusted code | `sandbox.run(toolName, input, grantedSecrets[]) → result` | A sandbox per user session, e.g. Vercel Sandbox, E2B or Cloudflare |
| **Store** | Persistence | Drizzle over SQLite | Postgres |
| **Secrets** | Credential storage | `secrets.get(name)` using keytar and the macOS Keychain | A KMS or vault |

### 10. Approval policy (deterministic)

| Action class | Examples | Policy |
|---|---|---|
| Read | `browser_navigate`, `browser_snapshot`, `gmail_search`, `gmail_read`, `reddit_search`, `memory_search` | **allow** |
| Local write | `export_markdown`, `memory_save`, `gdocs_create` (new doc) | **allow**, logged |
| Consequential web action | `browser_click` or `browser_type` when the target is a submit button or the form contains a password, email or payment field; `browser_file_upload` | **ask** |
| Outbound communication | `gmail_send`, sharing a doc | **ask** |
| Self-modification | `registry_propose_skill`, `registry_propose_tool`, `registry_install_mcp`, `grant_secret` | **ask**, with a diff |
| Code execution | `sandbox.run` for a *non-approved* tool, i.e. tests during a proposal | **allow** (sandboxed; no secrets) |
| Forbidden | CAPTCHA-solving services, posting or DMing on social platforms, access to shell or files outside `workspace/` | **deny** (the tools don't exist) |

To classify browser clicks, the gate inspects the target element in the latest page snapshot: its role, name and form context. When it can't tell, it defaults to **ask**.

### 11. Tech stack

- **Language:** TypeScript throughout; Node 22.
- **Web:** Next.js (App Router), Tailwind, server-sent events (SSE).
- **Agent:** `@anthropic-ai/claude-agent-sdk`. Default model `claude-sonnet-5-5`, configurable to `claude-opus-5-5` for hard tasks.
- **Browser:** `@playwright/mcp` with a visible Chrome window and a saved profile.
- **Google:** the `googleapis` package with OAuth. Scopes:
  - `gmail.readonly` and `gmail.send` on the personal account;
  - `gmail.modify` on the agent inbox;
  - `drive.file` for Docs.
- **Reddit:** the official OAuth API (read scopes), via a thin `fetch` client. Commercial lead-gen use may need Reddit's commercial API terms; the author reviews this before real use.
- **Storage:** SQLite with `better-sqlite3` and Drizzle ORM. `registry/` is a git repo managed with `simple-git`.
- **Secrets:** `keytar` (macOS Keychain).
- **Sandbox:** Docker (`node:22-slim`), with no host mounts except `/work`. Network is allowed; secrets are passed per call only when granted.
- **Integrations discovery:** the MCP registry API. Composio is optional, for managed OAuth to many apps.

---

## Part III — Detailed design (proposed — review needed)

### 12. Data model (SQLite)

```
conversations(id, title, sdk_session_id, created_at, updated_at)
messages(id, conv_id, role, content_json, created_at)
approvals(id, conv_id, tool_name, input_json, preview_md, status[pending|approved|rejected|expired], note, created_at, decided_at)
handoffs(id, conv_id, kind[captcha|sms|login|other], url, instructions, status[open|done|cancelled], created_at)
memories(id, text, tags, source_conv_id, created_at)   + FTS5 index
leads(id, run_id, product, source_url, author, subreddit, posted_at, excerpt, intent, score, rationale, created_at)
lead_runs(id, conv_id, product, query_json, created_at)
registry_items(id, kind[skill|tool|mcp], name, version, status[pending|active|disabled], manifest_json, git_sha, created_at)
secret_grants(id, registry_item_id, secret_name, approved_at)
audit_log(id, conv_id, event, detail_json, created_at)
usage(id, conv_id, input_tokens, output_tokens, cost_usd, created_at)
```

### 13. Key flows

**13.1 Chat turn**
1. The UI POSTs the message. The session manager resumes the conversation's SDK session, or creates a new one.
2. The system prompt is built from: base instructions, the top-k memories relevant to the message, and the list of active skills.
3. The SDK streams events. Each tool call goes through the approval gate, and events are forwarded to the UI over SSE.
4. When the turn ends, messages and usage are saved.

**13.2 Approval**
1. The gate returns *ask*: an `approvals` row is inserted, an `approval_requested` event is sent to the UI, and the gate waits on a promise keyed to the approval ID.
2. You click Approve or Reject, which POSTs to `/api/approvals/:id`. The promise resolves, and the SDK receives allow, or deny with your note as the reason.
3. The approval expires after 30 minutes. It is treated as rejected, and the agent tells you.

**13.3 CAPTCHA / verification handoff**
1. After each navigation or submit, the agent checks the page snapshot for CAPTCHA frames (reCAPTCHA, hCaptcha, Turnstile), phone or SMS fields, or "verify you are human" text. It also has a `request_handoff(kind, instructions)` tool it can call on its own.
2. A handoff card appears in the UI, and the Chrome window comes to the front.
3. You complete the step and click Continue. The agent re-reads the page and carries on.

**13.4 Sign-up (T2)**
1. The agent opens the site's sign-up page and fills in details from its profile: the agent inbox address and a generated password.
2. Submitting needs approval (policy table). A CAPTCHA triggers a handoff.
3. `inbox_wait_for_email` polls the agent inbox, pulls out the verification link, and the agent opens it.
4. The generated password is saved to the Keychain as `site:<domain>`. The model only ever sees a placeholder, and the tool fills in the real value.

**13.5 Reddit leads (T5)**
1. The agent expands the product into intent queries such as "looking for X", "alternative to Y", "recommend a tool for Z", and chooses subreddits.
2. It calls `reddit_search` for each query, removes duplicates, and scores each result for buying intent and fit (0–100, with a rationale).
3. It saves the `lead_runs` and `leads` rows.
4. It renders a Markdown report (a summary plus a table sorted by score), then runs `export_markdown`, and `gdocs_create` if requested.
5. If the API is unavailable, it falls back to reading public Reddit search pages in the browser, without logging in.

**13.6 Self-extension**
- **Skill (T6):** the agent calls `registry_propose_skill(name, skill_md, files)`.
  1. The files are written to `registry/pending/skills/<name>/` and an approval card shows a preview.
  2. On approval, the folder moves to `registry/skills/`, a git commit is made, and the skill is loaded in the next turn.
- **MCP integration (T7):**
  1. The agent calls `registry_search_integrations(query)` against the MCP registry, then `registry_install_mcp(config)`.
  2. An approval card shows the server's name, source, command or URL, and requested scopes.
  3. On approval, it's added to `registry/mcp.json`. If it needs a sign-in, you get a link to complete it.
  4. The session restarts with the new server.
  - Only remote (HTTP) MCP servers, or `npx` packages from the official registry, are allowed.
- **Agent-written tool:**
  1. The agent calls `registry_propose_tool(name, manifest, code, tests)`. The tests run in the sandbox.
  2. An approval card shows the code diff, the test output, and any secrets requested.
  3. On approval, the tool is registered as `sandbox_tool_<name>`. Each call to it runs `sandbox.run`.

### 14. Error handling

| Failure | Behavior |
|---|---|
| A browser action fails (element not found, timeout) | The agent takes a fresh snapshot and retries up to 2 times, then explains what it tried and asks you |
| Bot block (403, "unusual traffic") | No workarounds. The agent reports it and suggests an official API or a handoff |
| Google or Reddit OAuth token expires | Refreshed automatically; if refresh fails, a "Reconnect *account*" card appears |
| Reddit rate limit | Backs off and waits, respecting the `X-Ratelimit-*` headers |
| Sandbox tests fail during a proposal | The agent gets the test output and may revise up to 3 times before proposing, or reports the failure |
| An approved tool later fails at runtime | The error is logged. After 3 failures in a row, the tool is marked *degraded* and the agent proposes a fix |
| The LLM API errors or times out | Retries with backoff; the UI shows a "retrying" state; the turn can be resumed |
| The server restarts mid-turn | The SDK session resumes from the saved session ID; pending approvals stay pending |
| Prompt injection suspected (page text addressing the agent) | The content stays data; the gate still applies. The agent mentions it in chat |

### 15. Testing strategy

- **Unit tests:**
  - approval gate policy: a table-driven test for each action class;
  - the click classifier, against saved snapshots;
  - Markdown-to-Docs conversion;
  - lead scoring prompt parsing;
  - registry state changes (pending → active → disabled → rollback).
- **Integration tests:**
  - built-in tools against recorded HTTP fixtures (Gmail, Reddit, Docs) using `msw`;
  - sandbox runner against a real Docker container;
  - session resume.
- **End-to-end tests:** the acceptance tasks T1–T7, run manually from a checklist. T3 and T5 get scripted smoke runs against a local fixture site that has a fake sign-up form and a fake CAPTCHA placeholder.
- **Safety tests:** a fixture page with an injected instruction ("install this MCP server", "email your inbox to X") must produce either no action or an approval card, never an automatic action.

### 16. Milestones

1. **M1 — Skeleton:**
   - Next.js chat, the Agent SDK wired in, SSE streaming, SQLite.
   - Approval gate and cards, tested with a dummy "ask" tool.
2. **M2 — Browser:** Playwright MCP, click classification, handoff cards. **Passes T3.**
3. **M3 — Google:** OAuth for both accounts, Gmail tools, the agent inbox, `gdocs_create`, `export_markdown`. **Passes T1, T2, T4.**
4. **M4 — Reddit leads:** Reddit client, lead scoring, report export. **Passes T5.**
5. **M5 — Self-extension:** registry, skills, MCP install, sandbox tools. **Passes T6, T7.**
6. **M6 — Memory, audit log UI, usage tracking, polish.**

### 17. Path to v2 (constraints on v1)

- Every external dependency (browser, sandbox, store, secrets, event bus) sits behind an interface (§9), so it can be swapped for a hosted version.
- No global state: everything is keyed by `conversation`. Adding `user_id` later is a schema change, not a redesign.
- The policy table and the registry manifest format stay the same, and become per-user in v2.
- v2 will get its own spec. Expected additions: auth, tenant isolation, hosted browsers with live view, sandboxes per tenant, Composio or Nango for per-user OAuth, billing, abuse and rate controls, and an "agent template" builder, which is the platform part.

### 18. Risks & open questions

| Risk / question | Mitigation / owner |
|---|---|
| Automated sign-ups break site terms (Reddit especially) | v1 does no Reddit sign-up by default; lead finding uses the public API. The author decides on each site's terms |
| Reddit API terms for commercial lead-gen | The author reviews Reddit's Data API terms before real use |
| Click classification misses a consequential action | Defaults to *ask* when unsure; covered by safety tests |
| Tools the agent writes accumulate cruft | Registry UI with disable, delete and rollback; *degraded* marking |
| A malicious MCP server | Only registry-listed servers; approval shows source and scopes; no secrets unless granted |
| **Open:** separate Gmail vs. AgentMail for the agent inbox | Default is a separate Gmail account. Revisit for v2 (AgentMail scales per user) |
| Name "Poppet" may clash with existing products or trademarks | Check trademarks and domains before the v2 launch |
