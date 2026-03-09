export interface DecodedLog {
  eventName: string;
  args: any;
  address: string;
  blockNumber: number;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  data: string;
  topics: string[];
}

export interface ProcessedBlock {
  number: number;
  timestamp: number;
  hash: string;
  gasUsed: bigint;
  gasLimit: bigint;
  baseFeePerGas: bigint;
}

export interface ProcessedTransaction {
  hash: string;
  from: string;
  to: string | null;
  value: bigint;
  gas: bigint;
  nonce: bigint;
  maxFeePerGas: bigint | null;
  maxPriorityFeePerGas: bigint | null;
}

export interface OrderFilledRow {
  event_id: string;
  order_hash: string;
  wallet: string;
  is_maker: boolean;
  side: string;
  asset: string;
  amount_token: string;
  amount_usdc: string;
  fee: string;
  block_number: number;
  log_index: number;
  transaction_index: number;
  contract_address: string;
  block_hash: string;
  block_timestamp: string;
  gas_used: number;
  gas_limit: number;
  base_fee_per_gas: string;
  transaction_hash: string;
  transaction_from: string;
  transaction_to: string;
  transaction_value: string;
  transaction_gas: number;
  transaction_nonce: number;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
}

export interface OrderFilledBufferItem {
  log: DecodedLog;
  block: ProcessedBlock;
  transaction: ProcessedTransaction;
  logIndex: number;
}
