import 'dotenv/config';

export type IndexFlow = 'fills' | 'conditional-tokens-events' | 'convert';

function parseFlow(): IndexFlow {
  const args = process.argv;
  let raw = process.env.INDEX_FLOW || process.env.FLOW || 'fills';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--flow' && i + 1 < args.length) {
      raw = args[i + 1];
    } else if (args[i].startsWith('--flow=')) {
      raw = args[i].slice('--flow='.length);
    }
  }

  if (raw === 'fills' || raw === 'conditional-tokens-events' || raw === 'convert') {
    return raw;
  }

  throw new Error(`Unsupported INDEX_FLOW/FLOW value "${raw}". Use "fills", "conditional-tokens-events", or "convert".`);
}

function parseIndexTargets(): ('v1' | 'v2')[] {
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--index-targets' && i + 1 < args.length) {
      return args[i + 1].split(',').map(t => t.trim() as 'v1' | 'v2');
    }
    if (args[i].startsWith('--index-targets=')) {
      return args[i].slice('--index-targets='.length).split(',').map(t => t.trim() as 'v1' | 'v2');
    }
  }
  return (process.env.INDEX_TARGETS || 'v1').split(',').map(t => t.trim() as 'v1' | 'v2');
}

export const config = {
  flow: parseFlow(),
  hypersyncUrl: process.env.HYPERSYNC_URL || 'https://polygon.hypersync.xyz',
  apiToken: process.env.ENVIO_API_TOKEN || '',
  startBlock: parseInt(process.env.START_BLOCK || '65000000'),
  endBlock: process.env.END_BLOCK ? parseInt(process.env.END_BLOCK) : undefined,
  streamMode: process.env.STREAM_MODE !== 'false',
  testMode: process.env.TEST_MODE === 'true',
  testStartBlock: parseInt(process.env.TEST_START_BLOCK || '83988143'),
  testEndBlock: parseInt(process.env.TEST_END_BLOCK || '83988243'),
  indexTargets: parseIndexTargets(),

  contracts: {
    v1: [
      '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
      '0xc5d563a36ae78145c45a50134d48a1215220f80a',
      '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
    ],
    v2: [
      '0xE111180000d2663C0091e4f400237545B87B996B',
      '0xe2222d279d744050d28e00520010520000310F59',
    ],
    conditionalTokens: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
    negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
  },

  conditionalTokens: {
    startBlock: parseInt(process.env.CONDITIONAL_TOKENS_START_BLOCK || '0'),
    pollMs: parseInt(process.env.CONDITIONAL_TOKENS_POLL_MS || '5000'),
    eventIdChainId: BigInt(process.env.CONDITIONAL_TOKENS_EVENT_ID_CHAIN_ID || '1'),
  },

  convert: {
    startBlock: parseInt(process.env.CONVERT_START_BLOCK || '0'),
    pollMs: parseInt(process.env.CONVERT_POLL_MS || '5000'),
  },

  clickhouse: {
    host: process.env.CLICKHOUSE_HOST || 'http://localhost:8123',
    user: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    database: process.env.CLICKHOUSE_DATABASE || 'default'
  },

  batchSize: parseInt(process.env.BATCH_SIZE || '100')
};
