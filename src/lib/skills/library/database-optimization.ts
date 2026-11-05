import type { Skill } from '../types'

export const databaseOptimization: Skill = {
  name: 'database-optimization',
  description:
    'Database design and performance: normalization tradeoffs and when to denormalize, indexing strategy and composite index column order, N+1 query detection and fixes, safe migration workflow (expand-contract), connection pooling, SQL vs NoSQL selection and backup discipline. Use when the user has slow queries or a slow app, designs a schema, plans migrations, or must choose between SQL and NoSQL.',
  keywords: [
    'base de donnees', 'database', 'bdd', 'sql', 'nosql', 'postgres', 'postgresql',
    'mysql', 'index', 'indexer', 'indexation', 'performance base de donnees',
    'requete lente', 'slow query', 'optimisation', 'optimization', 'n+1',
    'jointure', 'join', 'migration', 'migrations', 'normalisation',
    'denormalisation', 'connection pooling', 'pool', 'sauvegarde', 'backup',
    'requete', 'query', 'explain'
  ],
  body: `# Database Optimization

## Normalization tradeoffs
- 3NF is the default: one fact stored in one place; updates stay consistent.
- Denormalize deliberately, and only: read-heavy counters (like/comment counts), reporting tables rebuilt from the source, or one JSONB column for genuinely schemaless attributes.
- Every denormalization gets a written refresh strategy (trigger, cron, or rebuild job) at the moment it is created, not later.

## Indexing strategy
- Index every foreign key used in joins and filters, plus every column in the WHERE clause of hot queries.
- Composite index column order: equality columns first, then range columns. Index (a, b) serves WHERE a = ? AND b > ? but not WHERE b = ? alone.
- When all columns are equalities, put the most selective first; remember prefix matching: LIKE 'abc%' can use the index, '%abc' cannot.
- Verify with EXPLAIN (ANALYZE, BUFFERS): target index scans; treat sequential scans over > 10k rows or large heap fetches as alarms.
- Drop unused indexes (check pg_stat_user_indexes, idx_scan = 0 after a month of traffic): every index slows every write.

## N+1 detection and fixes
- Symptom: query count scales with row count (a page of 50 items fires 51+ queries); visible in ORM debug logs or as latency that jumps with list size.
- Fixes, in order of preference: eager loading / a JOIN done by the ORM, a batch IN (list of ids) fetch mapped in memory, the dataloader pattern, or one aggregate query.
- Prevention: an integration test asserting the query count per endpoint fails when a new N+1 appears.

## Migration workflow safety
- Migrations are forward-only, ordered, committed together with the code that needs them, and run in CI against a fresh database.
- Breaking changes use expand-contract: add the new column/table -> dual-write -> backfill in batches -> switch reads -> drop the old one in a later release.
- Every migration has a tested rollback, or is explicitly marked irreversible with a reason.
- Never run long ALTERs at peak hours: batch them, set lock timeouts, and check the engine's locking behavior first.

## Connection pooling
- Serverless, edge, or more than ~20 concurrent workers: put PgBouncer in transaction mode in front of Postgres.
- Keep the application pool small (5-20 per instance) and the total under the database max_connections.
- Watch for transaction-pooling incompatibilities: advisory locks, LISTEN/NOTIFY, session-level SET variables.

## SQL vs NoSQL decision table
- Relational (Postgres): the default; multi-entity consistency, reporting, evolving schemas via migrations.
- Document (Mongo): one aggregate document read and written whole, schema varies per tenant, no cross-document transactions needed.
- KV (Redis): cache, sessions, rate counters, queues — never the source of truth.
- Specialized: massive append-only telemetry -> ClickHouse; search -> Postgres FTS or Meilisearch.
- When unsure, choose Postgres: JSONB + full-text search + queues cover most "NoSQL" needs adequately.

## Backup basics
- Daily automated full backup + point-in-time recovery (WAL) for anything users type in; test an actual restore monthly — an untested backup is not a backup.
- Before every destructive migration or bulk update: snapshot + write down the exact restore path and command.`
}

export default databaseOptimization
