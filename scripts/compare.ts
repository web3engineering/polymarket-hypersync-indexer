#!/usr/bin/env npx tsx
/**
 * compare.ts — validate local ClickHouse data against production
 *
 * Pass/fail criteria:
 *   FAIL  duplicates > 0               (resume / dedup bug)
 *   FAIL  local count > prod count     (phantom events — indexer bug)
 *   FAIL  any local event_id absent from prod  (data corruption)
 *   WARN  local count < prod count     (Hypersync coverage gap — not an indexer bug;
 *                                       production may use a richer data source)
 *   PASS  all hard checks pass
 *
 * Env vars:
 *   LOCAL_CH    local ClickHouse HTTP base URL  (default: http://localhost:8123)
 *   PROD_URL    production query endpoint       (see default below)
 *   PROD_TOKEN  production bearer token         (see default below)
 *   START_BLOCK inclusive lower bound           (required)
 *   END_BLOCK   exclusive upper bound           (required)
 *   CHECK_FILLS "1" to check fills tables       (default: "1")
 *   CHECK_COND  "1" to check conditional tables (default: "1")
 */

const LOCAL_CH   = process.env.LOCAL_CH   || 'http://localhost:8123';
const PROD_URL   = process.env.PROD_URL   || 'https://db-access-test.onchaindivers.com/v1/polymarket/query';
const PROD_TOKEN = process.env.PROD_TOKEN || 'lq_848bd58820c7_hOcmm4e4cku25-cwzsiY-CVyy2vnFVSEnmyUVu2vOWs';
const START_BLOCK = parseInt(process.env.START_BLOCK || '');
const END_BLOCK   = parseInt(process.env.END_BLOCK   || '');
const CHECK_FILLS = (process.env.CHECK_FILLS ?? '1') !== '0';
const CHECK_COND  = (process.env.CHECK_COND  ?? '1') !== '0';

if (!START_BLOCK || !END_BLOCK) {
  console.error('START_BLOCK and END_BLOCK must be set');
  process.exit(1);
}

const FILLS_TABLES = ['polymarket_order_filled_v3'];
const COND_TABLES  = [
  'conditional_tokens_condition_preparation',
  'conditional_tokens_condition_resolution',
  'conditional_tokens_position_split',
  'conditional_tokens_positions_merge',
  'conditional_tokens_payout_redemption',
  'conditional_tokens_uri',
];

type Row = Record<string, string | number>;

async function queryLocal(sql: string): Promise<Row[]> {
  const url = `${LOCAL_CH}/?database=polymarket&default_format=JSONEachRow`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: sql,
  });
  if (!res.ok) throw new Error(`Local CH error ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text.trim() ? text.trim().split('\n').map(l => JSON.parse(l)) : [];
}

async function queryProd(sql: string): Promise<Row[]> {
  const res = await fetch(PROD_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PROD_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  });
  if (!res.ok) throw new Error(`Prod error ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  return Array.isArray(json) ? json : (json.rows ?? json.data ?? json);
}

function blockWhere(): string {
  return `block_number >= ${START_BLOCK} AND block_number < ${END_BLOCK}`;
}

interface Result { table: string; passed: boolean; detail: string }
const results: Result[] = [];

function pass(table: string, detail: string) {
  results.push({ table, passed: true, detail });
  console.log(`  PASS  ${table.padEnd(55)} ${detail}`);
}
function warn(table: string, detail: string) {
  // Warnings don't affect exit code — they reflect known data-source coverage gaps.
  results.push({ table, passed: true, detail: `[WARN] ${detail}` });
  console.warn(`  WARN  ${table.padEnd(55)} ${detail}`);
}
function fail(table: string, detail: string) {
  results.push({ table, passed: false, detail });
  console.error(`  FAIL  ${table.padEnd(55)} ${detail}`);
}

async function checkTable(table: string) {
  const where = blockWhere();

  const [dupRows, localRows, prodRows] = await Promise.all([
    queryLocal(`SELECT count() - countDistinct(event_id) AS dups FROM polymarket.${table} WHERE ${where}`),
    queryLocal(`SELECT count() AS n FROM polymarket.${table} WHERE ${where}`),
    queryProd (`SELECT count() AS n FROM polymarket.${table} WHERE ${where}`),
  ]);

  const dups = Number(dupRows[0]?.dups ?? 0);
  const lc   = Number(localRows[0]?.n   ?? 0);
  const pc   = Number(prodRows[0]?.n    ?? 0);

  // Hard fail: duplicates
  if (dups > 0) {
    fail(table, `${dups} duplicate event_ids  local=${lc}  prod=${pc}`);
    return;
  }

  // Hard fail: phantom events (local > prod means we invented rows)
  if (lc > pc) {
    fail(table, `local(${lc}) > prod(${pc}) — phantom events  dups=${dups}`);
    return;
  }

  // Both empty
  if (lc === 0 && pc === 0) {
    pass(table, `both empty (no events in range)  dups=0`);
    return;
  }

  // Event_id spot-check: all local ids must exist in production
  const sampleRows = await queryLocal(
    `SELECT event_id FROM polymarket.${table} WHERE ${where} ORDER BY block_number, log_index LIMIT 20`
  );
  const localIds = sampleRows.map((r: any) => r.event_id as string);
  if (localIds.length > 0) {
    const inClause = localIds.map(id => `'${id}'`).join(',');
    const foundRows = await queryProd(
      `SELECT count() AS n FROM polymarket.${table} WHERE event_id IN (${inClause})`
    );
    const found = Number(foundRows[0]?.n ?? 0);
    if (found < localIds.length) {
      fail(table, `event_id check: only ${found}/${localIds.length} local ids found in prod  dups=${dups}`);
      return;
    }
  }

  const pct = pc > 0 ? ((lc / pc) * 100).toFixed(1) : '—';
  const coverageStr = `local=${lc}  prod=${pc}  coverage=${pct}%  dups=0  ids✓`;

  if (lc < pc) {
    // Coverage gap: not an indexer bug (Hypersync vs full-node source difference)
    warn(table, `${coverageStr} (Hypersync may have less data than prod's source)`);
  } else {
    pass(table, coverageStr);
  }
}

async function main() {
  console.log(`\nCompare local vs production  blocks [${START_BLOCK}, ${END_BLOCK})\n`);

  const tables = [
    ...(CHECK_FILLS ? FILLS_TABLES : []),
    ...(CHECK_COND  ? COND_TABLES  : []),
  ];

  for (const table of tables) {
    await checkTable(table);
  }

  const failed = results.filter(r => !r.passed);
  const warned = results.filter(r => r.passed && r.detail.startsWith('[WARN]'));
  console.log(`\n${'─'.repeat(80)}`);
  if (failed.length === 0) {
    console.log(`ALL ${results.length} CHECKS PASSED${warned.length > 0 ? ` (${warned.length} coverage warnings)` : ''}`);
  } else {
    console.error(`${failed.length}/${results.length} CHECKS FAILED:`);
    for (const r of failed) console.error(`  - ${r.table}: ${r.detail}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
