import type { DecodedLog, ProcessedBlock, ProcessedTransaction, OrderFilledRow, OrderFilledBufferItem } from './types';
import { BatchCollector } from './batchCollector';

// Side enum: 0 = BUY, 1 = SELL
// BUY:  maker pays USDC (makerAmountFilled), receives tokens (takerAmountFilled)
// SELL: maker pays tokens (makerAmountFilled), receives USDC (takerAmountFilled)

export class EventCorrelatorV2 {
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

    this.orderFilledBuffers.get(txHash)!.push({
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
    const takerOrderHash = log.args.takerOrderHash as string;
    const takerOrderMaker = log.args.takerOrderMaker as string;
    const side = Number(log.args.side); // 0=BUY, 1=SELL

    const allBuffered = this.orderFilledBuffers.get(txHash) || [];

    if (allBuffered.length === 0) {
      console.warn(`⚠️  No buffered OrderFilled events for tx ${txHash}`);
      return;
    }

    const lastLogIndex = this.lastProcessedLogIndex.get(txHash) ?? -1;

    const relevantEvents = allBuffered.filter(item =>
      item.logIndex > lastLogIndex && item.logIndex < currentLogIndex
    );

    if (relevantEvents.length === 0) {
      console.warn(`⚠️  No relevant OrderFilled events for OrdersMatched at logIndex ${currentLogIndex}`);
      this.orderFilledBuffers.delete(txHash);
      this.lastProcessedLogIndex.delete(txHash);
      return;
    }

    relevantEvents.sort((a, b) => a.logIndex - b.logIndex);

    // Drop the last OrderFilled (summary event for taker), but capture its builder/metadata
    const summaryEvent = relevantEvents.pop();
    const takerBuilder = (summaryEvent?.log.args.builder as string) || '';
    const takerMetadata = (summaryEvent?.log.args.metadata as string) || '';

    this.lastProcessedLogIndex.set(txHash, currentLogIndex);

    // Process remaining OrderFilled events as maker rows
    for (const bufferedItem of relevantEvents) {
      const filledLog = bufferedItem.log;
      const filledBlock = bufferedItem.block;
      const filledTx = bufferedItem.transaction;

      const makerSide = Number(filledLog.args.side); // 0=BUY, 1=SELL
      const sideChar = makerSide === 0 ? 'B' : 'S';
      const tokenId = (filledLog.args.tokenId as bigint).toString();

      const amountToken = makerSide === 0
        ? (filledLog.args.takerAmountFilled as bigint).toString()
        : (filledLog.args.makerAmountFilled as bigint).toString();
      const amountUsdc = makerSide === 0
        ? (filledLog.args.makerAmountFilled as bigint).toString()
        : (filledLog.args.takerAmountFilled as bigint).toString();

      const makerRow: OrderFilledRow = {
        event_id: `${filledLog.transactionHash}-${filledLog.logIndex}`,
        order_hash: filledLog.args.orderHash as string,
        wallet: filledLog.args.maker as string,
        is_maker: true,
        side: sideChar,
        asset: tokenId,
        amount_token: amountToken,
        amount_usdc: amountUsdc,
        fee: (filledLog.args.fee as bigint).toString(),
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
        builder: (filledLog.args.builder as string) || '',
        metadata: (filledLog.args.metadata as string) || '',
      };

      await this.batchCollector.add(makerRow);
    }

    // Add taker row from OrdersMatched
    const tokenId = (log.args.tokenId as bigint).toString();
    const takerSideChar = side === 0 ? 'B' : 'S';

    const takerAmountToken = side === 0
      ? (log.args.takerAmountFilled as bigint).toString()
      : (log.args.makerAmountFilled as bigint).toString();
    const takerAmountUsdc = side === 0
      ? (log.args.makerAmountFilled as bigint).toString()
      : (log.args.takerAmountFilled as bigint).toString();

    const takerRow: OrderFilledRow = {
      event_id: `${log.transactionHash}-${log.logIndex}`,
      order_hash: takerOrderHash,
      wallet: takerOrderMaker,
      is_maker: false,
      side: takerSideChar,
      asset: tokenId,
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
      builder: takerBuilder,
      metadata: takerMetadata,
    };

    await this.batchCollector.add(takerRow);

    console.log(`✅ [V2] Processed OrdersMatched: ${relevantEvents.length} makers + 1 taker for ${takerOrderHash}`);

    this.orderFilledBuffers.delete(txHash);
    this.lastProcessedLogIndex.delete(txHash);
  }

  async flush(): Promise<void> {
    await this.batchCollector.flush();
  }
}
