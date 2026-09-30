# Poppet

A personal agent you talk to in a web chat. It browses any website in a real Chrome window, works in your Gmail, finds Reddit leads, exports results to Markdown and Google Docs, and grows new abilities by installing MCP integrations and writing its own skills and tools. Every consequential action and every self-modification waits for your approval.

This repository implements **v1** of the [Poppet PRD](docs/specs/2026-09-30-poppet-design.md): single user, running locally.

## Quick start

Requirements: Node 22, Docker (for agent-written tools), Google Chrome.

```bash
npm install
cp .env.example .env.local   # add your Anthropic, Google and Reddit credentials
npm run dev                  # http://localhost:3000 (bound to 127.0.0.1 only)
```

Then open **Settings** and connect:

- **Google (personal)**: your own account. Poppet can read and search it and write drafts; sending needs your approval.
- **Google (agent inbox)**: a separate Gmail account that Poppet uses for sign-ups and verification emails.

In the Google Cloud console, create an OAuth client of type _Web application_ with the redirect URI `http://localhost:3000/api/oauth/google/callback`. Enable the Gmail API and the Drive API, and add both accounts as test users.

For Reddit, create a read-only _script_ app and set `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET`. Review Reddit's Data API terms before using it for commercial lead generation.

## What's inside

```
src/
  app/                      Next.js App Router: chat UI, settings, API routes
  components/               Chat timeline, approval / handoff / sign-in cards, artifacts, settings
  proxy.ts                  Host allowlist (blocks DNS rebinding)
  server/
    agent/session.ts        Session manager: one Agent SDK query() per turn, resumes the SDK session
    agent/prompt.ts         System prompt (base rules + top-k memories + active skills)
    agent/toolServer.ts     In-process MCP server with the built-in tools and sandbox tools
    gate.ts                 Approval gate: deterministic allow / ask / deny for every tool call
    policy/policy.ts        The policy table (PRD §10)
    policy/snapshot.ts      ARIA-snapshot click/type classifier, CAPTCHA/SMS detection, injection heuristic
    approvals.ts            Approval cards: persisted, block the turn, expire after 30 min
    handoffs.ts             CAPTCHA / SMS / login handoffs
    browser.ts              Playwright MCP (headed Chrome, persistent profile), shared with the gate
    tools/builtin.ts        gmail_*, inbox_wait_for_email, gdocs_*, reddit_search, leads_save,
                            memory_*, export_markdown, request_handoff, registry_*, sandbox_test, ...
    registry.ts             registry/ git repo: skills/, tools/, mcp.json, pending/; rollback
    proposals.ts            Approval previews (diffs, test output, integration details); staging
    sandbox.ts              Docker sandbox for agent-written tools (no host mounts except /work)
    integrations/           Google, Reddit, MCP registry and MCP OAuth clients
    secrets.ts              Keychain (keytar) / file / memory secret stores; placeholder substitution
    db/                     SQLite (better-sqlite3 + Drizzle) schema from PRD §12
tests/
  unit/                     Policy table, click classifier (saved snapshots), gate, registry, conversions
  integration/              Agent SDK session + resume, HTTP clients (msw), Docker sandbox
  e2e/                      T1–T7 and safety tests through the real UI
  fixtures/                 Fake model, fixture world (Google, Reddit, MCP registry, OAuth MCP server, websites)
```

Every external dependency sits behind a small interface so v2 can swap it: event bus, secret store, sandbox, browser, store.

## How approvals work

The Agent SDK's `PreToolUse` hook, with `canUseTool` as a backstop, sends every tool call to `ApprovalGate.decide()`:

| Class             | Examples                                                                                                                                             | Decision                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Read              | `browser_navigate`, `browser_snapshot`, `gmail_search`, `reddit_search`                                                                              | allow                         |
| Local write       | `export_markdown`, `memory_save`, `gdocs_create`                                                                                                     | allow, logged                 |
| Consequential web | `browser_click` / `browser_type` / `browser_fill_form` on a submit button or in a form with password, email or payment fields; `browser_file_upload` | ask                           |
| Outbound          | `gmail_send`, `gdocs_share`                                                                                                                          | ask                           |
| Self-modification | `registry_propose_skill`, `registry_propose_tool`, `registry_install_mcp`, `grant_secret`                                                            | ask, with a diff or preview   |
| Code execution    | `sandbox_test`, approved `sandbox_tool_*`                                                                                                            | allow (sandboxed, no secrets) |
| Forbidden         | shell, file tools, `browser_evaluate`, posting / DMing tools                                                                                         | deny                          |

For browser actions, the gate takes a fresh snapshot of the page and classifies the target element by its role, name and form context. When it can't tell, it asks.

Other safety measures:

- **Sign-up passwords:** passwords the agent generates are stored in the Keychain as `site:<domain>`. The model only ever sees `{{secret:site:<domain>}}`. The gate substitutes the real value only for `browser_type` or `browser_fill_form`, only on that domain, and redacts it from tool output before the model sees it.
- **Untrusted content:** web pages and emails are wrapped as untrusted data. Text that looks like an instruction to the agent is flagged in chat.
- **API protection:** mutating API routes require an `x-poppet` header and a same-origin `Origin` (CSRF protection). `src/proxy.ts` rejects requests whose `Host` isn't local (DNS rebinding).

## Tests

```bash
npm test            # unit + integration (Vitest); sandbox tests need a Docker daemon
npm run test:e2e    # builds the app, then runs T1–T7 + safety tests with Playwright
```

The end-to-end suite runs the real Next.js app, Agent SDK, approval gate, Playwright MCP browser, SQLite, git registry and Docker sandbox. Only two things are replaced:

- **External services:** `tests/fixtures/world.ts` serves fake Google OAuth, Gmail and Drive; the Reddit API; the MCP registry; an OAuth-protected MCP server; and websites on `*.localhost`, including a sign-up form with a fake CAPTCHA and a prompt-injection page.
- **The model's decisions:** `tests/fixtures/fakeModel.ts` implements the Anthropic Messages API and plays scripted scenarios (`tests/fixtures/scenarios.ts`).

Because of this, the e2e suite checks Poppet's machinery, not how well a real model does the tasks. Run T1–T7 by hand with a real model before relying on it; see the PRD §15 checklist.

## Differences from the PRD

- **Google APIs:** Google and Reddit are called through thin `fetch` clients rather than the `googleapis` package, so fixtures can stand in for them.
- **Draft scope:** the personal Google account also requests `gmail.compose`, because `gmail_draft` needs it.
- **Integrations:** remote HTTP MCP servers (OAuth or API-key headers) and npm packages from the official MCP registry can be installed. Composio is not implemented.
- **Secrets on other platforms:** on non-macOS machines, secrets default to a `0600` file in the workspace (`POPPET_SECRETS=file`).
