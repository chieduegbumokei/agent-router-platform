const llmProvider = (process.env.LLM_PROVIDER ?? 'mock') as 'bedrock' | 'anthropic' | 'mock';

/** Central env-backed configuration. Every value has a safe local default. */
export const config = {
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
  accessTokenTtlSec: 15 * 60,
  refreshTokenTtlSec: 7 * 24 * 60 * 60,

  llmProvider,
  awsRegion: process.env.AWS_REGION ?? 'us-east-1',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  // Model IDs differ per provider: Bedrock uses prefixed inference-profile IDs,
  // the Anthropic API uses bare aliases.
  routerModel:
    llmProvider === 'anthropic'
      ? process.env.ANTHROPIC_ROUTER_MODEL ?? 'claude-haiku-4-5'
      : process.env.BEDROCK_ROUTER_MODEL ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  agentModel:
    llmProvider === 'anthropic'
      ? process.env.ANTHROPIC_AGENT_MODEL ?? 'claude-sonnet-4-5'
      : process.env.BEDROCK_AGENT_MODEL ?? 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',

  store: (process.env.STORE ?? 'memory') as 'memory' | 'dynamo',
  dynamoTable: process.env.DYNAMO_TABLE ?? 'assistant-platform',
  dynamoEndpoint: process.env.DYNAMO_ENDPOINT,

  tavilyApiKey: process.env.TAVILY_API_KEY,

  port: Number(process.env.PORT ?? 4000),
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000',

  maxMessageChars: 8_000,
  historyWindow: 20,
  maxToolTurns: 3,
  routerTimeoutMs: Number(process.env.ROUTER_TIMEOUT_MS ?? 2_000),
  codeTimeoutMs: Number(process.env.CODE_TIMEOUT_MS ?? 5_000),

  // Attachments (multi-modal input). Bytes are per-turn context, never stored.
  maxAttachments: 4,
  maxImageBytes: 3_500_000, // Anthropic/Bedrock image cap is ~5MB; stay under the 6MB Lambda body limit
  maxTextAttachmentBytes: 48_000,

  // Projects (grouped conversations with shared instructions)
  maxProjectsPerUser: 20,

  // Cross-session memory
  maxMemoriesPerUser: 100,
  memoryExtractTimeoutMs: Number(process.env.MEMORY_EXTRACT_TIMEOUT_MS ?? 4_000),

  // MCP connectors. Local/private URLs are handy in dev but are an SSRF vector
  // once deployed - template.yaml pins MCP_ALLOW_LOCAL=false in AWS.
  mcpAllowLocal: (process.env.MCP_ALLOW_LOCAL ?? 'true') === 'true',
  mcpConnectTimeoutMs: Number(process.env.MCP_CONNECT_TIMEOUT_MS ?? 8_000),
  mcpCallTimeoutMs: Number(process.env.MCP_CALL_TIMEOUT_MS ?? 20_000),
  maxMcpServersPerUser: 5,

  // Topic blacklist: comma-separated phrases; matching requests are rejected
  // before any LLM call (see core/moderation.ts).
  blockedTopics: (process.env.BLOCKED_TOPICS ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean),

  chatRatePerMin: 10,
  chatRatePerDay: Number(process.env.CHAT_RATE_PER_DAY ?? 200),
  authRatePerMin: 5,
};
