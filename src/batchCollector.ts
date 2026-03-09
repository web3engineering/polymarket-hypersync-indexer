import type { ClickHouseClient } from '@clickhouse/client';
import type { OrderFilledRow } from './types';

export class BatchCollector {
  private buffer: OrderFilledRow[] = [];
  private tableName: string;
  private batchSize: number;
  private clickhouse: ClickHouseClient;

  constructor(tableName: string, batchSize: number, clickhouseClient: ClickHouseClient) {
    this.tableName = tableName;
    this.batchSize = batchSize;
    this.clickhouse = clickhouseClient;
  }

  async add(row: OrderFilledRow) {
    this.buffer.push(row);

    if (this.buffer.length >= this.batchSize) {
      await this.flush();
    }
  }

  async flush() {
    if (this.buffer.length === 0) return;

    const batch = [...this.buffer];
    this.buffer.length = 0;

    try {
      await this.clickhouse.insert({
        table: 'polymarket.' + this.tableName,
        values: batch,
        format: 'JSONEachRow',
      });
      console.log(`✅ Inserted batch of ${batch.length} rows into ${this.tableName}`);
    } catch (error) {
      console.error(`❌ Error inserting batch into ${this.tableName}:`, error);
      // Re-add failed events back to the buffer for retry
      this.buffer.unshift(...batch);
      throw error;
    }
  }

  getBufferLength(): number {
    return this.buffer.length;
  }
}
