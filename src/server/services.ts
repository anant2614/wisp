import path from 'node:path';
import { getConfig } from './config';
import { openDb, type Db } from './db';
import { InMemoryEventBus, type EventBus } from './events';
import { Timeline } from './timeline';
import { AuditLog } from './audit';
import { FileSecretStore, KeychainSecretStore, MemorySecretStore, type SecretStore } from './secrets';
import { ApprovalManager } from './approvals';
import { HandoffManager } from './handoffs';
import { ApprovalGate } from './gate';
import { BrowserService } from './browser';
import { GoogleClient } from './integrations/google';
import { RedditClient } from './integrations/reddit';
import { McpAuthService } from './integrations/mcpAuth';
import { Registry } from './registry';
import { DisabledSandbox, DockerSandbox, type Sandbox } from './sandbox';
import { ConversationStore, ExportStore, LeadStore, MemoryStore } from './stores';
import { ProposalService } from './proposals';
import { SessionManager } from './agent/session';

export interface Services {
  db: Db;
  bus: EventBus;
  timeline: Timeline;
  audit: AuditLog;
  secrets: SecretStore;
  approvals: ApprovalManager;
  handoffs: HandoffManager;
  gate: ApprovalGate;
  browser: BrowserService;
  google: GoogleClient;
  reddit: RedditClient;
  mcpAuth: McpAuthService;
  registry: Registry;
  sandbox: Sandbox;
  memory: MemoryStore;
  leads: LeadStore;
  exports: ExportStore;
  conversations: ConversationStore;
  proposals: ProposalService;
  sessions: SessionManager;
}

export function createServices(overrides: Partial<Pick<Services, 'secrets' | 'sandbox' | 'bus'>> = {}): Services {
  const c = getConfig();
  const db = openDb(path.join(c.home, 'poppet.db'));
  const bus = overrides.bus ?? new InMemoryEventBus();
  const timeline = new Timeline(db, bus);
  const audit = new AuditLog(db);
  const secrets =
    overrides.secrets ??
    (c.secretsDriver === 'keychain'
      ? new KeychainSecretStore()
      : c.secretsDriver === 'memory'
        ? new MemorySecretStore()
        : new FileSecretStore(path.join(c.home, 'secrets.json')));
  const approvals = new ApprovalManager(db, timeline, audit, c.approvalTimeoutMs);
  const handoffs = new HandoffManager(db, timeline, audit);
  const browser = new BrowserService(path.join(c.home, 'chrome-profile'), path.join(c.home, 'browser-output'));
  const registry = new Registry(db, path.join(c.home, 'registry'));
  const sandbox =
    overrides.sandbox ??
    (c.sandbox.driver === 'docker' ? new DockerSandbox(path.join(c.home, 'sandbox')) : new DisabledSandbox());
  const proposals = new ProposalService(registry, sandbox, secrets);
  const gate = new ApprovalGate({ approvals, audit, secrets, browser, previews: proposals });

  const services = {
    db,
    bus,
    timeline,
    audit,
    secrets,
    approvals,
    handoffs,
    gate,
    browser,
    google: new GoogleClient(secrets),
    reddit: new RedditClient(),
    mcpAuth: new McpAuthService(secrets),
    registry,
    sandbox,
    memory: new MemoryStore(db),
    leads: new LeadStore(db),
    exports: new ExportStore(path.join(c.home, 'exports')),
    conversations: new ConversationStore(db),
    proposals,
  } as Services;
  services.sessions = new SessionManager(services);

  handoffs.onRaise = () => void browser.bringToFront();
  approvals.onOrphanDecision = (row, d) =>
    services.sessions.onOrphanApproval(row.convId, row.toolName, JSON.parse(row.inputJson), d.approved, d.note);
  approvals.restoreOrphans();
  handoffs.cancelOrphans();
  return services;
}

const g = globalThis as unknown as { __poppet?: Services };

/** Process-wide singleton (survives Next.js dev hot reloads). */
export function services(): Services {
  if (!g.__poppet) g.__poppet = createServices();
  return g.__poppet;
}
