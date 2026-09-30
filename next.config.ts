import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Native / subprocess-heavy packages must stay external to the server bundle.
  serverExternalPackages: [
    'better-sqlite3',
    'keytar',
    'simple-git',
    '@anthropic-ai/claude-agent-sdk',
    '@modelcontextprotocol/sdk',
    '@playwright/mcp',
  ],
};

export default nextConfig;
