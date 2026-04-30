import { decodeEventLog } from 'viem';
import { PolymarketAbi } from './abis/PolymarketAbi';
import { PolymarketV2Abi } from './abis/PolymarketV2Abi';
import type { DecodedLog } from './types';

export function decodeLog(log: any, abi: typeof PolymarketAbi | typeof PolymarketV2Abi = PolymarketAbi): DecodedLog | null {
  try {
    const decoded = decodeEventLog({
      abi,
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

export { PolymarketAbi, PolymarketV2Abi };
