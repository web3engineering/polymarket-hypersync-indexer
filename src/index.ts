import { HypersyncClient, Query } from '@envio-dev/hypersync-client';
import { keccak256, toHex } from 'viem';
import { config } from './config';
import { clickhouse, ensureTable, getLastBlock } from './clickhouse';
import { decodeLog } from './decoder';
import { EventCorrelator } from './correlator';
import { BatchCollector } from './batchCollector';
import type { ProcessedBlock, ProcessedTransaction } from './types';

// Event signatures
const ORDER_FILLED_SIG = "OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)";
const ORDERS_MATCHED_SIG = "OrdersMatched(bytes32,address,uint256,uint256,uint256,uint256)";

// Calculate topic0 hashes
const orderFilledTopic = keccak256(toHex(ORDER_FILLED_SIG));
const ordersMatchedTopic = keccak256(toHex(ORDERS_MATCHED_SIG));

async function main() {
  console.log('🚀 Starting Polymarket Hypersync Indexer\n');

  // Ensure ClickHouse table exists
  console.log('📊 Setting up ClickHouse...');
  await ensureTable();

  // Get last processed block (unless in test mode)
  let startBlock: number;
  let endBlock: number | undefined;

  if (config.testMode) {
    startBlock = config.testStartBlock;
    endBlock = config.testEndBlock;
    console.log(`🧪 TEST MODE`);
    console.log(`📍 Block range: ${startBlock} to ${endBlock} (${endBlock - startBlock} blocks)\n`);
  } else {
    startBlock = await getLastBlock();
    console.log(`📍 Starting from block: ${startBlock}`);
    if (config.streamMode) {
      console.log(`📍 Mode: STREAMING (continuous)\n`);
    } else {
      console.log(`📍 Mode: Historical sync only\n`);
    }
  }

  // Initialize Hypersync client
  const client = new HypersyncClient({
    url: config.hypersyncUrl,
    apiToken: config.apiToken
  });

  // Create batch collector and correlator
  const batchCollector = new BatchCollector('polymarket_order_filled_v3', config.batchSize, clickhouse);
  const correlator = new EventCorrelator(batchCollector);

  // Build query
  const query: Query = {
    fromBlock: startBlock,
    ...(endBlock ? { toBlock: endBlock } : {}),
    logs: [{
      address: [
        config.contracts.polymarketMain,
        config.contracts.polymarketNeg,
        config.contracts.polymarketNegAdapter
      ],
      topics: [[orderFilledTopic, ordersMatchedTopic]]
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

  console.log('⚡ Fetching and processing logs...\n');
  const startTime = Date.now();

  let currentBlock = startBlock;
  let pageCount = 0;
  let totalLogs = 0;
  let totalProcessed = 0;

  // Set up periodic flush (every 10 seconds)
  const flushInterval = setInterval(async () => {
    if (batchCollector.getBufferLength() > 0) {
      console.log(`⏰ Periodic flush: ${batchCollector.getBufferLength()} events in buffer`);
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

      // Get current chain height
      const chainHeight = endBlock || response.archiveHeight || response.nextBlock;
      const logs = response.data.logs;
      const blocks = response.data.blocks;
      const transactions = response.data.transactions;

      totalLogs += logs.length;

      // Create lookup maps for blocks and transactions
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

      // Process each transaction's logs in order
      for (const [txHash, txLogs] of logsByTx) {
        // Sort by log index
        txLogs.sort((a, b) => Number(a.logIndex) - Number(b.logIndex));

        for (const log of txLogs) {
          // Decode the log
          const decodedLog = decodeLog(log);
          if (!decodedLog) continue;

          // Get block and transaction data
          const block = blockMap.get(Number(log.blockNumber));
          const transaction = txMap.get(txHash);

          if (!block || !transaction) {
            console.error(`❌ Missing block or transaction data for log at ${log.blockNumber}:${log.logIndex}`);
            continue;
          }

          // Process through correlator
          await correlator.processLog(decodedLog, block, transaction);
          totalProcessed++;
        }
      }

      console.log(`  Page ${pageCount}: Processed ${logs.length} logs (blocks ${currentBlock} to ${response.nextBlock}${endBlock ? '' : ', chain at ' + chainHeight})`);

      // Check if we've caught up to the chain head or end block
      if (response.nextBlock >= chainHeight || response.nextBlock === currentBlock) {
        if (config.testMode || !config.streamMode) {
          console.log('\n✅ Reached target block, exiting');
          break;
        }

        // In streaming mode, wait a bit before fetching next batch
        console.log(`\n💤 Caught up to chain head (${chainHeight}), waiting 5 seconds for new blocks...`);
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Get latest chain height and continue if new blocks arrived
        const latestHeight = await client.getHeight();
        if (latestHeight > chainHeight) {
          console.log(`📈 New blocks detected! Chain now at ${latestHeight}\n`);
          currentBlock = response.nextBlock;
          continue;
        }
      } else {
        currentBlock = response.nextBlock;
      }
    }

    // Final flush
    console.log('\n🔄 Final flush...');
    await correlator.flush();

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('\n✅ Indexing complete!');
    console.log('═══════════════════════════════════════');
    console.log(`📊 Total pages: ${pageCount}`);
    console.log(`📝 Total logs fetched: ${totalLogs}`);
    console.log(`⚙️  Total logs processed: ${totalProcessed}`);
    console.log(`⏱️  Total time: ${totalTime}s`);
    console.log(`🏁 Final block: ${currentBlock}`);
    console.log('═══════════════════════════════════════\n');

  } catch (error) {
    console.error('\n❌ Error during indexing:', error);
    throw error;
  } finally {
    // Clear interval
    clearInterval(flushInterval);

    // Close ClickHouse connection
    await clickhouse.close();
  }
}

// Run the indexer
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
