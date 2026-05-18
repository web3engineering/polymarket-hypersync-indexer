import { createClient } from '@clickhouse/client';
import { config } from './config';
import type { ConditionalTokensProgress } from './types';

export const clickhouse = createClient({
  host: config.clickhouse.host,
  username: config.clickhouse.user,
  password: config.clickhouse.password,
  database: config.clickhouse.database,
});

export async function ensureTable() {
  await clickhouse.command({ query: 'CREATE DATABASE IF NOT EXISTS polymarket' });

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
      builder String DEFAULT '',
      metadata String DEFAULT '',
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

  await clickhouse.command({ query: createTableSQL });

  // Add new columns to existing tables (migration, idempotent)
  await clickhouse.command({ query: `ALTER TABLE polymarket.polymarket_order_filled_v3 ADD COLUMN IF NOT EXISTS builder String DEFAULT ''` });
  await clickhouse.command({ query: `ALTER TABLE polymarket.polymarket_order_filled_v3 ADD COLUMN IF NOT EXISTS metadata String DEFAULT ''` });
}

export async function ensureConditionalTokensTables() {
  await clickhouse.command({ query: 'CREATE DATABASE IF NOT EXISTS polymarket' });

  await clickhouse.command({ query: `
    CREATE TABLE IF NOT EXISTS polymarket.conditional_tokens_condition_preparation (
      condition_id String,
      oracle String,
      question_id String,
      outcome_slot_count UInt32,
      event_id String,
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
      INDEX idx_condition_id_prep condition_id TYPE bloom_filter GRANULARITY 1,
      INDEX idx_oracle_prep oracle TYPE bloom_filter GRANULARITY 1,
      INDEX idx_question_id_prep question_id TYPE bloom_filter GRANULARITY 1
    ) ENGINE = MergeTree
    PARTITION BY toYYYYMMDD(block_timestamp)
    ORDER BY (block_number, transaction_index, log_index)
    SETTINGS index_granularity = 8192
  ` });

  await clickhouse.command({ query: `
    CREATE TABLE IF NOT EXISTS polymarket.conditional_tokens_condition_resolution (
      condition_id String,
      oracle String,
      question_id String,
      outcome_slot_count UInt32,
      payout_numerators String,
      event_id String,
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
      INDEX idx_condition_id_res condition_id TYPE bloom_filter GRANULARITY 1,
      INDEX idx_oracle_res oracle TYPE bloom_filter GRANULARITY 1,
      INDEX idx_question_id_res question_id TYPE bloom_filter GRANULARITY 1
    ) ENGINE = MergeTree
    PARTITION BY toYYYYMMDD(block_timestamp)
    ORDER BY (block_number, transaction_index, log_index)
    SETTINGS index_granularity = 8192
  ` });

  await clickhouse.command({ query: `
    CREATE TABLE IF NOT EXISTS polymarket.conditional_tokens_position_split (
      stakeholder String,
      collateral_token String,
      parent_collection_id String,
      condition_id String,
      partition String,
      amount String,
      event_id String,
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
      INDEX idx_stakeholder_split stakeholder TYPE bloom_filter GRANULARITY 1,
      INDEX idx_collateral_split collateral_token TYPE bloom_filter GRANULARITY 1,
      INDEX idx_condition_id_split condition_id TYPE bloom_filter GRANULARITY 1
    ) ENGINE = MergeTree
    PARTITION BY toYYYYMMDD(block_timestamp)
    ORDER BY (block_number, transaction_index, log_index)
    SETTINGS index_granularity = 8192
  ` });

  await clickhouse.command({ query: `
    CREATE TABLE IF NOT EXISTS polymarket.conditional_tokens_positions_merge (
      stakeholder String,
      collateral_token String,
      parent_collection_id String,
      condition_id String,
      partition String,
      amount String,
      event_id String,
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
      INDEX idx_stakeholder_merge stakeholder TYPE bloom_filter GRANULARITY 1,
      INDEX idx_collateral_merge collateral_token TYPE bloom_filter GRANULARITY 1,
      INDEX idx_condition_id_merge condition_id TYPE bloom_filter GRANULARITY 1
    ) ENGINE = MergeTree
    PARTITION BY toYYYYMMDD(block_timestamp)
    ORDER BY (block_number, transaction_index, log_index)
    SETTINGS index_granularity = 8192
  ` });

  await clickhouse.command({ query: `
    CREATE TABLE IF NOT EXISTS polymarket.conditional_tokens_payout_redemption (
      redeemer String,
      collateral_token String,
      parent_collection_id String,
      condition_id String,
      index_sets String,
      payout String,
      event_id String,
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
      INDEX idx_redeemer redeemer TYPE bloom_filter GRANULARITY 1,
      INDEX idx_collateral_redemption collateral_token TYPE bloom_filter GRANULARITY 1,
      INDEX idx_condition_id_redemption condition_id TYPE bloom_filter GRANULARITY 1
    ) ENGINE = MergeTree
    PARTITION BY toYYYYMMDD(block_timestamp)
    ORDER BY (block_number, transaction_index, log_index)
    SETTINGS index_granularity = 8192
  ` });

  await clickhouse.command({ query: `
    CREATE TABLE IF NOT EXISTS polymarket.conditional_tokens_uri (
      value String,
      id String,
      event_id String,
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
      INDEX idx_id_uri id TYPE bloom_filter GRANULARITY 1
    ) ENGINE = MergeTree
    PARTITION BY toYYYYMMDD(block_timestamp)
    ORDER BY (block_number, transaction_index, log_index)
    SETTINGS index_granularity = 8192
  ` });
}

export async function getTableMaxBlock(tableName: string): Promise<number> {
  const result = await clickhouse.query({
    query: `SELECT ifNull(max(block_number), 0) as last_block FROM polymarket.${tableName}`,
    format: 'JSONEachRow',
  });

  const rows = (await result.json()) as { last_block: string | number }[];
  const raw = rows[0]?.last_block ?? 0;
  return typeof raw === 'number' ? raw : parseInt(raw, 10);
}

export async function getConditionalTokensProgress(
  tables: { eventName: string; tableName: string }[]
): Promise<ConditionalTokensProgress[]> {
  const progress: ConditionalTokensProgress[] = [];
  for (const table of tables) {
    const maxBlock = await getTableMaxBlock(table.tableName);

    progress.push({
      eventName: table.eventName,
      tableName: table.tableName,
      nextBlock: Math.max(maxBlock > 0 ? maxBlock + 1 : 0, config.conditionalTokens.startBlock),
    });
  }

  return progress;
}

export async function getLastBlock(contractAddresses: string[]): Promise<number> {
  if (contractAddresses.length === 0) return config.startBlock;
  try {
    const addressList = contractAddresses.map(a => `'${a.toLowerCase()}'`).join(',');
    const result = await clickhouse.query({
      query: `SELECT MAX(block_number) as last_block FROM polymarket.polymarket_order_filled_v3 WHERE lower(contract_address) IN (${addressList})`,
      format: 'JSONEachRow',
    });

    const rows = (await result.json()) as { last_block: string }[];

    if (rows.length === 0 || !rows[0]?.last_block || rows[0].last_block === '0') {
      return config.startBlock;
    }

    return parseInt(rows[0].last_block);
  } catch {
    return config.startBlock;
  }
}
