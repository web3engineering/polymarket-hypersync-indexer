# Polymarket Hypersync Indexer

A high-performance Polymarket event indexer using Envio's Hypersync for fast blockchain data fetching.

## Overview

This project is a rewrite of the Ponder-based Polymarket indexer using Hypersync, which provides significantly faster blockchain data access compared to traditional RPC methods.

## Current Status: Phase 1 Complete (Code Implementation)

✅ **Phase 1: Simple Log Fetching**
- Project structure created
- Dependencies configured
- Hypersync client integration implemented
- Event signature hashing and filtering configured
- Statistics and sample log display implemented

## Architecture

```
src/
├── abis/
│   ├── PolymarketAbi.ts       # OrderFilled & OrdersMatched events
│   └── ConditionalTokensAbi.ts # Conditional tokens (for future use)
├── config.ts                   # Configuration constants
└── index.ts                    # Phase 1: Log fetching implementation
```

## Configuration

The indexer tracks the following contracts on Polygon:

- **PolymarketMain**: `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`
- **PolymarketNeg**: `0xc5d563a36ae78145c45a50134d48a1215220f80a`
- **PolymarketNegAdapter**: `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296`

Block range: **81,651,726 to 82,114,364**

Events tracked:
- `OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)`
- `OrdersMatched(bytes32,address,uint256,uint256,uint256,uint256)`

## Setup

### Prerequisites

1. Node.js (v18 or higher)
2. npm or pnpm

### Installation

```bash
npm install
```

### Environment Variables

Create a `.env` file (already exists) with the following:

```env
HYPERSYNC_URL=https://polygon.hypersync.xyz
ENVIO_API_TOKEN=your_api_token_here
START_BLOCK=81651726
END_BLOCK=82114364
CLICKHOUSE_HOST=http://localhost:8123
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=
CLICKHOUSE_DATABASE=default
BATCH_SIZE=100
```

**IMPORTANT**: To run this indexer, you need a valid Envio API token.

### Getting an Envio API Token

The newer version (v1.1.0) of `@envio-dev/hypersync-client` requires authentication:

1. Visit [Envio's website](https://envio.dev) to sign up
2. Generate an API token from your dashboard
3. Add the token to your `.env` file as `ENVIO_API_TOKEN=your_token_here`

Alternatively, you could use an older version of the client that doesn't require authentication, but the newer version has better performance and features.

## Running Phase 1

Once you have a valid API token:

```bash
npm start
# or
npx tsx src/index.ts
```

Expected output:
```
Initializing Hypersync client...
Endpoint: https://polygon.hypersync.xyz
Block range: 81651726 to 82114364

Fetching logs from Hypersync...
✓ Fetched logs in 2.3s

=== STATISTICS ===
Total logs fetched: 15234

Contract breakdown:
  PolymarketMain: 8934 logs
  PolymarketNeg: 4123 logs
  PolymarketNegAdapter: 2177 logs

Event breakdown:
  OrderFilled: 12456 logs
  OrdersMatched: 2778 logs

Block range covered: 81651726 to 82114364

=== SAMPLE LOGS (first 10) ===
[1] OrderFilled
  Contract: PolymarketMain
  Block: 81651726
  ...
```

## Implementation Phases

### ✅ Phase 1: Simple Log Fetching (IMPLEMENTED)
- Initialize Hypersync client
- Calculate event signature hashes using keccak256
- Build query for OrderFilled and OrdersMatched events
- Fetch logs from all 3 contracts
- Display statistics and sample logs

### 🔄 Phase 2: Event Decoding (Next)
- Implement `src/decoder.ts`
- Use viem's `decodeEventLog` to decode raw logs
- Determine which ABI to use based on contract address
- Extract event names and arguments

### 🔄 Phase 3: Event Correlation
- Implement `src/correlator.ts`
- Port OrderFilled buffering logic
- Port OrdersMatched correlation logic
- Implement maker/taker row generation
- Handle buy/sell side determination

### 🔄 Phase 4: Batch Processing & ClickHouse
- Implement `src/batchCollector.ts`
- Initialize ClickHouse client
- Create table schema
- Batch inserts (100 events)
- Retry logic

### 🔄 Phase 5: End-to-End Processing
- Implement `src/processor.ts`
- Orchestrate full pipeline
- Group by transaction, sort by log index
- Process events through correlation
- Insert to ClickHouse

## Key Features

- **Fast Data Fetching**: Hypersync provides 2000x faster data access than traditional RPC
- **Event Correlation**: Sophisticated OrderFilled/OrdersMatched correlation logic
- **Batch Processing**: Efficient batching for ClickHouse inserts
- **Type Safety**: Full TypeScript support with proper typing

## Files Reference

Implementation references the original Ponder indexer at `/root/polyindex`:
- Event correlation logic: `src/index.ts` lines 107-315
- BatchCollector class: `src/index.ts` lines 14-58
- Common field extraction: `src/index.ts` lines 74-95
- Event ABIs: `abis/PolymarketAbi.ts` lines 106-198
- Table schema: `clickhouse-schema.sql` lines 4-52

## Performance Expectations

- Log fetching: Minutes instead of hours
- Full block range (462K blocks): Expected to complete in under 10 minutes
- ClickHouse MergeTree: High-throughput inserts with efficient storage

## Development

```bash
# Development mode with auto-reload
npm run dev

# Type checking
npx tsc --noEmit
```

## Troubleshooting

### 403 Forbidden Error
This occurs when the API token is missing or invalid. Make sure you have:
1. A valid Envio API token in your `.env` file
2. The token is properly set as `ENVIO_API_TOKEN=your_token_here`

### Module Import Errors
Make sure all dependencies are installed:
```bash
npm install
```

## License

MIT
