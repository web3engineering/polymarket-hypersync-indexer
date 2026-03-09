import { decodeEventLog } from 'viem';
import { PolymarketAbi } from './abis/PolymarketAbi';
import type { DecodedLog } from './types';

export function decodeLog(log: any): DecodedLog | null {
  try {
    const decoded = decodeEventLog({
      abi: PolymarketAbi,
      data: log.data as `0x${string}`,
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
    });

    return {
      eventName: decoded.eventName,
      args: decoded.args,
      address: log.address,
      blockNumber: Number(log.blockNumber),
      transactionHash: log.transactionHash,
      transactionIndex: Number(log.transactionIndex),
      logIndex: Number(log.logIndex),
      data: log.data,
      topics: log.topics,
    };
  } catch (error) {
    console.error(`Failed to decode log at block ${log.blockNumber}, logIndex ${log.logIndex}:`, error);
    return null;
  }
}
