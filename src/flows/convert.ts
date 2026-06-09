import { HypersyncClient, Query } from '@envio-dev/hypersync-client';
import { keccak256, toHex } from 'viem';
import { BatchCollector } from '../batchCollector';
import { clickhouse, ensureConvertTable, getLastConvertBlock } from '../clickhouse';
import { config } from '../config';
import { NegRiskAdapterAbi, decodeLog } from '../decoder';
import type { CommonEventRow, DecodedLog, ProcessedBlock, ProcessedTransaction } from '../types';

const POSITIONS_CONVERTED_SIG = 'PositionsConverted(address,bytes32,uint256,uint256)';
const positionsConvertedTopic = keccak256(toHex(POSITIONS_CONVERTED_SIG));

interface PositionsConvertedRow extends CommonEventRow {
  stakeholder: string;
  market_id: string;
  index_set: string;
  amount: string;
}

function buildBlockMap(blocks: readonly any[]): Map<number, ProcessedBlock> {
  const map = new Map<number, ProcessedBlock>();
  for (const block of blocks) {
    map.set(Number(block.number), {
      number: Number(block.number),
      timestamp: Number(block.timestamp),
      hash: block.hash!,
      gasUsed: BigInt(block.gasUsed || 0),
      gasLimit: BigInt(block.gasLimit || 0),
      baseFeePerGas: BigInt(block.baseFeePerGas || 0),
    });
  }
  return map;
}

function buildTransactionMap(transactions: readonly any[]): Map<string, ProcessedTransaction> {
  const map = new Map<string, ProcessedTransaction>();
  for (const tx of transactions) {
    map.set(tx.hash!, {
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
  return map;
}

function blockTimestamp(block: ProcessedBlock): string {
  return new Date(block.timestamp * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function toRow(
  log: DecodedLog,
  block: ProcessedBlock,
  transaction: ProcessedTransaction
): PositionsConvertedRow {
  return {
    event_id: `${log.transactionHash}-${log.logIndex}`,
    stakeholder: String(log.args.stakeholder).toLowerCase(),
    market_id: String(log.args.marketId).toLowerCase(),
    index_set: (log.args.indexSet as bigint).toString(),
    amount: (log.args.amount as bigint).toString(),
    block_number: block.number,
    log_index: log.logIndex,
    transaction_index: log.transactionIndex,
    contract_address: String(log.address).toLowerCase(),
    block_hash: String(block.hash).toLowerCase(),
    block_timestamp: blockTimestamp(block),
    gas_used: Number(block.gasUsed),
    gas_limit: Number(block.gasLimit),
    base_fee_per_gas: block.baseFeePerGas.toString(),
    transaction_hash: String(transaction.hash).toLowerCase(),
    transaction_from: String(transaction.from).toLowerCase(),
    transaction_to: transaction.to ? String(transaction.to).toLowerCase() : '',
    transaction_value: transaction.value.toString(),
    transaction_gas: Number(transaction.gas),
    transaction_nonce: Number(transaction.nonce),
    max_fee_per_gas: transaction.maxFeePerGas?.toString() || '0',
    max_priority_fee_per_gas: transaction.maxPriorityFeePerGas?.toString() || '0',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runConvertFlow() {
  console.log('Starting Polymarket Hypersync Indexer [flow: convert]\n');
  console.log(`NegRiskAdapter contract: ${config.contracts.negRiskAdapter}`);

  await ensureConvertTable();

  const client = new HypersyncClient({
    url: config.hypersyncUrl,
    apiToken: config.apiToken,
  });

  const collector = new BatchCollector<PositionsConvertedRow>(
    'positions_converted',
    config.batchSize,
    clickhouse
  );

  try {
    if (config.testMode) {
      console.log(`TEST MODE`);
      console.log(`Block range: ${config.testStartBlock} to ${config.testEndBlock} (${config.testEndBlock - config.testStartBlock} blocks)\n`);
      await fetchAndInsert(client, collector, config.testStartBlock, config.testEndBlock);
      return;
    }

    let resumeBlock = await getLastConvertBlock();

    while (true) {
      const latestExclusiveBlock = config.endBlock ?? ((await client.getHeight()) + 1);

      if (resumeBlock < latestExclusiveBlock) {
        console.log(`Syncing PositionsConverted from block ${resumeBlock} to ${latestExclusiveBlock}`);
        resumeBlock = await fetchAndInsert(client, collector, resumeBlock, latestExclusiveBlock);
        if (!config.streamMode) {
          console.log('\nReached chain head, exiting');
          break;
        }
        continue;
      }

      if (!config.streamMode) {
        console.log('\nReached chain head, exiting');
        break;
      }

      console.log(`Caught up at block ${resumeBlock}; sleeping ${config.convert.pollMs}ms`);
      await sleep(config.convert.pollMs);
    }
  } catch (error) {
    console.error('\nError during convert indexing:', error);
    throw error;
  } finally {
    await collector.flush();
    await clickhouse.close();
  }
}

async function fetchAndInsert(
  client: HypersyncClient,
  collector: BatchCollector<PositionsConvertedRow>,
  fromBlock: number,
  toBlock: number
): Promise<number> {
  if (fromBlock >= toBlock) return toBlock;

  let currentBlock = fromBlock;
  let totalLogs = 0;
  let totalRows = 0;
  let pageCount = 0;

  while (currentBlock < toBlock) {
    pageCount++;

    const query: Query = {
      fromBlock: currentBlock,
      toBlock,
      logs: [{
        address: [config.contracts.negRiskAdapter],
        topics: [[positionsConvertedTopic]],
      }],
      fieldSelection: {
        log: [
          'Address', 'Data', 'Topic0', 'Topic1', 'Topic2', 'Topic3',
          'BlockNumber', 'TransactionHash', 'TransactionIndex', 'LogIndex',
        ],
        block: [
          'Number', 'Timestamp', 'Hash',
          'GasUsed', 'GasLimit', 'BaseFeePerGas',
        ],
        transaction: [
          'Hash', 'From', 'To', 'Value',
          'Gas', 'Nonce', 'MaxFeePerGas', 'MaxPriorityFeePerGas',
        ],
      },
    };

    const response = await client.get(query);
    const logs = [...response.data.logs].sort(
      (a, b) =>
        Number(a.blockNumber) - Number(b.blockNumber) ||
        Number(a.transactionIndex) - Number(b.transactionIndex) ||
        Number(a.logIndex) - Number(b.logIndex)
    );

    const blockMap = buildBlockMap(response.data.blocks);
    const txMap = buildTransactionMap(response.data.transactions);

    totalLogs += logs.length;

    for (const log of logs) {
      const decodedLog = decodeLog(log, NegRiskAdapterAbi);
      if (!decodedLog || decodedLog.eventName !== 'PositionsConverted') continue;

      const block = blockMap.get(Number(log.blockNumber));
      const transaction = txMap.get(log.transactionHash!);

      if (!block || !transaction) {
        console.error(`Missing block or transaction data for PositionsConverted log at ${log.blockNumber}:${log.logIndex}`);
        continue;
      }

      await collector.add(toRow(decodedLog, block, transaction));
      totalRows++;
    }

    await collector.flush();

    let nextBlock = Number(response.nextBlock);
    if (!Number.isFinite(nextBlock) || nextBlock <= currentBlock) {
      console.warn(`Hypersync did not advance from block ${currentBlock}; forcing progress to ${toBlock}`);
      nextBlock = toBlock;
    }
    nextBlock = Math.min(nextBlock, toBlock);

    console.log(`  Page ${pageCount}: ${logs.length} logs, next block ${nextBlock}/${toBlock}`);
    currentBlock = nextBlock;
  }

  console.log(`Inserted ${totalRows} PositionsConverted rows from ${totalLogs} logs (${fromBlock} to ${currentBlock})`);
  return currentBlock;
}
