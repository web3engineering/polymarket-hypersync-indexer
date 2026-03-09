import type { DecodedLog, ProcessedBlock, ProcessedTransaction, OrderFilledRow, OrderFilledBufferItem } from './types';
import { BatchCollector } from './batchCollector';

export class EventCorrelator {
  private orderFilledBuffers: Map<string, OrderFilledBufferItem[]> = new Map();
  private lastProcessedLogIndex: Map<string, number> = new Map();
  private batchCollector: BatchCollector;

  constructor(batchCollector: BatchCollector) {
    this.batchCollector = batchCollector;
  }

  async processLog(
    log: DecodedLog,
    block: ProcessedBlock,
    transaction: ProcessedTransaction
  ): Promise<void> {
    if (log.eventName === 'OrderFilled') {
      await this.bufferOrderFilled(log, block, transaction);
    } else if (log.eventName === 'OrdersMatched') {
      await this.processOrdersMatched(log, block, transaction);
    }
  }

  private async bufferOrderFilled(
    log: DecodedLog,
    block: ProcessedBlock,
    transaction: ProcessedTransaction
  ): Promise<void> {
    const txHash = transaction.hash;

    if (!this.orderFilledBuffers.has(txHash)) {
      this.orderFilledBuffers.set(txHash, []);
    }

    const buffer = this.orderFilledBuffers.get(txHash)!;
    buffer.push({
      log,
      block,
      transaction,
      logIndex: log.logIndex,
    });
  }

  private async processOrdersMatched(
    log: DecodedLog,
    block: ProcessedBlock,
    transaction: ProcessedTransaction
  ): Promise<void> {
    const txHash = transaction.hash;
    const currentLogIndex = log.logIndex;
    const takerOrderHash = log.args.takerOrderHash;
    const takerOrderMaker = log.args.takerOrderMaker;
    const makerAssetId = log.args.makerAssetId;
    const takerAssetId = log.args.takerAssetId;

    const allBuffered = this.orderFilledBuffers.get(txHash) || [];

    if (allBuffered.length === 0) {
      console.warn(`⚠️  No buffered OrderFilled events for tx ${txHash}`);
      return;
    }

    // Get the log index boundary
    const lastLogIndex = this.lastProcessedLogIndex.get(txHash) ?? -1;

    // Filter to OrderFilled events between last OrdersMatched and this one
    const relevantEvents = allBuffered.filter(item =>
      item.logIndex > lastLogIndex && item.logIndex < currentLogIndex
    );

    if (relevantEvents.length === 0) {
      console.warn(`⚠️  No relevant OrderFilled events for OrdersMatched at logIndex ${currentLogIndex}`);
      this.orderFilledBuffers.delete(txHash);
      this.lastProcessedLogIndex.delete(txHash);
      return;
    }

    // Sort by logIndex
    relevantEvents.sort((a, b) => a.logIndex - b.logIndex);

    // Drop the last OrderFilled (summary event)
    const droppedEvent = relevantEvents.pop();

    // Update last processed log index
    this.lastProcessedLogIndex.set(txHash, currentLogIndex);

    // Determine asset and side
    let asset: string;
    let takerSide: string;

    if (makerAssetId === 0n) {
      // Taker is buying (spending USDC to get tokens)
      asset = takerAssetId.toString();
      takerSide = 'B';
    } else if (takerAssetId === 0n) {
      // Taker is selling (selling tokens for USDC)
      asset = makerAssetId.toString();
      takerSide = 'S';
    } else {
      console.error(`❌ Invalid OrdersMatched: both assets non-zero for ${takerOrderHash}`);
      return;
    }

    // Process all remaining OrderFilled events as makers
    for (const bufferedItem of relevantEvents) {
      const filledLog = bufferedItem.log;
      const filledBlock = bufferedItem.block;
      const filledTx = bufferedItem.transaction;

      const maker = filledLog.args.maker;
      const filledMakerAssetId = filledLog.args.makerAssetId;
      const filledTakerAssetId = filledLog.args.takerAssetId;

      // Determine maker's side
      let makerSide: string;
      if (filledMakerAssetId === 0n) {
        makerSide = 'B'; // Maker buying tokens with USDC
      } else {
        makerSide = 'S'; // Maker selling tokens for USDC
      }

      // Determine amounts
      const amountToken = filledMakerAssetId === 0n
        ? filledLog.args.takerAmountFilled.toString()
        : filledLog.args.makerAmountFilled.toString();
      const amountUsdc = filledMakerAssetId === 0n
        ? filledLog.args.makerAmountFilled.toString()
        : filledLog.args.takerAmountFilled.toString();

      const hereAsset = filledMakerAssetId === 0n
        ? filledTakerAssetId
        : filledMakerAssetId;

      const makerRow: OrderFilledRow = {
        event_id: `${filledLog.transactionHash}-${filledLog.logIndex}`,
        order_hash: filledLog.args.orderHash,
        wallet: maker,
        is_maker: true,
        side: makerSide,
        asset: hereAsset.toString(),
        amount_token: amountToken,
        amount_usdc: amountUsdc,
        fee: filledLog.args.fee.toString(),
        block_number: filledBlock.number,
        log_index: filledLog.logIndex,
        transaction_index: filledLog.transactionIndex,
        contract_address: filledLog.address,
        block_hash: filledBlock.hash,
        block_timestamp: new Date(filledBlock.timestamp * 1000).toISOString().slice(0, 19).replace('T', ' '),
        gas_used: Number(filledBlock.gasUsed),
        gas_limit: Number(filledBlock.gasLimit),
        base_fee_per_gas: filledBlock.baseFeePerGas.toString(),
        transaction_hash: filledTx.hash,
        transaction_from: filledTx.from,
        transaction_to: filledTx.to || '',
        transaction_value: filledTx.value.toString(),
        transaction_gas: Number(filledTx.gas),
        transaction_nonce: Number(filledTx.nonce),
        max_fee_per_gas: filledTx.maxFeePerGas?.toString() || '0',
        max_priority_fee_per_gas: filledTx.maxPriorityFeePerGas?.toString() || '0',
      };

      await this.batchCollector.add(makerRow);
    }

    // Add taker row from OrdersMatched event
    const takerAmountToken = makerAssetId === 0n
      ? log.args.takerAmountFilled.toString()
      : log.args.makerAmountFilled.toString();
    const takerAmountUsdc = makerAssetId === 0n
      ? log.args.makerAmountFilled.toString()
      : log.args.takerAmountFilled.toString();

    const takerRow: OrderFilledRow = {
      event_id: `${log.transactionHash}-${log.logIndex}`,
      order_hash: takerOrderHash,
      wallet: takerOrderMaker,
      is_maker: false,
      side: takerSide,
      asset: asset,
      amount_token: takerAmountToken,
      amount_usdc: takerAmountUsdc,
      fee: '0',
      block_number: block.number,
      log_index: log.logIndex,
      transaction_index: log.transactionIndex,
      contract_address: log.address,
      block_hash: block.hash,
      block_timestamp: new Date(block.timestamp * 1000).toISOString().slice(0, 19).replace('T', ' '),
      gas_used: Number(block.gasUsed),
      gas_limit: Number(block.gasLimit),
      base_fee_per_gas: block.baseFeePerGas.toString(),
      transaction_hash: transaction.hash,
      transaction_from: transaction.from,
      transaction_to: transaction.to || '',
      transaction_value: transaction.value.toString(),
      transaction_gas: Number(transaction.gas),
      transaction_nonce: Number(transaction.nonce),
      max_fee_per_gas: transaction.maxFeePerGas?.toString() || '0',
      max_priority_fee_per_gas: transaction.maxPriorityFeePerGas?.toString() || '0',
    };

    await this.batchCollector.add(takerRow);

    console.log(`✅ Processed OrdersMatched: ${relevantEvents.length} makers + 1 taker for ${takerOrderHash}`);

    // Clean up buffers
    this.orderFilledBuffers.delete(txHash);
    this.lastProcessedLogIndex.delete(txHash);
  }

  async flush(): Promise<void> {
    await this.batchCollector.flush();
  }
}
