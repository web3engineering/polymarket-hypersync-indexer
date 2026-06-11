import { decodeEventLog } from 'viem';
import { PolymarketAbi } from './abis/PolymarketAbi';
import { PolymarketV2Abi } from './abis/PolymarketV2Abi';
import { ConditionalTokensAbi } from './abis/ConditionalTokensAbi';
import { NegRiskAdapterAbi } from './abis/NegRiskAdapterAbi';
import type { DecodedLog } from './types';

type SupportedAbi = typeof PolymarketAbi | typeof PolymarketV2Abi | typeof ConditionalTokensAbi | typeof NegRiskAdapterAbi;

export function decodeLog(log: any, abi: SupportedAbi = PolymarketAbi): DecodedLog | null {
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

export { PolymarketAbi, PolymarketV2Abi, ConditionalTokensAbi, NegRiskAdapterAbi };
