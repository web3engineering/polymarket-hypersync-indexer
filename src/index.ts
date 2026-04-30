import { HypersyncClient, Query } from '@envio-dev/hypersync-client';
import { keccak256, toHex } from 'viem';
import { config } from './config';
import { clickhouse, ensureTable, getLastBlock } from './clickhouse';
import { decodeLog, PolymarketAbi, PolymarketV2Abi } from './decoder';
import { EventCorrelator } from './correlator';
import { EventCorrelatorV2 } from './correlatorV2';
import { BatchCollector } from './batchCollector';
import type { ProcessedBlock, ProcessedTransaction } from './types';

// V1 event topic0 hashes
const ORDER_FILLED_SIG_V1 = "OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)";
const ORDERS_MATCHED_SIG_V1 = "OrdersMatched(bytes32,address,uint256,uint256,uint256,uint256)";
const orderFilledTopicV1 = keccak256(toHex(ORDER_FILLED_SIG_V1));
const ordersMatchedTopicV1 = keccak256(toHex(ORDERS_MATCHED_SIG_V1));

// V2 event topic0 hashes
const ORDER_FILLED_SIG_V2 = "OrderFilled(bytes32,address,address,uint8,uint256,uint256,uint256,uint256,bytes32,bytes32)";
const ORDERS_MATCHED_SIG_V2 = "OrdersMatched(bytes32,address,uint8,uint256,uint256,uint256)";
const orderFilledTopicV2 = keccak256(toHex(ORDER_FILLED_SIG_V2));
const ordersMatchedTopicV2 = keccak256(toHex(ORDERS_MATCHED_SIG_V2));

async function main() {
  const targets = config.indexTargets;
  console.log(`Starting Polymarket Hypersync Indexer [targets: ${targets.join(',')}]\n`);

  await ensureTable();

  // Collect active contracts by version
  const activeV1Contracts = targets.includes('v1') ? config.contracts.v1 : [];
  const activeV2Contracts = targets.includes('v2') ? config.contracts.v2 : [];
  const allActiveContracts = [...activeV1Contracts, ...activeV2Contracts];

  const v2ContractSet = new Set(activeV2Contracts.map(a => a.toLowerCase()));

  // Build the set of topic0 filters
  const activeTopics: string[] = [];
  if (targets.includes('v1')) {
    activeTopics.push(orderFilledTopicV1, ordersMatchedTopicV1);
  }
  if (targets.includes('v2')) {
    activeTopics.push(orderFilledTopicV2, ordersMatchedTopicV2);
  }

  // Determine start block
  let startBlock: number;
  let endBlock: number | undefined;

  if (config.testMode) {
    startBlock = config.testStartBlock;
    endBlock = config.testEndBlock;
    console.log(`TEST MODE`);
    console.log(`Block range: ${startBlock} to ${endBlock} (${endBlock - startBlock} blocks)\n`);
  } else {
    const versionBlocks: number[] = [];
    if (targets.includes('v1')) versionBlocks.push(await getLastBlock(config.contracts.v1));
    if (targets.includes('v2')) versionBlocks.push(await getLastBlock(config.contracts.v2));
    startBlock = Math.max(...versionBlocks);
    console.log(`Starting from block: ${startBlock}`);
    console.log(`Mode: ${config.streamMode ? 'STREAMING (continuous)' : 'Historical sync only'}\n`);
  }

  const client = new HypersyncClient({
    url: config.hypersyncUrl,
    apiToken: config.apiToken
  });

  const batchCollector = new BatchCollector('polymarket_order_filled_v3', config.batchSize, clickhouse);
  const correlatorV1 = new EventCorrelator(batchCollector);
  const correlatorV2 = new EventCorrelatorV2(batchCollector);

  const query: Query = {
    fromBlock: startBlock,
    ...(endBlock ? { toBlock: endBlock } : {}),
    logs: [{
      address: allActiveContracts,
      topics: [activeTopics]
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
      ]
    }
  };

  console.log('Fetching and processing logs...\n');
  const startTime = Date.now();

  let currentBlock = startBlock;
  let pageCount = 0;
  let totalLogs = 0;
  let totalProcessed = 0;

  const flushInterval = setInterval(async () => {
    if (batchCollector.getBufferLength() > 0) {
      console.log(`Periodic flush: ${batchCollector.getBufferLength()} events in buffer`);
      await batchCollector.flush();
    }
  }, 10000);

  try {
    while (true) {
      pageCount++;
      query.fromBlock = currentBlock;
      if (endBlock) {
        query.toBlock = endBlock;
      }

      const response = await client.get(query);

      const chainHeight = endBlock || response.archiveHeight || response.nextBlock;
      const logs = response.data.logs;
      const blocks = response.data.blocks;
      const transactions = response.data.transactions;

      totalLogs += logs.length;

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

      // Group logs by transaction and sort by logIndex
      const logsByTx = new Map<string, typeof logs>();
      for (const log of logs) {
        const txHash = log.transactionHash!;
        if (!logsByTx.has(txHash)) {
          logsByTx.set(txHash, []);
        }
        logsByTx.get(txHash)!.push(log);
      }

      for (const [txHash, txLogs] of logsByTx) {
        txLogs.sort((a, b) => Number(a.logIndex) - Number(b.logIndex));

        for (const log of txLogs) {
          const isV2 = log.address ? v2ContractSet.has(log.address.toLowerCase()) : false;
          const abi = isV2 ? PolymarketV2Abi : PolymarketAbi;
          const decodedLog = decodeLog(log, abi);
          if (!decodedLog) continue;

          const block = blockMap.get(Number(log.blockNumber));
          const transaction = txMap.get(txHash);

          if (!block || !transaction) {
            console.error(`Missing block or transaction data for log at ${log.blockNumber}:${log.logIndex}`);
            continue;
          }

          if (isV2) {
            await correlatorV2.processLog(decodedLog, block, transaction);
          } else {
            await correlatorV1.processLog(decodedLog, block, transaction);
          }
          totalProcessed++;
        }
      }

      console.log(`  Page ${pageCount}: Processed ${logs.length} logs (blocks ${currentBlock} to ${response.nextBlock}${endBlock ? '' : ', chain at ' + chainHeight})`);

      if (response.nextBlock >= chainHeight || response.nextBlock === currentBlock) {
        if (config.testMode || !config.streamMode) {
          console.log('\nReached target block, exiting');
          break;
        }

        console.log(`\nCaught up to chain head (${chainHeight}), waiting 5 seconds for new blocks...`);
        await new Promise(resolve => setTimeout(resolve, 5000));

        const latestHeight = await client.getHeight();
        if (latestHeight > chainHeight) {
          console.log(`New blocks detected! Chain now at ${latestHeight}\n`);
          currentBlock = response.nextBlock;
          continue;
        }
      } else {
        currentBlock = response.nextBlock;
      }
    }

    console.log('\nFinal flush...');
    await correlatorV1.flush();
    await correlatorV2.flush();

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('\nIndexing complete!');
    console.log('═══════════════════════════════════════');
    console.log(`Total pages: ${pageCount}`);
    console.log(`Total logs fetched: ${totalLogs}`);
    console.log(`Total logs processed: ${totalProcessed}`);
    console.log(`Total time: ${totalTime}s`);
    console.log(`Final block: ${currentBlock}`);
    console.log('═══════════════════════════════════════\n');

  } catch (error) {
    console.error('\nError during indexing:', error);
    throw error;
  } finally {
    clearInterval(flushInterval);
    await clickhouse.close();
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
