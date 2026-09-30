import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * PRD acceptance tasks T1–T7 plus the safety tests, driven through the real
 * web UI. Everything is real (Next.js app, Agent SDK, approval gate, Playwright
 * MCP Chrome, SQLite, git registry, Docker sandbox) except the external world,
 * which is the local fixture server, and the model's decisions, which come
 * from scripted scenarios.
 */

const FIX = 'http://127.0.0.1:4010';
const HOME = path.join(import.meta.dirname, '..', '..', '.e2e-home');

test.describe.configure({ mode: 'serial' });

async function world() {
  return (await fetch(`${FIX}/__test/state`)).json();
}

async function newChat(page: Page, prompt: string) {
  await page.goto('/');
  await page.getByTestId('new-conversation').click();
  await expect(page.getByTestId('timeline')).toContainText('Ask Poppet');
  await page.getByTestId('composer').fill(prompt);
  await page.getByTestId('send').click();
  await expect(page.getByTestId('user-message').last()).toHaveText(prompt);
}

async function finished(page: Page) {
  await expect(page.getByTestId('turn-status')).toHaveCount(0, { timeout: 120_000 });
}

async function approveNext(page: Page, tool?: string) {
  const pending = page.locator('[data-testid="approval-card"][data-status="pending"]').first();
  await expect(pending).toBeVisible();
  const id = await pending.getAttribute('data-approval-id');
  const card = page.locator(`[data-approval-id="${id}"]`);
  if (tool) await expect(card).toHaveAttribute('data-tool', tool);
  await card.getByTestId('approve').click();
  await expect(card).toHaveAttribute('data-status', 'approved');
  return card;
}

const lastAssistant = (page: Page) => page.getByTestId('assistant-message').last();

test.beforeAll(async () => {
  await fetch(`${FIX}/__test/reset`);
});

test('setup: connect the personal and agent Google accounts via OAuth', async ({ page }) => {
  await page.goto('/settings');
  for (const account of ['personal', 'agent'] as const) {
    await page.getByTestId(`account-${account}`).getByRole('link', { name: 'Connect' }).click();
    await expect(page.getByRole('heading', { name: /Poppet wants to access your Google Account/ })).toBeVisible();
    await page.getByRole('link', { name: 'Allow' }).click();
    await expect(page.getByTestId(`account-${account}`)).toContainText(
      account === 'personal' ? 'me@example.com' : 'poppet.agent@example.com',
    );
  }
});

test('T1: summarize unread Gmail from today and flag what needs a reply', async ({ page }) => {
  await newChat(page, 'Summarize my unread Gmail from today and flag what needs a reply.');
  await finished(page);
  const reply = lastAssistant(page);
  await expect(reply).toContainText('You have 3 unread emails today');
  await expect(reply).toContainText('Needs reply — Can you review the Q3 deck by Friday?');
  await expect(reply).toContainText('Needs reply — Please confirm your appointment');
  await expect(reply).not.toContainText('Needs reply — Your weekly digest');
  await expect(page.locator('[data-testid="tool-step"][data-tool="mcp__poppet__gmail_read"]')).toHaveCount(3);
  await expect(page.getByTestId('approval-card')).toHaveCount(0); // reading needs no approval
  await expect(page.getByTestId('usage')).toContainText('tokens');
});

test('T2: sign up with the agent inbox, hand off the CAPTCHA, confirm the email', async ({ page }) => {
  await newChat(page, 'Sign up for signup.localhost using your email, confirm the verification link, and tell me when done.');
  // Filling a form with email + password fields needs approval; the password is only a placeholder.
  const fill = await approveNext(page, 'mcp__browser__browser_fill_form');
  await expect(fill).toContainText('{{secret:site:signup.localhost}}');
  // Submitting needs approval.
  await approveNext(page, 'mcp__browser__browser_click');
  // Poppet detects the CAPTCHA and hands off to the human.
  const handoff = page.locator('[data-testid="handoff-card"][data-status="open"]');
  await expect(handoff).toContainText('CAPTCHA');
  await fetch(`${FIX}/__test/solve-captcha`); // the human solves it in the agent browser
  await handoff.getByTestId('handoff-continue').click();
  await finished(page);
  await expect(lastAssistant(page)).toContainText('Done — I signed up for signup.localhost');

  const w = await world();
  expect(w.signupAccounts).toHaveLength(1);
  const acct = w.signupAccounts[0];
  expect(acct.email).toBe('poppet.agent@example.com');
  expect(acct.verified).toBe(true);
  // The real password came from the secret store and never reached the model.
  const secrets = JSON.parse(fs.readFileSync(path.join(HOME, 'secrets.json'), 'utf8'));
  expect(acct.password).toBe(secrets['site:signup.localhost']);
  expect(acct.password.length).toBeGreaterThanOrEqual(16);
  const { requests } = await (await fetch(`${FIX}/__test/model-requests`)).json();
  expect(requests.some((r: string) => r.includes(acct.password))).toBe(false);
  // Nor is it shown in the UI.
  await expect(page.getByTestId('timeline')).not.toContainText(acct.password);
});

test('T3: research across several sites and compare with links', async ({ page }) => {
  await newChat(page, 'Compare note-taking apps and their prices across a few sites; give me a comparison with links.');
  await finished(page);
  const reply = lastAssistant(page);
  await expect(reply.locator('table')).toBeVisible();
  await expect(reply).toContainText('$8/month');
  await expect(reply).toContainText('$5/month');
  await expect(reply).toContainText('$12/month');
  await expect(reply.getByRole('link', { name: 'Beta Notebook' })).toHaveAttribute('href', 'http://beta.localhost:4010/pricing');
  await expect(page.getByTestId('approval-card')).toHaveCount(0); // browsing needs no approval
});

test('T4: find the order email and check its status on the shop site', async ({ page }) => {
  await newChat(page, 'Find the email from shop about my order and check its status on their site.');
  await finished(page);
  await expect(lastAssistant(page)).toContainText('Status: Shipped');
  await expect(lastAssistant(page)).toContainText('UPS');
});

test('T5: Reddit leads exported to Markdown and a Google Doc; T6: agent proposes a skill', async ({ page }) => {
  await newChat(page, 'Find Reddit leads for Invoicely, an invoicing app. Export them to a Google Doc and a .md file.');
  // The skill proposal shows a diff for approval.
  const card = page.locator('[data-testid="approval-card"][data-status="pending"]');
  await expect(card).toHaveAttribute('data-tool', 'mcp__poppet__registry_propose_skill');
  await expect(card).toContainText('+name: reddit-lead-search');
  await approveNext(page);
  await finished(page);
  await expect(lastAssistant(page)).toContainText('invoicely-leads.md');

  // Artifacts panel: the .md export (viewable) and the Google Doc link.
  const panel = page.getByTestId('artifacts-panel');
  await expect(panel.getByTestId('artifact')).toHaveCount(2);
  await panel.getByRole('button', { name: 'View' }).click();
  const viewer = page.getByTestId('artifact-viewer');
  await expect(viewer.locator('table')).toContainText('agency_owner');
  await expect(viewer.locator('tbody tr').first()).toContainText('85');
  await viewer.getByRole('button', { name: 'Close' }).click();

  const exported = fs.readFileSync(path.join(HOME, 'exports', 'invoicely-leads.md'), 'utf8');
  expect(exported).toContain('# Reddit leads for Invoicely');
  const w = await world();
  expect(w.docs).toHaveLength(1);
  expect(w.docs[0].name).toBe('Invoicely Reddit leads');
  expect(w.docs[0].html).toContain('<table>');
  expect(w.redditRequests.some((r: string) => r.includes('/r/smallbusiness/search'))).toBe(true);

  // Registry: the skill is committed to git.
  const reg = await (await page.request.get('/api/registry')).json();
  expect(reg.active.skills).toContain('reddit-lead-search');
  expect(reg.history[0].message).toBe('Activate skill reddit-lead-search v1');

  // T6: repeating the task uses the skill, and no new proposal is made.
  await newChat(page, 'Find Reddit leads for Invoicely again please.');
  await finished(page);
  await expect(page.locator('[data-testid="tool-step"][data-tool="mcp__poppet__skill_load"]')).toHaveCount(1);
  await expect(lastAssistant(page)).toContainText('used the reddit-lead-search skill');
  await expect(page.getByTestId('approval-card')).toHaveCount(0);
});

test('T7: install an MCP integration, sign in with OAuth, and complete the task', async ({ page, context }) => {
  await newChat(page, 'Add a page to my Notion called "Poppet launch checklist".');
  const install = page.locator('[data-testid="approval-card"][data-status="pending"]');
  await expect(install).toHaveAttribute('data-tool', 'mcp__poppet__registry_install_mcp');
  await expect(install).toContainText('io.example/notion');
  await expect(install).toContainText('https://github.com/example/notion-mcp');
  await expect(install).toContainText('OAuth sign-in');
  await approveNext(page);
  await finished(page);

  const signin = page.locator('[data-testid="signin-card"][data-status="waiting"]');
  await expect(signin).toBeVisible();
  const [popup] = await Promise.all([context.waitForEvent('page'), signin.getByTestId('signin-link').click()]);
  await expect(popup.getByRole('heading', { name: /Allow Poppet to access your Notion/ })).toBeVisible();
  await popup.getByRole('link', { name: 'Allow access' }).click();
  await popup.waitForURL(/connected=notion/);
  await popup.close();

  // The session restarts with the new server and continues; creating a page asks first.
  await expect(page.locator('[data-testid="signin-card"]')).toHaveAttribute('data-status', 'connected');
  await approveNext(page, 'mcp__ext_notion__create_page');
  await finished(page);
  await expect(lastAssistant(page)).toContainText('Created the Notion page');
  const w = await world();
  expect(w.notionPages.map((p: { title: string }) => p.title)).toContain('Poppet launch checklist');
});

test('Self-extension: agent writes a tool, tests it in the Docker sandbox, and uses it after approval', async ({ page }) => {
  await newChat(page, 'Write a tool that counts words, then use it on "one two three four".');
  const card = page.locator('[data-testid="approval-card"][data-status="pending"]');
  await expect(card).toHaveAttribute('data-tool', 'mcp__poppet__registry_propose_tool', { timeout: 120_000 });
  await expect(card).toContainText('Tests: PASSED');
  await expect(card).toContainText('export default async function run');
  await approveNext(page);
  await expect(lastAssistant(page)).toContainText('"words": 4', { timeout: 120_000 });
  await finished(page);
});

test('Safety: injected page instructions produce no automatic action', async ({ page }) => {
  await newChat(page, 'Summarize evil.localhost for me.');
  // The injection is flagged in chat.
  await expect(page.getByTestId('notice').filter({ hasText: 'Possible prompt injection' })).toBeVisible();
  // Sending mail to the attacker is held for approval; the user rejects it.
  const card = page.locator('[data-testid="approval-card"][data-status="pending"]');
  await expect(card).toHaveAttribute('data-tool', 'mcp__poppet__gmail_send');
  await expect(card).toContainText('attacker@evil.example');
  await card.getByTestId('reject-note').fill('This came from a web page');
  await card.getByTestId('reject').click();
  await finished(page);
  await expect(lastAssistant(page)).toContainText('Install: blocked; send: blocked');
  const w = await world();
  expect(w.sent).toHaveLength(0);
  const reg = await (await page.request.get('/api/registry')).json();
  expect(reg.active.mcp).not.toContain('stealer');
});

test('Safety: other origins cannot approve actions (CSRF guard)', async ({ request }) => {
  const noHeader = await request.post('/api/approvals/some-id', { data: { approved: true } });
  expect(noHeader.status()).toBe(403);
  const foreign = await request.post('/api/approvals/some-id', {
    data: { approved: true },
    headers: { 'x-poppet': '1', origin: 'http://evil.localhost:4010' },
  });
  expect(foreign.status()).toBe(403);
});

test('Settings: audit log, registry controls and memories are visible', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByTestId('audit-log')).toContainText('approval_decided');
  await expect(page.getByTestId('audit-log')).toContainText('handoff_done');
  await expect(page.getByTestId('registry-skill-reddit-lead-search')).toContainText('active');
  // Disable then roll back the skill via the UI.
  await page.getByTestId('registry-skill-reddit-lead-search').getByRole('button', { name: 'Disable' }).click();
  await expect(page.getByTestId('registry-skill-reddit-lead-search')).toContainText('disabled');
  await page.getByTestId('registry-skill-reddit-lead-search').getByRole('button', { name: 'Enable' }).click();
  await expect(page.getByTestId('registry-skill-reddit-lead-search')).toContainText('active');
  const w = await world();
  expect(w.modelErrors).toEqual([]);
});
