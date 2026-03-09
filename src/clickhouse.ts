import { createClient } from '@clickhouse/client';
import { config } from './config';

export const clickhouse = createClient({
  host: config.clickhouse.host,
  username: config.clickhouse.user,
  password: config.clickhouse.password,
  database: config.clickhouse.database,
});

export async function ensureTable() {
  // First ensure the database exists
  await clickhouse.exec({ query: 'CREATE DATABASE IF NOT EXISTS polymarket' });

  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS polymarket.polymarket_order_filled_v3 (
      event_id String,
      order_hash String,
      wallet String,
      asset String,
      amount_token UInt256,
      amount_usdc UInt256,
      is_maker Bool,
      side FixedString(1),
      fee UInt256,
      block_number UInt64,
      log_index UInt32,
      transaction_index UInt32,
      contract_address String,
      block_hash String,
      block_timestamp DateTime,
      gas_used UInt64,
      gas_limit UInt64,
      base_fee_per_gas UInt256,
      transaction_hash String,
      transaction_from String,
      transaction_to String,
      transaction_value UInt256,
      transaction_gas UInt64,
      transaction_nonce UInt64,
      max_fee_per_gas UInt256,
      max_priority_fee_per_gas UInt256,
      inserted_at DateTime DEFAULT now(),
      INDEX idx_wallet wallet TYPE bloom_filter GRANULARITY 1,
      INDEX idx_asset asset TYPE bloom_filter GRANULARITY 1,
      INDEX idx_order_hash order_hash TYPE bloom_filter GRANULARITY 1,
      INDEX idx_side side TYPE set(0) GRANULARITY 1
    ) ENGINE = MergeTree
    PARTITION BY toYYYYMMDD(block_timestamp)
    ORDER BY (block_number, transaction_index, log_index, is_maker)
    SETTINGS index_granularity = 8192
  `;

  await clickhouse.exec({ query: createTableSQL });
}

export async function getLastBlock(): Promise<number> {
  try {
    const result = await clickhouse.query({
      query: 'SELECT MAX(block_number) as last_block FROM polymarket.polymarket_order_filled_v3',
      format: 'JSONEachRow',
    });

    const rows = await result.json<{ last_block: string }[]>();

    if (rows.length === 0 || rows[0].last_block === '0') {
      return 65000000; // Default start block
    }

    return parseInt(rows[0].last_block);
  } catch (error) {
    // Table doesn't exist yet or is empty
    return 65000000;
  }
}
