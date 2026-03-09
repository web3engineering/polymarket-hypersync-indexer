import 'dotenv/config';

export const config = {
  hypersyncUrl: process.env.HYPERSYNC_URL || 'https://polygon.hypersync.xyz',
  apiToken: process.env.ENVIO_API_TOKEN || '',
  startBlock: parseInt(process.env.START_BLOCK || '65000000'),
  streamMode: process.env.STREAM_MODE !== 'false', // Default to streaming
  testMode: process.env.TEST_MODE === 'true',
  testStartBlock: parseInt(process.env.TEST_START_BLOCK || '83988143'),
  testEndBlock: parseInt(process.env.TEST_END_BLOCK || '83988243'),

  contracts: {
    polymarketMain: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
    polymarketNeg: '0xc5d563a36ae78145c45a50134d48a1215220f80a',
    polymarketNegAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
    conditionalTokens: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045'
  },

  clickhouse: {
    host: process.env.CLICKHOUSE_HOST || 'http://localhost:8123',
    user: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    database: process.env.CLICKHOUSE_DATABASE || 'default'
  },

  batchSize: parseInt(process.env.BATCH_SIZE || '100')
};
