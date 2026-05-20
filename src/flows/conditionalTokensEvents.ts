import { HypersyncClient, Query } from '@envio-dev/hypersync-client';
import { keccak256, toHex } from 'viem';
import { BatchCollector } from '../batchCollector';
import {
  clickhouse,
  ensureConditionalTokensTables,
  getConditionalTokensProgress,
} from '../clickhouse';
import { config } from '../config';
import { ConditionalTokensAbi, decodeLog } from '../decoder';
import type {
  CommonEventRow,
  ConditionalTokensProgress,
  ConditionalTokensRow,
  DecodedLog,
  ProcessedBlock,
  ProcessedTransaction,
} from '../types';

type ConditionalTokensEventName =
  | 'ConditionPreparation'
  | 'ConditionResolution'
  | 'PositionSplit'
  | 'PositionsMerge'
  | 'PayoutRedemption'
  | 'URI';

type ConditionalTokensEventSpec = {
  eventName: ConditionalTokensEventName;
  tableName: string;
  topic0: string;
  toRow: (
    log: DecodedLog,
    block: ProcessedBlock,
    transaction: ProcessedTransaction
  ) => ConditionalTokensRow;
};

const EVENT_SIGNATURES: Record<ConditionalTokensEventName, string> = {
  ConditionPreparation: 'ConditionPreparation(bytes32,address,bytes32,uint256)',
  ConditionResolution: 'ConditionResolution(bytes32,address,bytes32,uint256,uint256[])',
  PositionSplit: 'PositionSplit(address,address,bytes32,bytes32,uint256[],uint256)',
  PositionsMerge: 'PositionsMerge(address,address,bytes32,bytes32,uint256[],uint256)',
  PayoutRedemption: 'PayoutRedemption(address,address,bytes32,bytes32,uint256[],uint256)',
  URI: 'URI(string,uint256)',
};

function topic0(signature: string): string {
  return keccak256(toHex(signature));
}

function asString(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return value == null ? '' : String(value);
}

function asLowerString(value: unknown): string {
  return asString(value).toLowerCase();
}

function asStringArray(value: unknown): string {
  if (!Array.isArray(value)) return '[]';
  return JSON.stringify(value.map(item => asString(item)));
}

function blockTimestamp(block: ProcessedBlock): string {
  return new Date(block.timestamp * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function pad(value: bigint | number, length: number): string {
  return BigInt(value).toString().padStart(length, '0');
}

function makeEventId(log: DecodedLog, block: ProcessedBlock): string {
  return [
    pad(block.timestamp, 10),
    pad(config.conditionalTokens.eventIdChainId, 16),
    pad(block.number, 16),
    pad(log.transactionIndex, 16),
    '5',
    pad(log.logIndex, 16),
  ].join('');
}

function commonEventRow(
  log: DecodedLog,
  block: ProcessedBlock,
  transaction: ProcessedTransaction
): CommonEventRow {
  return {
    event_id: makeEventId(log, block),
    block_number: block.number,
    log_index: log.logIndex,
    transaction_index: log.transactionIndex,
    contract_address: asLowerString(log.address),
    block_hash: asLowerString(block.hash),
    block_timestamp: blockTimestamp(block),
    gas_used: Number(block.gasUsed),
    gas_limit: Number(block.gasLimit),
    base_fee_per_gas: block.baseFeePerGas.toString(),
    transaction_hash: asLowerString(transaction.hash),
    transaction_from: asLowerString(transaction.from),
    transaction_to: transaction.to ? asLowerString(transaction.to) : '',
    transaction_value: transaction.value.toString(),
    transaction_gas: Number(transaction.gas),
    transaction_nonce: Number(transaction.nonce),
    max_fee_per_gas: transaction.maxFeePerGas?.toString() || '0',
    max_priority_fee_per_gas: transaction.maxPriorityFeePerGas?.toString() || '0',
  };
}

const CONDITIONAL_EVENT_SPECS: ConditionalTokensEventSpec[] = [
  {
    eventName: 'ConditionPreparation',
    tableName: 'conditional_tokens_condition_preparation',
    topic0: topic0(EVENT_SIGNATURES.ConditionPreparation),
    toRow: (log, block, transaction) => ({
      condition_id: asLowerString(log.args.conditionId),
      oracle: asLowerString(log.args.oracle),
      question_id: asLowerString(log.args.questionId),
      outcome_slot_count: Number(log.args.outcomeSlotCount),
      ...commonEventRow(log, block, transaction),
    }),
  },
  {
    eventName: 'ConditionResolution',
    tableName: 'conditional_tokens_condition_resolution',
    topic0: topic0(EVENT_SIGNATURES.ConditionResolution),
    toRow: (log, block, transaction) => ({
      condition_id: asLowerString(log.args.conditionId),
      oracle: asLowerString(log.args.oracle),
      question_id: asLowerString(log.args.questionId),
      outcome_slot_count: Number(log.args.outcomeSlotCount),
      payout_numerators: asStringArray(log.args.payoutNumerators),
      ...commonEventRow(log, block, transaction),
    }),
  },
  {
    eventName: 'PositionSplit',
    tableName: 'conditional_tokens_position_split',
    topic0: topic0(EVENT_SIGNATURES.PositionSplit),
    toRow: (log, block, transaction) => ({
      stakeholder: asLowerString(log.args.stakeholder),
      collateral_token: asLowerString(log.args.collateralToken),
      parent_collection_id: asLowerString(log.args.parentCollectionId),
      condition_id: asLowerString(log.args.conditionId),
      partition: asStringArray(log.args.partition),
      amount: asString(log.args.amount),
      ...commonEventRow(log, block, transaction),
    }),
  },
  {
    eventName: 'PositionsMerge',
    tableName: 'conditional_tokens_positions_merge',
    topic0: topic0(EVENT_SIGNATURES.PositionsMerge),
    toRow: (log, block, transaction) => ({
      stakeholder: asLowerString(log.args.stakeholder),
      collateral_token: asLowerString(log.args.collateralToken),
      parent_collection_id: asLowerString(log.args.parentCollectionId),
      condition_id: asLowerString(log.args.conditionId),
      partition: asStringArray(log.args.partition),
      amount: asString(log.args.amount),
      ...commonEventRow(log, block, transaction),
    }),
  },
  {
    eventName: 'PayoutRedemption',
    tableName: 'conditional_tokens_payout_redemption',
    topic0: topic0(EVENT_SIGNATURES.PayoutRedemption),
    toRow: (log, block, transaction) => ({
      redeemer: asLowerString(log.args.redeemer),
      collateral_token: asLowerString(log.args.collateralToken),
      parent_collection_id: asLowerString(log.args.parentCollectionId),
      condition_id: asLowerString(log.args.conditionId),
      index_sets: asStringArray(log.args.indexSets),
      payout: asString(log.args.payout),
      ...commonEventRow(log, block, transaction),
    }),
  },
  {
    eventName: 'URI',
    tableName: 'conditional_tokens_uri',
    topic0: topic0(EVENT_SIGNATURES.URI),
    toRow: (log, block, transaction) => ({
      value: asString(log.args.value),
      id: asString(log.args.id),
      ...commonEventRow(log, block, transaction),
    }),
  },
];

const SPEC_BY_EVENT = new Map(CONDITIONAL_EVENT_SPECS.map(spec => [spec.eventName, spec]));

function buildBlockMap(blocks: readonly any[]): Map<number, ProcessedBlock> {
  const blockMap = new Map<number, ProcessedBlock>();
  for (const block of blocks) {
    blockMap.set(Number(block.number), {
      number: Number(block.number),
      timestamp: Number(block.timestamp),
      hash: block.hash!,
      gasUsed: BigInt(block.gasUsed || 0),
      gasLimit: BigInt(block.gasLimit || 0),
      baseFeePerGas: BigInt(block.baseFeePerGas || 0),
    });
  }
  return blockMap;
}

function buildTransactionMap(transactions: readonly any[]): Map<string, ProcessedTransaction> {
  const txMap = new Map<string, ProcessedTransaction>();
  for (const tx of transactions) {
    txMap.set(tx.hash!, {
      hash: tx.hash!,
      from: tx.from!,
      to: tx.to || null,
      value: BigInt(tx.value || 0),
      gas: BigInt(tx.gas || 0),
      nonce: BigInt(tx.nonce || 0),
      maxFeePerGas: tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : null,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? BigInt(tx.maxPriorityFeePerGas) : null,
    });
  }
  return txMap;
}

async function flushCollectors(
  specs: ConditionalTokensEventSpec[],
  collectors: Map<string, BatchCollector<ConditionalTokensRow>>
): Promise<void> {
  for (const spec of specs) {
    await collectors.get(spec.eventName)!.flush();
  }
}

async function fetchAndInsertRange(
  client: HypersyncClient,
  specs: ConditionalTokensEventSpec[],
  collectors: Map<string, BatchCollector<ConditionalTokensRow>>,
  fromBlock: number,
  toBlock: number
): Promise<number> {
  if (fromBlock >= toBlock) return fromBlock;

  const topicFilters = specs.map(spec => spec.topic0);
  let currentBlock = fromBlock;
  let totalLogs = 0;
  let totalRows = 0;

  while (currentBlock < toBlock) {
    const query: Query = {
      fromBlock: currentBlock,
      toBlock,
      logs: [{
        address: [config.contracts.conditionalTokens],
        topics: [topicFilters],
      }],
      fieldSelection: {
        log: [
          'Address', 'Data', 'Topic0', 'Topic1', 'Topic2', 'Topic3',
          'BlockNumber', 'TransactionHash', 'TransactionIndex', 'LogIndex'
        ],
        block: [
          'Number', 'Timestamp', 'Hash',
          'GasUsed', 'GasLimit', 'BaseFeePerGas'
        ],
        transaction: [
          'Hash', 'From', 'To', 'Value',
          'Gas', 'Nonce', 'MaxFeePerGas', 'MaxPriorityFeePerGas'
        ],
      },
    };

    const response = await client.get(query);
    const logs = [...response.data.logs].sort((a, b) =>
      Number(a.blockNumber) - Number(b.blockNumber) ||
      Number(a.transactionIndex) - Number(b.transactionIndex) ||
      Number(a.logIndex) - Number(b.logIndex)
    );

    const blockMap = buildBlockMap(response.data.blocks);
    const txMap = buildTransactionMap(response.data.transactions);

    totalLogs += logs.length;

    for (const log of logs) {
      const decodedLog = decodeLog(log, ConditionalTokensAbi);
      if (!decodedLog) continue;

      const spec = SPEC_BY_EVENT.get(decodedLog.eventName as ConditionalTokensEventName);
      if (!spec) continue;

      const block = blockMap.get(Number(log.blockNumber));
      const transaction = txMap.get(log.transactionHash!);
      if (!block || !transaction) {
        console.error(`Missing block or transaction data for conditional tokens log at ${log.blockNumber}:${log.logIndex}`);
        continue;
      }

      await collectors.get(spec.eventName)!.add(spec.toRow(decodedLog, block, transaction));
      totalRows++;
    }

    await flushCollectors(specs, collectors);

    let nextBlock = Number(response.nextBlock);
    if (!Number.isFinite(nextBlock) || nextBlock <= currentBlock) {
      console.warn(`Hypersync did not advance from block ${currentBlock}; forcing progress to ${toBlock}`);
      nextBlock = toBlock;
    }
    nextBlock = Math.min(nextBlock, toBlock);

    console.log(`  Conditional tokens page: ${logs.length} logs, next block ${nextBlock}/${toBlock}`);
    currentBlock = nextBlock;
  }

  console.log(`Inserted ${totalRows} conditional-token rows from ${totalLogs} logs (${fromBlock} to ${currentBlock})`);
  return currentBlock;
}

function progressByEvent(progress: ConditionalTokensProgress[]): Map<string, ConditionalTokensProgress> {
  return new Map(progress.map(item => [item.eventName, item]));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runConditionalTokensEventsFlow() {
  console.log('Starting Polymarket Hypersync Indexer [flow: conditional-tokens-events]\n');
  console.log(`ConditionalTokens contract: ${config.contracts.conditionalTokens}`);

  await ensureConditionalTokensTables();

  const client = new HypersyncClient({
    url: config.hypersyncUrl,
    apiToken: config.apiToken,
  });

  const collectors: Map<string, BatchCollector<ConditionalTokensRow>> = new Map(
    CONDITIONAL_EVENT_SPECS.map(spec => [
      spec.eventName,
      new BatchCollector<ConditionalTokensRow>(spec.tableName, config.batchSize, clickhouse),
    ])
  );

  try {
    if (config.testMode) {
      console.log(`TEST MODE`);
      console.log(`Block range: ${config.testStartBlock} to ${config.testEndBlock} (${config.testEndBlock - config.testStartBlock} blocks)\n`);
      await fetchAndInsertRange(client, CONDITIONAL_EVENT_SPECS, collectors, config.testStartBlock, config.testEndBlock);
      return;
    }

    while (true) {
      const progress = await getConditionalTokensProgress(CONDITIONAL_EVENT_SPECS);
      const byEvent = progressByEvent(progress);
      const mostAdvancedNextBlock = Math.max(...progress.map(item => item.nextBlock));
      const laggingSpecs = CONDITIONAL_EVENT_SPECS.filter(spec => {
        const item = byEvent.get(spec.eventName);
        return item ? item.nextBlock < mostAdvancedNextBlock : true;
      });

      if (laggingSpecs.length > 0) {
        console.log(`Catching up lagging conditional-token tables to block ${mostAdvancedNextBlock}`);

        for (const spec of laggingSpecs) {
          const specProgress = byEvent.get(spec.eventName);
          const fromBlock = specProgress?.nextBlock ?? config.conditionalTokens.startBlock;
          console.log(`  ${spec.tableName}: ${fromBlock} -> ${mostAdvancedNextBlock}`);
          const reached = await fetchAndInsertRange(client, [spec], collectors, fromBlock, mostAdvancedNextBlock);
          // Update in-memory progress so tables with 0 events in the range don't
          // loop forever (their DB max_block stays behind but we've fetched the range).
          if (specProgress) specProgress.nextBlock = reached;
        }

        // Only loop back if something genuinely couldn't advance (shouldn't happen).
        const stillLagging = CONDITIONAL_EVENT_SPECS.some(spec => {
          const item = byEvent.get(spec.eventName);
          return (item?.nextBlock ?? 0) < mostAdvancedNextBlock;
        });
        if (stillLagging) continue;
      }

      const commonNextBlock = mostAdvancedNextBlock;
      const latestExclusiveBlock = config.endBlock ?? ((await client.getHeight()) + 1);

      if (commonNextBlock < latestExclusiveBlock) {
        console.log(`All conditional-token tables aligned at ${commonNextBlock}; syncing to ${latestExclusiveBlock}`);
        await fetchAndInsertRange(client, CONDITIONAL_EVENT_SPECS, collectors, commonNextBlock, latestExclusiveBlock);
        continue;
      }

      if (!config.streamMode) {
        console.log('\nReached chain head, exiting');
        break;
      }

      console.log(`Conditional-token tables caught up at ${commonNextBlock}; sleeping ${config.conditionalTokens.pollMs}ms`);
      await sleep(config.conditionalTokens.pollMs);
    }
  } catch (error) {
    console.error('\nError during conditional tokens indexing:', error);
    throw error;
  } finally {
    await flushCollectors(CONDITIONAL_EVENT_SPECS, collectors);
    await clickhouse.close();
  }
}
