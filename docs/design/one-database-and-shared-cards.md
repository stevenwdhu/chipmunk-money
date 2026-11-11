# Plan: one database, then shared credit cards

## Status (2026-11-10)

- **Part 1 is in progress, simplified.** Only the owner runs Chipmunk, so the safeguards for strangers' installs are dropped. It ships in the same release as the rename to Chipmunk.
- **Part 2 (shared credit cards) is on hold.** Part 1 still uses global ids and the `ledger_accounts` view, so Part 2 can come later without another migration.

### Part 1, simplified (decided 2026-11-10)

**The app has only the new design.** It is written as if Chipmunk had always kept everything in one database:
- one `drizzle/` migrations folder starting from a fresh `0000` baseline
- no boot-time conversion, no legacy migrations, no legacy file formats
- the per-ledger "Download backup" is a one-ledger file in the new schema, and restore reads that format only
- the full backup is the whole database

**The owner's data is converted once, outside the app,** by a one-off converter script. It reads `meta.db` and `ledgers/*.db` (at their last schema, ledger 0002 and meta 0000) and writes `chipmunk.db`. It:
- gives global ids, the default ledger at offset 0
- rewrites ids inside custom reports and the activity log
- maps categories to the new model
- verifies counts, sums, balances and net worth per ledger, printing only totals and pass/fail

The owner runs it on a copy first, then on the real data with the container stopped, before starting the new image. The originals are never written to.

**From the full plan below, kept:**
- the unified schema with views and triggers (§2.2)
- the ledger handle with pins, the write guards and the twin isolation test (§2.4), with a statement-level pin checker in place of the per-scope tokenizer
- storage and lifecycle (§2.5)
- category list switching (§2.7)
- the id plan, JSON remap and verification of §2.3, moved into the converter

**Dropped:**
- everything about legacy files inside the app: detection at boot, the stub, legacy-format export and import, frozen legacy code
- the dry-run release, perf and query-plan tests

## The file name

Decided: **`chipmunk.db`**, after the project was renamed Chipmunk. The name is one constant (`DB_FILE`). Never `app.db`: `openStorage` already treats `DATA_DIR/app.db` as the database from before ledgers existed (storage.ts:249-251).

Version numbers in this plan are proposals from before the rename. The rename ships first (as v0.3.0, since compose files must change), so each proposed version below moves up one minor.

---

## 1. Overview

There are two parts. They ship in this order.

**Part 1: one database.** `meta.db` and the `ledgers/*.db` files become one SQLite file. Ledgers become rows, and every piece of ledger data carries a `ledger_id`. Existing installs are converted once at boot, after the originals are set aside as the backup. Users see nothing change. The one exception: ids in ledgers other than the default ledger are renumbered, which only API scripts and bookmarks notice.

**Part 2: shared credit cards.** A credit card can be in several ledgers. One of them is its home ledger, where bank sync and CSV import put new transactions. Any transaction on the card can be moved by hand to another ledger that shares the card, and it then belongs to that ledger only. Each ledger's card balance is the sum of the rows it holds; the home ledger also keeps the opening balance. The parts add up to the bank's balance.

**Why this order.** Shared cards need things only one database gives:
- A move must be atomic across two ledgers.
- Foreign keys must hold across them.
- A transaction must keep its id when it moves.
- A dry run must roll back every ledger at once.

Across separate files, every move would be a copy between two databases with no transaction around it. Part 1 also stands on its own: it removes per-file connections and the copy of the category list kept in every ledger, and it makes later cross-ledger features possible. Doing Part 1 alone first, with no visible change, means the risky data migration ships and settles before any new behaviour is added on top.

### Facts I checked against the code

The earlier designs relied on these. Where they were wrong, the plan below is corrected.

| Claim | What the code says |
|---|---|
| Migrations run inside a transaction | `drizzle-orm` wraps every migration in `BEGIN` (sqlite-core/dialect.js:657). `PRAGMA foreign_keys=OFF` does nothing there, so a migration that rebuilds `accounts` would cascade-delete transactions. That is why `accounts.institution_id` was added with ALTER TABLE and is nullable in SQL (drizzle/ledger/0000_baseline.sql:17) but `.notNull()` in schema.ts:34-37. |
| Restore and erase toggle foreign keys and wipe whole tables | They run with `foreign_keys = OFF` and `DELETE FROM main."<table>"` over every table (setup.ts:104-110, 157-161). Restore keeps `activity` (setup.ts:107). Erase keeps `settings` and `activity` (setup.ts:157). |
| Shared-list ledgers use the catalog's category ids | Yes (catalog.ts:11-15). A ledger matches by id only when its `categories.catalog` token matches (catalog.ts:306-316); otherwise it matches by name and may add to the shared list (catalog.ts:319-345). Own lists exist (`categories.mode = 'own'`, catalog.ts:45-51, `setCategorySharing` catalog.ts:102-112). |
| Net worth uses each account's `balanceMinor` | **No.** `netWorth` reads `FROM accounts` itself (reports.ts:369) and calls `balancesAt`, which also reads `FROM accounts` (accounts.ts:220-223). |
| Raw reads of `accounts` | 26 statements in 14 files (accounts.ts, bank/service.ts, import.ts, transactions.ts, reports.ts, matching.ts, recurring.ts, categorize.ts, custom-reports.ts, institutions.ts, setup.ts, storage.ts, seed-demo*.ts). |
| Saved-report ids are all remapped by `mapConditions` | **No.** `mapConditions` (packages/shared/src/filters.ts:444) only rewrites conditions. `picked` and `keep` hold transaction ids (filters.ts:92-93) and need their own remap. |
| Bank sync line numbers | `alignWithBank` is at bank/service.ts:901 and `applyToLinked` at :913. 483-492 is `caughtUp`. `applyKept` builds its external-id set with its own query at service.ts:634. |
| Content triggers | There are 8 (`links_follow_bill`, `links_sum_insert/delete/update/bill`, `refunds_follow_name/take_name/keep_name`) and 1 view (`transaction_lines`), not 9 triggers. |
| Restore's effect on renamed refunds | Restore copies `transaction_links` with the triggers live (setup.ts:110-113), so `refunds_take_name` can overwrite a refund that was renamed apart from its bill. This bug exists today. |
| ON DELETE SET NULL relations | 7 of them: `categories.group_id`, `recurring_items.category_id`, `recurring_items.account_id`, `transactions.category_id`, `transactions.recurring_item_id`, `transactions.import_batch_id`, `bank_payloads.transaction_id`. |
| Docker | Node runs as PID 1 (Dockerfile:89). The server build bundles only `src/index.ts` into `dist/index.mjs` (apps/server/package.json), so any CLI needs its own esbuild entry. |
| `unlinkBankAccounts` | It nulls `ledger_id` and `account_id` for every bank account of the ledger (accounts.ts:175-178). |
| Demo seed | It resets `sqlite_sequence` for `custom_reports` (seed-demo.ts:38). |
| `idempotency_keys` | It has no ledger column (meta-schema.ts:54-66). |
| Raw SQL volume | About 440 to 530 SQL statements across ~35 server files, depending on how fragments are counted. |

---

## 2. Part 1: one database

### 2.1 Where the design reviews disagreed, and what this plan does

| Question | Decision | Why |
|---|---|---|
| Ids | **Global ids**: one INTEGER PRIMARY KEY AUTOINCREMENT per table, shared by all ledgers. | A transaction moving in Part 2 keeps its id, and a shared card has one account id. Per-ledger composite keys would force renumbering on every move. |
| Renumbering at conversion | The **default ledger keeps every id (offset 0)**. Each other ledger gets an offset above the **largest id that table has in any ledger** (plus ids referenced but missing). | Single-ledger installs, which are most of them, keep every id. An old id from a stale browser tab, MCP cache or script can never land on a different row: it simply returns 404. |
| Categories | **One shared list as rows with `ledger_id NULL`.** Own-list ledgers keep their own rows with their `ledger_id`. A new `ledger_category_off` table holds which shared categories a ledger turned off. Reads go through views. | The per-ledger copies only existed so each file could stand alone (catalog.ts:11-13). This keeps shared ids identical across ledgers without composite keys. |
| Foreign keys | **Single-column FKs, as today** (unambiguous because ids are global), plus `ledger_id` FKs to `ledgers`. Same-ledger is enforced by `BEFORE INSERT/UPDATE` guard triggers. | Composite FKs with `ON DELETE SET NULL` would also null `ledger_id`. That would break deleting a category, recurring item or group, and the nightly purge. |
| Which tables get `ledger_id` | The **root tables**. Child tables are scoped through their parent. Accounts are read through a `ledger_accounts` view. | Fewer copies of the same fact. The view is what Part 2 needs so a shared card shows up in every member ledger. |
| Scoping mechanism | Explicit `ledger_id = @ledger` in the SQL, run through a **checked ledger handle**. A pin checker rejects unpinned SQL at prepare time. Write-scope guard triggers abort writes to other ledgers' rows. A twin-ledger isolation test proves it. | Hidden scoping (TEMP views, rewriting queries) breaks writes and is invisible to reviewers. A forgotten filter must fail loudly. |
| Per-ledger "Download backup" | It **keeps today's per-ledger file format** in Part 1. | No visible change, v0.2.x can still restore it, and one importer handles old backups, new downloads and the conversion. |
| Safety copies (pre-restore, pre-erase, deleted ledger, demo `--force`) | **Per-ledger exports**, not `VACUUM INTO` of the whole database. | Small, restorable from the UI, and they don't copy other ledgers or sealed secrets. |
| Old migrations | Frozen under `drizzle/legacy/`, and **no per-file schema change is ever shipped again**. | A per-file backfill migration is impossible (a ledger file doesn't know its id), and table rebuilds inside drizzle's `BEGIN` cascade-delete data. |
| Downgrade guard | A **text stub `meta.db`**. v0.2.3 then stops at boot with "file is not a database" instead of starting empty. | It works without a bridge release. |

### 2.2 The schema

One schema module: `src/db/schema.ts` absorbs `meta-schema.ts`. `drizzle.config.ts` writes to `drizzle/app`, `drizzle.meta.config.ts` is deleted, and `db:generate` becomes one `drizzle-kit generate`. The baseline `drizzle/app/0000_unified.sql` is generated, and then the view, content triggers, guard triggers and category views are appended by hand, as today.

**App-wide tables (no `ledger_id`)**
- `ledgers`: id (ULID text, unchanged), name, slug, color, icon, sort, archived_at, timestamps, and a new `category_list TEXT NOT NULL DEFAULT 'shared' CHECK (category_list IN ('shared','own'))`. It drops `file`.
- `app_settings` (meta's `settings`, renamed so it can't be confused with ledger settings). It keeps `defaultLedger`, the catalog token `categories.catalog` and `categories.version`. Keeping the token is what lets old backups restore by id instead of by name.
- `api_keys`, `idempotency_keys`, `bank_connections`, `bank_transactions`, `payee_name_rules`, `payee_tidy`: unchanged.
- `bank_accounts`: drops `ledger_id`. `account_id` becomes a real FK `REFERENCES accounts(id) ON DELETE SET NULL`, and the link index becomes `UNIQUE(account_id) WHERE account_id IS NOT NULL`. The ledger comes from the account, so there is one source of truth. Part 2's home change then needs no update here.

**Category tables (`ledger_id` NULL means the shared list)**
- `category_groups(id, ledger_id NULL → ledgers CASCADE, name, color, sort, timestamps)`
- `categories(id, ledger_id NULL, group_id → category_groups SET NULL, name, is_income, exclude_from_totals, archived_at, sort, timestamps)` with `CHECK (ledger_id IS NOT NULL OR archived_at IS NULL)`. Shared categories are switched off per ledger, not on the row.
- `labels(id, ledger_id NULL, name, color, sort, timestamps)` with `UNIQUE(ifnull(ledger_id,''), name)`.
- `category_labels(category_id, label_id)`: unchanged.
- New `ledger_category_off(ledger_id → ledgers CASCADE, category_id → categories CASCADE, archived_at NOT NULL, PK(ledger_id, category_id))`. A guard trigger requires the category to be shared.
- Views that reads go through (writes go to the base tables):
  - `ledger_categories(ledger_id, id, group_id, name, …, archived_at)` is a UNION ALL of two branches. The own branch is categories joined to `ledgers` on `ledger_id`. The shared branch is categories with `ledger_id IS NULL` crossed with ledgers whose `category_list = 'shared'`, LEFT JOINed to `ledger_category_off` for `archived_at`.
  - `ledger_category_groups` and `ledger_labels` follow the same pattern.

**Per-ledger root tables: `ledger_id TEXT NOT NULL REFERENCES ledgers(id)`**

These are `institutions`, `accounts` (the home ledger in Part 2), `tags`, `import_batches`, `recurring_items`, `transactions` (the ledger that holds it), `custom_reports`, `payee_rules`, `payee_category_stats`, `activity`, `ai_calls` (nullable, for future app-wide calls) and the new `ledger_settings(ledger_id, key, value, updated_at, PK(ledger_id, key))`.

- No ON DELETE CASCADE from `ledgers`. Ledger data is deleted on purpose by `deleteLedgerRows` (§2.5), so a stray `DELETE FROM ledgers` fails instead of wiping data.
- Natural keys get `ledger_id` in front:
  - `tags` UNIQUE(ledger_id, name)
  - `custom_reports` UNIQUE(ledger_id, lower(name))
  - `payee_rules` PK(ledger_id, payee_key)
  - `payee_category_stats` PK(ledger_id, payee_key, direction, category_id)
- `accounts.institution_id` stays NOT NULL in the new schema. The conversion gives any legacy NULL a placeholder institution named "Other" in that ledger and logs it.
- Every copy uses explicit column lists, because legacy column order differs (institution_id and category_groups.color come last).

**Accounts are read through one view, `ledger_accounts`**
- In Part 1 it is `SELECT a.ledger_id, a.id, a.name, …, a.institution_id, a.sort, a.archived_at FROM accounts a`.
- Every service read of accounts uses it, pinned by `ledger_id = @ledger`. That covers the 26 raw reads above, net worth and `balancesAt` included.
- In Part 2 only the view changes, to join the membership table. No account query changes then.
- The pin checker refuses a raw `FROM accounts` or `JOIN accounts` outside a short list (account writes and the converter).

**Child tables: no `ledger_id`, scoped through their parent**
- `balance_snapshots` and `bank_payloads`: through the account.
- `transaction_links`, `transaction_tags` and `transfer_rejections`: through the transactions.
- `recurring_payees`, `recurring_not_payments`, `recurring_price_changes` and `recurring_payment_dues`: through the recurring item.
- `category_labels`: through the category.

Their keys stay right because ids are global. `tx_external_id` UNIQUE(account_id, external_id) stays card-wide on purpose.

**Indexes**
- On `transactions`:
  - `(ledger_id, date)`, `(ledger_id, category_id, date)` and `(ledger_id, payee_key)` replace `tx_date`, `tx_category_date` and `tx_payee_key`.
  - `(ledger_id) WHERE needs_review = 1`.
  - New `(ledger_id, deleted_at) WHERE deleted_at IS NOT NULL`, for the trash list and the purge.
  - `(account_id, date)`, `tx_recurring` and `tx_external_id` are kept.
- Elsewhere:
  - `recurring_items` gets `(ledger_id, status)` and `(ledger_id, payee_key)`.
  - `activity` gets `(ledger_id, id)`, `(ledger_id, actor)` and `(ledger_id, entity)`.
  - `ai_calls` gets `(ledger_id, created_at)`.
  - `accounts`, `institutions`, `import_batches`, `custom_reports` and the category tables each get an index on `ledger_id`.
- Foreign-key child indexes that are missing today. These tables now hold every ledger's rows, so a cascade or SET NULL without an index would scan them all:
  - `transfer_rejections(out_id)`
  - `recurring_not_payments(transaction_id)`
  - `recurring_payment_dues(transaction_id)`
  - `transactions(import_batch_id) WHERE NOT NULL`
  - `import_batches(account_id)`
  - `recurring_items(account_id)`
  - `recurring_items(category_id)`
  - `payee_rules(category_id)`
  - `payee_category_stats(category_id)`

**Guard triggers.** Each is a `BEFORE INSERT/UPDATE OF <col>` trigger that does `RAISE(ABORT, 'cross-ledger reference')`.
- **On `transactions`:**
  - `account_id`: the account's `ledger_id` must equal the transaction's. Part 2 relaxes this to membership.
  - `category_id`: must be in `ledger_categories` for that ledger.
  - `recurring_item_id`, `import_batch_id` and `transfer_pair_id`: must be in the same ledger.
- **On links and tags:**
  - `transaction_links` and `transfer_rejections`: both sides in one ledger, on INSERT and on UPDATE of either id.
  - `transaction_tags`: the tag must be in the transaction's ledger.
- **On recurring items:**
  - the recurring child tables: the transaction must be in the item's ledger.
  - `recurring_items.account_id` and `category_id`: in the item's ledger.
- **On other tables:**
  - `accounts.institution_id`: in the account's ledger.
  - `payee_rules.category_id` and `payee_category_stats.category_id`: visible to the ledger.
- **How each guard decides:** it raises only when the referenced row exists and is in another ledger. That lets the importer insert links before transactions (§2.6). A deferred FK only checks that the row exists at commit, not which ledger it is in, so each parent table also has a `guard_<table>_referred` trigger on INSERT. It raises when rows already referring to the new row's id are in another ledger. Each lookup is by an indexed FK column.
  - Not covered: `transactions.transfer_pair_id` (no FK and no index, so a reverse check would scan every transaction), and a parent row whose `id` is changed by UPDATE. The app does neither.
- **On `ledgers.category_list`:** it can't become `'own'` while the ledger's transactions, recurring items, payee rules or payee stats still point at shared categories. Without that, later unrelated writes to those rows (FK SET NULL actions included) would fail the guards.

**View and content triggers**
- `transaction_lines` gains `t.ledger_id` in both UNION branches. A link's bill is always in the same ledger, which the guard enforces.
- The 8 content triggers stay word for word, since they work by row id.

**Connection pragmas** (`openDatabase(file)` in `db/client.ts`, replacing `openLedgerDb` and `openMetaDb`)
- WAL, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`
- `journal_size_limit=64MB`
- `cache_size=-20000`
- `auto_vacuum=INCREMENTAL`, set on the fresh file before the baseline runs. Without it, deleting a ledger never frees disk space, and it can't be added later without a full VACUUM.
- `application_id = 0x53544B31`
- The `pre-migrate` snapshot and `checkUpgradable` stay.

**Rules for the codebase**
- Never run `PRAGMA foreign_keys=OFF` on the unified database. Use `PRAGMA defer_foreign_keys=ON` inside a transaction instead, because FK actions such as unlinking bank accounts must keep firing.
- A helper throws if `ATTACH`, `DETACH` or a `foreign_keys` toggle runs while `sqlite.inTransaction` is true. On one shared connection they would silently do nothing, or fail.
- No migration may rebuild `accounts`, `transactions` or any table with cascading children.
- Only migrations may write `sqlite_sequence`. The demo seed's reset goes.

### 2.3 Converting existing installs

All of this lives in `src/db/unify/` and runs at the start of `openStorage`, before the registry exists and before `serve()`.

**What `openStorage` does, by what it finds in DATA_DIR**

| Found | Action |
|---|---|
| Nothing | Fresh install: create the database and the "Personal" ledger. |
| `meta.db` (real SQLite), no new db | **Convert.** |
| New db, and no `meta.db` or our stub | Open and migrate. Write the stub if it is missing and `storage.merged` exists. |
| New db plus legacy files whose hashes match `storage.merged` | An earlier conversion stopped after the rename: finish moving the files, then open. |
| New db plus any legacy file that doesn't match (a changed `meta.db` or any `ledgers/*.db`) | **Refuse to start.** Name both sets of files and explain the likely causes: an old full backup was unzipped, or an older version ran. |
| Stub but no new db | Refuse to start: "chipmunk.db is missing; restore it from backups/". |
| Leftover `.upgrade/` or `chipmunk.db.partial*` | Delete every `.partial*` file (`-journal`, `-wal`, `-shm` too) and the work dir first. |

**Conversion steps**
1. **Lock.** Open `DATA_DIR/.upgrade.lock` as a SQLite file and hold `BEGIN EXCLUSIVE` for the whole run. The OS drops the lock when the process dies, so a crash never leaves a lock that blocks the next boot. That matters because Node is PID 1 and pids repeat. A second process, such as `pnpm seed:demo`, waits or refuses.
2. **Space and preflight.** `statfsSync(DATA_DIR)` must show at least 2.5 times the legacy files' total size free (work copies plus the new file plus margin). All temp files live under `DATA_DIR/.upgrade/`. Then:
   - A ledger file that is too old (`isTooOld`), or unreadable, aborts with a message naming the file.
   - A `ledgers` row whose file is **missing** becomes an empty ledger, logged and recorded. Today `openLedgerDb` silently creates an empty file in that case.
   - Nothing has been written yet at this point.
3. **Fingerprint the originals.** Record the size and sha256 of `meta.db`, each `ledgers/*.db` and any `-wal` file. **The originals are never opened for writing.**
4. **Work copies.** Open each original read-only and `VACUUM INTO .upgrade/work/…`, which captures WAL contents consistently. Then, on the copies only:
   - Run the frozen legacy migrations.
   - Run `seedCatalog` on the meta copy if it has no categories.
   - Run a frozen copy of today's `syncLedgerCategories` (moved to `src/db/legacy/catalog-sync.ts`) **in a loop until `ledgerNeedsSync` is false for every shared-mode copy**. One ledger's sync can add to the list and bump the version for the others.
   - Assert that every shared-mode copy now holds exactly the catalog's ids.
5. **Build** `chipmunk.db.partial` with `journal_mode=OFF` and `synchronous=OFF`, so there is no journal to replay after a crash. Use `auto_vacuum=INCREMENTAL` and run the new baseline.
6. **App-wide rows** are copied from the meta copy, ids kept: ledgers (with `category_list` from each ledger's `categories.mode`), app settings, API keys, bank connections and transactions, payee name rules, payee tidy, and the catalog with `ledger_id NULL`.
   - `idempotency_keys`: completed rows are copied. In-flight rows (status null) are dropped. A replay for a renumbered ledger returns ids that now 404, which is harmless. Dropping every row would let a retry across the upgrade create duplicates.
   - `bank_accounts.account_id` is remapped by the account offset of its ledger. A link to a missing account or ledger becomes NULL and is logged.
7. **Each ledger**, the default ledger first, then by (sort, created_at), through the same importer used for restore (§2.6). The conversion passes these options: `{ ids: plan, keepBankLinks: true, importActivity: true, markComplete: false, reconcileCatalog: false }`.
8. **Verify** (below). Any mismatch aborts, leaves the originals untouched, and writes `backups/pre-merge-<ts>/verify.json`.
9. **Record and commit.**
   - Write `app_settings['storage.merged'] = { at, version, files: [{path, size, sha256}], ledgers: [{id, file, offsets}] }`.
   - Run `ANALYZE`, close, fsync, chmod 0600.
   - `rename(.partial → chipmunk.db)`, which is atomic on one volume.
   - Reopen in WAL mode.
10. **Retire the originals.**
    - Move `meta.db*` and `ledgers/` into `backups/pre-merge-<ts>/`. The originals **are** the backup, so no extra copy is made.
    - Write the stub `meta.db` through a temp file and rename. It is a short text file: "This install moved to chipmunk.db in v0.4.0. See docs/self-hosting.md." v0.2.3 then fails at boot with "file is not a database" instead of creating an empty install, and the new version recognises the stub by its contents.
    - Delete `.upgrade/`, release the lock, and log one line per ledger: counts, whether it was renumbered, and where the backups are.

If the conversion crashes before step 9's rename, the install is exactly as it was and the next boot starts over. If it crashes after the rename, the next boot finishes from the `storage.merged` record: it moves the files whose hashes match, refuses on any mismatch, and writes the stub if it is missing.

**The id plan**
- For each id table T, `start[T]` is the largest of: `max(id)` and `sqlite_sequence.seq` of T in **every** legacy file, plus the largest id of that kind referenced anywhere. That includes dangling `transfer_pair_id`s, ids in JSON, and activity.
- The default ledger gets offset 0. Each later ledger gets `offset = base`, then `base += span`, with `base` starting at `start[T]`. `new = old + offset`.
- Categories, groups and labels: whichever list the default ledger uses keeps identity.
  - If the default ledger uses the shared list, the catalog keeps its ids and every own-list ledger is offset.
  - If the default ledger has its own list, its rows keep their ids and the shared catalog is offset. All shared-mode ledgers then get the same map.
  - A category missing from the map becomes NULL (uncategorized) and is logged. Step 4 should make that impossible.
- References that point at missing rows are repaired before any constraint applies:
  - A `transfer_pair_id` whose other side is gone, which happens after an account with transfers was deleted (accounts.ts:168-171), is set to NULL and logged.
  - Dangling ids in JSON are offset like any other id. The new id is reserved and never exists, so it stays dangling instead of pointing at another ledger's row.
- `sqlite_sequence` for every table is raised to `base[T]`.

**Ids inside JSON**

This is a pure function, `remapJson(kind, value, maps)`, that walks the raw JSON. It doesn't re-parse through zod, which would add defaults.
- `custom_reports.spec`:
  - category, group and label ids inside `only` and every `filterOut[].when` go through the category map (`'none'` is kept)
  - tag and account ids are offset
  - `recurring` lists are offset (`'any'` and `'none'` are kept)
  - payee keys are left alone
  - **`picked` and `keep` on both sides are offset** (transaction ids; `mapConditions` doesn't cover them)
  - the keys of `names.{category, group, label, tag, account, recurring}` are remapped
- `activity.entity_id`, by entity: transaction, account, institution, category, category_group, label, tag, recurring, custom_report, import. `ledger` and `payee` are left alone.
- `activity.before` and `after`, through a key allowlist:
  - `id`, by the entry's entity
  - account, institution, recurring item, tag and batch keys: `accountId`, `institutionId`, `recurringItemId`, `tags[].id`, `tagId(s)`, `batchId` and `importBatchId`
  - category and group keys: `categoryId`, `moveTo`, `into`, `groupId` and `labelIds`
  - transaction keys: `transferPairId`, `transactionId`, `moneyInId`, `moneyOutId` and `links[].transactionId`
  - **`add` and `remove` for label entries** (category ids, routes/ledger.ts:969)
  - **a bare top-level number array on reorder entries**, as ids of that entry's entity
  - `spec`, through the spec remap
  - Never rewritten: `payeeNameRule`, `ruleId`, `connectionId`, `bankAccountId` and ledger ids.

  The allowlist is checked by a test that logs one entry from every route and fails on an unknown id-like key. One known limit: in an own-list ledger, a few old entries from App-settings fan-outs name catalog ids and may show the wrong category name.
- `accounts.import_mapping` holds only CSV column indexes and is copied as is.

**Ledger settings**
- `setup.completed` goes to `ledger_settings`.
- `categories.mode` becomes `ledgers.category_list`.
- `categories.catalog` and `categories.version` are consumed, since the ledger copies no longer exist.
- App keys found in a ledger file are dropped (meta wins, as `dropAppSettings` does today) and logged.
- Unknown keys are copied to `ledger_settings` as they are.

**Verification (before the rename)**
- `PRAGMA integrity_check` and `foreign_key_check` are clean. The guard-trigger conditions, run as SELECTs, find no cross-ledger reference.
- A generic row comparison driven by `PRAGMA table_info` of the **legacy** tables: per table and per ledger, the multiset of rows with ids mapped back (`new − offset`) equals the work copy. A test fails if any legacy column is neither mapped nor on an explicit dropped list. That list is `ledgers.file`, the per-ledger category copy's `created_at`/`updated_at`, and the settings keys above.
- Explicit exceptions, so nobody loosens checks quietly: shared-mode ledgers' categories, groups, labels and category_labels are compared by equivalence (copy = catalog plus `ledger_category_off`), not by row count.
- Money, per ledger, computed on the work copy with **frozen copies** of today's `LIST_SQL` and `balancesAt` (in `src/db/legacy/`) and on the new db with the new code:
  - per account: count and sum of `amount_minor`, deleted and not deleted
  - `linked_minor` equals the value recomputed from links
  - `transaction_lines` totals by month and category
  - every account's current balance
  - net worth at the last 12 month-ends
  - all of these must be equal
- Every rewritten spec parses with `reportSpecSchema`, and `filterRefs(new) = map(filterRefs(old))`.
- Bank links: same count, each on an account in the same ledger with the same name.

**Ways back**
- **Simplest:** stop the app, move `backups/pre-merge-<ts>/*` back into DATA_DIR, move `chipmunk.db` and the stub aside, and run v0.2.3. Changes made since the upgrade are lost.
- **Keeping changes:** `node apps/server/dist/unify-cli.mjs export-legacy <dir>` writes `meta.db` and `ledgers/*.db` from the current database, using the per-ledger exporter (§2.6).
- **Re-upgrading after a downgrade:** if the user left `chipmunk.db` in place, the hash check refuses to start and explains. If they moved it aside, the conversion runs fresh.

**Dry run on real data.** `unify-cli check <copy-of-data-dir>` runs steps 2 to 8 into a temp dir and prints the verification report. It is a second esbuild entry, `dist/unify-cli.mjs`, included in the image and run with `docker compose exec … node apps/server/dist/unify-cli.mjs check /tmp/copy`. You run it on a copy of your production volume. Nobody else reads `data/`.

### 2.4 Query scoping and the isolation test

**The ledger handle (`src/db/scope.ts`)**
- `AppContext` loses `db` and `sqlite`. It gains:
  - `q: LedgerQuery`, with `all`, `get`, `pluck`, `column`, `run`, `transaction` and `mustGet(sql, notFoundMessage, …)`
  - `app: AppStore`, for app tables only
  - `actor`, plumbed through now because Part 2 needs it
- `MetaStore` stays as an alias of `app` on the same connection, so the ~100 `ctx.meta` call sites compile.
- Each call does five things:
  1. It looks the statement up in an LRU cache keyed by SQL text (about 2000 entries). On a miss it runs `checkPinned(sql)` and then `prepare`. This also removes today's re-prepare on every call.
  2. It **merges** `{ ledger: ctx.ledger.id }` into the caller's named-parameter object, or appends it when the call only has positional parameters. Passing two objects makes better-sqlite3 throw.
  3. It throws if the caller passed `ledger` itself.
  4. It sets the write-guard scope to `[ledgerId]` in try/finally around the synchronous run.
  5. It offers no `exec`, `iterate` or `ATTACH`.
- The drizzle instance for app tables gets a proxy whose `prepare` throws when generated SQL names a ledger table. The ~35 drizzle calls on ledger tables (categories.ts 22, settings.ts, accounts.ts 5, import.ts, ai/runner.ts) are converted to SQL.

**Pin rules (`checkPinned`, a tokenizer, not a full parser).** Each subquery, CTE body and UNION branch is its own scope. "Ledger tables" are read from `PRAGMA table_info` when the database opens.
- **P1.** Every reference to a table or view with `ledger_id` must be pinned in its own scope by a top-level AND conjunct of WHERE or ON. The pin is either `X.ledger_id = @ledger` or `X.ledger_id = Y.ledger_id`, where Y is pinned in the same or an enclosing scope.
- **P2.** A child table is pinned by a join on its FK column to a pinned parent (for example `JOIN transactions t ON t.id = l.money_in_id`, with `t` pinned), or by `l.money_in_id IN (SELECT id FROM transactions WHERE ledger_id = @ledger …)`. This holds for its reads, UPDATEs and DELETEs. An INSERT into a child table needs no pin, since the write guards hold it to its parents' ledger.
- **P3.** `accounts` may only be read through `ledger_accounts`, which falls under P1.
- **P4.** An INSERT into a ledger table must list `ledger_id` with `@ledger`, or a pinned column of the INSERT … SELECT.
- **P5.** `ledger_id = ?` (positional) never counts as a pin. Neither does a pin under OR, NOT or CASE, or in HAVING.
- **P6.** In an ON clause, a pin counts only for what the join filters: an inner join's for every table before it, a LEFT JOIN's for the joined table, a RIGHT JOIN's for the tables before it, a FULL JOIN's for none.
- **P7.** The handle runs only SELECT, INSERT, UPDATE and DELETE (with WITH). It refuses OR REPLACE on ledger tables, writes to `ledgers` not pinned by `id = @ledger`, and parenthesized joins. The connection runs with `recursive_triggers = ON`, so a REPLACE's delete of the conflicting row still fires the write guards.
- **Shared category rows** (`ledger_id IS NULL`) may only be written from the catalog module, which is a listed site.
- **On failure** it throws `LedgerScopeError("transactions AS p (subquery at char 212) has no ledger pin")` at prepare time in every environment, production included. The cost is a 500 instead of a leak.

**Write-scope guard.** These are TEMP `BEFORE INSERT/UPDATE/DELETE` triggers on every ledger table, created on the connection after migrations. They call `st_in_scope(OLD.ledger_id)` and `st_in_scope(NEW.ledger_id)`, a UDF that reads a JS variable the handle sets around each synchronous call. No other request can run in between, because better-sqlite3 is synchronous.
- An empty scope denies, so a raw write outside a handle aborts.
- The guards also fire on rows changed by the content triggers and by FK cascades.
- **Restore, erase, ledger delete and export run with scope `[ledgerId]`.** Only the pin checker is relaxed for their generated SQL. The most dangerous paths keep the guards on.

**The only ways around the checks**
- `storage.allLedgers(reason)`: scope ALL, no checker. It is for ledger counts (one GROUP BY), catalog fan-out, the payee world rebuild, the full backup, AI and catalog usage sums, and the converter.
- Every call site goes in `src/db/unscoped-sites.ts` with a reason, and a test keeps that list equal to the source.

**Places that need extra care (listed, each with its own conversion and test)**
- `setup.ts` restore and erase: today's whole-table `DELETE FROM` would wipe every ledger in one database.
- `routes/ledger.ts` `/backup`: today's `serialize()` would ship every ledger.
- `catalog.ts` sync and join, with its `DELETE FROM category_labels; DELETE FROM categories; …` under foreign keys OFF.
- `seed-demo.ts`, which wipes whole tables and resets `sqlite_sequence`.
- `withDryRun`.
- `transactions.ts`, `recurring.ts` (payee-key joins, which are not FK joins), `reports.ts`, `filters.ts` and `totals.ts`. The fragments OWNER_JOIN, RECURRING, LINKED_IN and the label subqueries need pins. OWNER_JOIN becomes `JOIN transactions o ON o.id = t.owner_id AND o.ledger_id = t.ledger_id`.
- Dynamic table-name helpers broken by the schema change: `reorderCatalog(table)` and catalog-edit's `nextSort(table)`.

**Static checks (vitest, so they run in `pnpm test`; the repo has no ESLint)**
- No `better-sqlite3` import and no `.prepare(`, `.exec(` or `.pragma(` outside `src/db/`.
- `unscoped-sites.ts` matches the source exactly.
- Schema rules:
  - every table is app-wide, or has a `ledger_id` FK to `ledgers`, or is a declared child with a parent FK
  - every index on a ledger table leads with `ledger_id`, except the declared ones (`tx_external_id`, `(account_id, date)`, the FK child indexes)
  - every FK column is the first column of some index
  - every trigger body passes the checker, with `NEW.ledger_id`/`OLD.ledger_id` counted as pins
  - no `sqlite_sequence` writes outside migrations
- Every INTEGER `*_id` column is either an FK or in the converter's `EXTRA_REFS`.

**The isolation test (`src/isolation.test.ts`, helpers in `test/twins.ts`)**
1. **The world.** Two ledgers A and B, both seeded with `startDemo`, so names, amounts and payees look alike. Add a fake bank-linked account and stubbed AI calls. B's free text carries a canary `⟦B⟧`.
2. **Request catalog.** It covers every spec from `createApi(storage).specs` under `/ledgers/:ledger` and every MCP tool from `tools/list`. The test fails if one has no case. Reads walk every cursor page and every report kind, with filters using every field, picks and keeps included.
3. **Read differential.** Capture A's responses, delete B's rows with plain SQL in the harness, capture again, and require the two to be deep-equal. No response may contain the canary.
4. **Id probes** (only once ids are global). Call every `:id` route under A with B's id of that kind, with a valid body. Expect 404 with the not-found wording, and both ledgers' hashes unchanged. Do the same for ids in request bodies (accountId, transferAccountId, categoryId for own-list categories, tagIds, recurringItemId, bulk and link ids, report picks, merge target, snapshotId): expect 400 or 404, never 500.
   - Shared-list category and label ids are legitimately the same in both ledgers. They are excluded from the "no B id" check, and the check compares (ledger, id) pairs.
5. **Writes stay home.** Run every non-GET spec and write tool in A, then compare a per-table hash of B's rows (activity and ledger settings included). This covers erase, restore, account delete, category merge, import commit and undo, bank sync, `detectRecurring`, `purgeDeleted` and the payee rebuild. App-wide catalog edits are asserted to change both ledgers the same way.
6. **Both directions.** Run it all again with B as the subject, to catch `LIMIT 1`, `ORDER BY id` and default-ledger shortcuts.
7. **Backups and keys.** A's export holds no B rows or canary. A key limited to B gets 403 for A on every route and tool. This extends security.test.ts:157.
8. **Before the switch.** Steps 3, 5 and 7 run against today's per-file storage and pass as a baseline. The probes and the typed-id checks start when ids become global, because today both files hand out ids from 1.

**Test helpers.** `testStorage()` stays `openStorage({ dataDir: null })`, one `:memory:` connection. `testLedger(storage, name)` adds a second ledger. The always-on decoy ledger proposed earlier is **not** used: it breaks single-ledger tests such as storage.test.ts:87-88, "only ledger", and the AI-usage sum at :194. The twin harness does this job instead, and tests opt in with `testStorage({ twin: true })`.

### 2.5 Storage and lifecycle

- `Storage` becomes `{ sqlite, app, registry, now, dataDir, secrets, fetch, close() }`. `close()` replaces `registry.closeAll()` plus `meta.sqlite.close()` in index.ts, seed-demo-cli.ts and runtime.test.ts.
- `LedgerRegistry` keeps `get`, `find`, `list`, `toDTO`, `create`, `update`, `remove`, `context`, `defaultLedger` and `uniqueSlug`, and holds no connections.
  - `context()` is a cheap object over the one connection. The category catch-up at storage.ts:87-88 goes.
  - `list()` counts with grouped queries and computes `defaultLedger()` once.
- `create()` runs in one transaction: the ledger row plus its `ledger_settings`.
- `remove()`:
  1. exports the ledger to `backups/deleted-<slug>-<ts>.db`, which can be restored from the UI
  2. in one transaction under scope `[id]`: `deleteLedgerRows(id)`, `DELETE FROM ledgers`, and clearing `defaultLedger` if it named this ledger (bank links clear through the FK)
  3. `PRAGMA incremental_vacuum` and `wal_checkpoint(TRUNCATE)`
- `deleteLedgerRows(id, { keep })` deletes children before parents, with foreign keys on, from the one table list in `src/db/tables.ts`. That list classifies every table as app, ledger, catalog or child, with its delete and insert order. A test fails when a table in `sqlite_master` is missing from it.
- Dry runs: `withDryRun(storage.sqlite)` now rolls back everything, app tables included. The `dryRunDb` option and its guard go. Handlers stay synchronous, and the `!dryRun` guard before background work stays.
- Daily jobs: the same loop over active ledgers, each ledger's `detectRecurring` and `purgeDeleted` in its own transaction. Then once a day `PRAGMA optimize`, `PRAGMA incremental_vacuum(2000)` and the idempotency purge.
  - Today `jobs.ts` only logs errors. A `LedgerScopeError` also goes into an app-level "last job error" setting, shown in App settings, so a fail-closed query doesn't hide in the logs.
- Demo seed: it counts data by ledger, clears with `deleteLedgerRows(keep: ledger_settings, activity)`, and drops the `sqlite_sequence` reset. Its `--force` snapshot becomes a ledger export.

### 2.6 Backups, restore, erase

**Per-ledger export (`exportLedger(id)`, the "Download backup" file)**
- It writes **today's per-ledger format**, ledger schema 0002. The file is created with the frozen legacy migrations on a temp file under `DATA_DIR/.tmp/`, mode 0600.
- It contains:
  - the ledger's rows with their real ids
  - the category list it sees, as a legacy copy with ids, off state and `categories.catalog` and `categories.version` set to the app's token, so restore takes the id path
  - `categories.mode`
  - `setup.completed`
- Insert order avoids the content triggers. The export connection is our own temp file, so foreign keys go OFF outside a transaction, `transaction_links` are inserted before `transactions`, and then `foreign_key_check` runs. Renamed refunds and `updated_at` arrive unchanged.
- The route, content type and download name are unchanged, and v0.2.x can restore the file.
- The same exporter writes the `pre-restore-`, `pre-erase-`, `deleted-` and `pre-seed-demo-` safety copies, and `export-legacy`.
- Only migrations and the conversion take whole-database `VACUUM INTO` snapshots.

**Importer (`importLedger(ledgerId, file, opts)`)**
1. Check the header, then classify the file:
   - A legacy ledger file (has `accounts` and `transactions`, no `ledgers`) is accepted. It is upgraded with the frozen legacy migrations, and too old or newer files are refused with today's messages.
   - A unified database (`application_id` matches) is refused with "use the full backup to move a whole install".
   - Anything else is refused.
2. Category guard for limited keys (`wouldAddToSharedList`, ported to the unified catalog).
3. Snapshot, if the ledger has data: a ledger export.
4. `ATTACH`, while not in a transaction. Then one transaction under scope `[ledgerId]`, with `defer_foreign_keys=ON`:
   - `deleteLedgerRows(ledgerId, keep: activity)`. Restore keeps the activity log and ledger settings except `setup.completed`, as today.
   - Id plan: **identity** when none of the backup's ids is used by another ledger (the usual case, restoring your own backup). Otherwise offsets above the global maximum, with the JSON remap from §2.3.
   - Insert in `tables.ts` order with `transaction_links` before `transactions`, so the triggers touch nothing. This fixes today's renamed-refund bug.
   - Categories:
     - Token matches: the ids are the shared list's ids, and the off state goes to `ledger_category_off`.
     - Token differs: the name-matching path from §2.7, writing shared rows with `ledger_id NULL`.
     - Own-mode backup: own rows with new ids where ids collide, and `ledgers.category_list = 'own'`.
   - Raise `sqlite_sequence`. A `foreign_key_check` filtered to this ledger's tables runs, and the deferred FK check runs at commit.
5. `DETACH`. Afterwards, as today unless options say otherwise: clear the ledger's bank links (restore only), then `complete()`.

**Erase**: an export snapshot, then `deleteLedgerRows(keep: ledger_settings, activity)`, delete `setup.completed`, delete the ledger's `ledger_category_off` rows (every shared category is on again), and run `incremental_vacuum`. Bank links clear through the FK, with foreign keys on.

**Full backup**
- `VACUUM INTO` a temp file, then zip `{ chipmunk.db, manifest.json }` with format 2.
- The manifest says: stop the server, remove `chipmunk.db-wal` and `-shm`, unzip into the data directory.
- The manifest and docs also say that `secret.key` is not in the zip and must be copied separately to keep bank access and AI keys. This gap exists today.
- An old-format zip (`meta.db` plus `ledgers/`) unzipped into an **empty** data dir is converted at boot. Unzipped next to an existing `chipmunk.db`, it makes boot refuse with a message (§2.3).

### 2.7 Category list switching and catalog edits

The reviews found these unplanned. Under global ids they need real work.

- **Leaving the shared list** (`PUT /categories/sharing`, routes/ledger.ts:872-889):
  - In one transaction, copy every shared group, category, label and category_label to own rows with new ids, with the off state carried into `archived_at`.
  - Remap the ledger's `transactions`, `recurring_items`, `payee_rules`, `payee_category_stats` and custom-report specs through the same `remapSpec` helpers.
  - Delete its `ledger_category_off` rows and set `category_list = 'own'`, last: a guard trigger refuses `'own'` while any of those rows still point at a shared category.
  - Category ids change in that ledger. Today they don't. This is a visible change for API clients on an explicit, rare action (open question 4).
- **Joining the shared list** ports today's mismatch path to the unified tables:
  - Match own categories by name, or as `resolve` says.
  - Add missing ones as `ledger_id NULL` rows, refused for limited keys.
  - Set `category_list = 'shared'` first, then remap references to shared ids, delete the own rows, and write the off state. The guards check a row's category against the ledger's current list, so a remap to shared ids is refused while the ledger is still `'own'`.
  - Restore with a token mismatch uses this same function.
- **Deleting a shared category** resets `category_source`, `category_confidence` and `needs_review` on every affected transaction across ledgers before the DELETE, as `forget()` does per ledger today (catalog.ts:395-405). Otherwise SET NULL would leave transactions marked rule/ai/linked with no category.
- **Fan-out** of App-settings category edits becomes one transaction. Activity is still logged once per ledger (`logAll`) in Part 1, so there is no visible change.

### 2.8 Tests (Part 1, in summary)

- **Schema**
  - `transaction_lines` with two ledgers gives each ledger only its own lines.
  - The links-sum, follow-bill and refund-name triggers all still work.
  - Every guard trigger rejects its cross-ledger case.
  - Deleting a category, recurring item, group and account still works, which proves the SET NULL relations survived.
  - The nightly purge runs on transactions that bank payloads point at.
- **`ledger_categories`**: a shared-mode ledger sees the list with its own off state, an own-list ledger sees only its own rows, and switching off in A doesn't change B.
- **Golden fixtures.** These are built **before any refactor**, from the current code, by `test/legacy-fixture.ts`:
  - three ledgers: the default on the shared list; a second on the shared list with some categories off and a lagging catalog version; a third with its own list whose ids collide with shared ids
  - rows in every table: transfers, links, a renamed refund, tags, recurring items with dues and price changes, import batches, bank payloads
  - custom reports covering every reference kind, with picks, keeps, `'none'` and deleted ids
  - bulk and label activity entries
  - bank links into ledgers two and three
  - a dangling `transfer_pair_id`, a missing ledger file and gaps in `sqlite_sequence`
  - every GET response recorded as JSON
- **Conversion**
  - With one ledger, every id is unchanged and the goldens match byte for byte.
  - With three ledgers, the default ledger's goldens match byte for byte and the others match after id mapping. Comparisons use a stable tie-break, since the new indexes can reorder rows with equal dates.
  - Bank links survive, the renamed refund keeps its name, and `linked_minor` matches what the links compute.
  - The verifier aborts on an injected corruption (a changed value, a dropped row, a changed amount) without renaming, and the originals stay byte-identical.
  - Fault injection after every step: the next boot cleans up and converts again, giving the same logical content. A crash after the rename is finished from the record. A changed legacy file next to the new db makes boot refuse. A leftover lock file without a held lock doesn't block. Leftover `.partial-journal` files are removed.
  - Preflight: a too-old file or too little space (`statfs` mocked) aborts before any write. A missing file becomes an empty ledger.
  - The stub: v0.2.3's `openMetaDb` throws on it.
  - A second boot does nothing.
- **Remap unit tests**: every spec and activity shape listed in §2.3, and a deleted id stays deleted.
- **Column coverage**: every legacy column of ledger 0002 and meta 0000 is mapped or on the dropped list, and nullability differences are diffed.
- **Import and export**
  - A v0.2.3 per-ledger backup restores with ids kept.
  - Restoring after another ledger took colliding ids shifts them consistently.
  - Export, then import, gives identical rows.
  - An exported file passes the legacy migrations (nothing pending) and `foreign_key_check`.
  - A bad file leaves every ledger unchanged and no temp file behind.
  - Activity survives restore and erase.
  - No `bank_accounts` row points at a missing account after erase or restore.
- **Isolation test**: §2.4, in both directions.
- **Lifecycle**
  - Delete leaves zero rows of that ledger in every table, clears the default, restores from its `deleted-` file and shrinks the file.
  - Erase keeps activity and ledger settings.
  - The full backup round-trips.
  - Dry runs leave app tables unchanged.
  - The jobs test uses two ledgers, and one ledger's failure doesn't roll back another's.
- **Permissions** (runtime.test.ts): the db, the backups and the temp files are 0600 or 0700.
- **Query plans**: the list, summary, needs-review, trash, purge, activity and net-worth queries show a SEARCH on a ledger-led index, never a full SCAN.
- **Perf script (not in CI)**: 3 ledgers with 200k transactions in all. Time a 20k-row import with the guards on, a ledger delete and the full conversion.

### 2.9 Docs

Update these:
- `docs/configuration.md`: the DATA_DIR row
- `docs/development.md`: data layout and one `db:generate`
- `docs/security.md` and `SECURITY.md`: one file instead of "meta.db and every ledger"; note that global ids let a limited key estimate other ledgers' activity from id gaps
- `docs/self-hosting.md`:
  - the upgrade and how long it takes
  - don't redeploy during the first start
  - the stub and the refusal messages
  - the way back
  - restoring old zips
  - copying `secret.key`
  - the `-wal` warning
  - that `backups/` is never pruned
- `docs/releasing.md`: the dry-run step
- `Dockerfile:83` and `compose.yaml` comments
- route descriptions at routes/app.ts:192 and 211-213 and routes/ledger.ts:1627
- regenerated `docs/api.md`
- `CHANGELOG.md`:
  - the migration
  - "downgrade means restoring backups/pre-merge-*"
  - renumbered ids in non-default ledgers, including bookmarks and browser storage: `st.lastReport.<slug>`, `accounts.collapsed:<slug>`, `st-last-account`
  - the fixed renamed-refund restore bug
- comments in `client.ts`, `storage.ts` and `catalog.ts`

### 2.10 Part 1 phases

Each phase can ship on its own with no visible change. Pushes to `main` publish nothing, and releases happen only when you ask. Version numbers below are proposals.

**Phase 1.1: groundwork, still one file per ledger (proposed v0.2.4)**
- Golden fixtures and the legacy fixture builder.
- Move `drizzle/ledger` and `drizzle/meta` to `drizzle/legacy/*`, pointed at by env.ts. From here on, no new per-file migration may be written.
- Freeze copies of the catalog sync, `LIST_SQL` and `balancesAt` into `src/db/legacy/`.
- Add the `ctx.q` / `ctx.app` handle as a pass-through (checker off), and move every `ctx.sqlite` and `ctx.db` call to it. Convert the ledger-table drizzle calls to SQL.
- Add the static checks (no raw handles outside `src/db/`, the unscoped-sites list).
- Add the twin harness: read differential, B-hash writes and key checks.
- Prove it with the full suite green, migrations.test.ts against the legacy paths, the goldens stable over two runs, and the twin baseline green.

**Phase 1.2: the converter, shipped as a dry run only (proposed v0.3.0)**
- The unified `schema.ts` and `drizzle/app/0000_unified.sql`, with views and triggers.
- `src/db/unify/`: id plan, remap, importer, exporter, verifier and orchestrator, with fault-injection hooks.
- `unify-cli check` and `export-legacy`, as an esbuild entry in the image.
- The server still runs on the legacy files. Users see nothing.
- You run `check` on a copy of your production volume and we review the report together.
- Prove it with the schema, guard, view, remap, column-coverage, conversion, verifier, fault-injection and export round-trip tests, plus `check` on the fixture and inside the built image.

**Phase 1.3: the switch (proposed v0.4.0, a minor bump because stored data changes)**
- Pins in every statement, starting with the dangerous sites. The checker and write guards on in production.
- The `ledger_accounts` view used by all 26 account reads.
- Storage and registry on one connection, boot detection, conversion, stub.
- The ported `setup.ts` (restore, erase, demo), `/backup` through the exporter, full backup format 2.
- Category switching and fan-out (§2.7). Dry-run simplification. Jobs.
- Docs and changelog.
- It lands on main as several PRs with no release between them, because the schema can't ship without the scoping and the conversion.
- Release only after `check` passes on a fresh copy of production data and a rehearsal on a copied Docker volume:
  1. start the new image
  2. read the log and report
  3. use the app
  4. restart
  5. start the v0.2.3 image to confirm it stops on the stub
- Prove it with the whole of §2.8: the isolation test in both directions with probes, the goldens after conversion, and the lifecycle and permission tests.

**Phase 1.4: follow-ups (optional, patch releases)**
- Enforce the call-site coverage report: every `ctx.q` call site has run in tests. It starts as report-only.
- `POST /ledgers` with a backup creates the ledger only if the import succeeds. The import is built in a temp file first, because `ATTACH` can't run inside a transaction.

---

## 3. Part 2: shared credit cards

### 3.1 Data model

**Accounts**
- `accounts.ledger_id` keeps its name and means **the home ledger**. Keeping the home in one column means there is always exactly one, and changing it is one UPDATE. The column isn't renamed, because a rebuild would cascade-delete transactions.
- New `account_ledgers(account_id → accounts CASCADE, ledger_id → ledgers, institution_id NOT NULL → institutions, sort, archived_at, created_at, PK(account_id, ledger_id))`, with an index on `(ledger_id, sort)`. It lists every ledger the account is in, home included.
  - Backfill: one home row per account from `accounts`.
  - An **AFTER INSERT ON accounts** trigger creates the home row, so raw inserts (test helpers, seed-demo, restore) can never miss it.
- Per-ledger fields move to the membership row: institution (institutions are per ledger, so each ledger has its own row), sort and archived. The old columns on `accounts` stay but are no longer read or written.
- Account-level fields, the same everywhere and edited from home only: name, type, currency, opening balance and date, notes, import mapping, the bank link, balance snapshots and bank payloads.
- The `ledger_accounts` view from Part 1 is redefined over `account_ledgers` and takes the per-ledger fields from it. No query that reads accounts changes.
- Only `type = 'credit'` accounts may have more than one membership row, and while they do, the type can't change.

**Transactions**
- `transactions.ledger_id` is the ledger that holds the row. Exactly one ledger holds it, and that ledger owns everything that interprets it: category and its source, confidence and review flag, notes, name, tags, recurring item, dues and not-payments, transfer pair and links.
- The bank's facts on the row are the same wherever it is: date, amount, payee, status, external id, `corrected_at` and bank category.
- New column `moved_at`: when someone placed the row by hand.

**New tables**
- `transaction_moves(id, created_at, from_ledger_id, to_ledger_id, kind 'hand' | 'unshare' | 'ledger_delete', actor, api_key_id, undone_at, items JSON)`. `items` holds each row's before-state: category fields, name, recurring item with dues and not-payments, tag names, pair, links and `moved_at`.
  - Both ledger FKs are ON DELETE CASCADE: once a ledger is gone an undo can't happen, and activity keeps the history.
- `move_hints(transaction_id PK → transactions CASCADE, ledger_id, reason 'recurring' | 'refund' | 'card_payment', ref_id, created_at)`. These are suggestions only. Nothing moves on its own.

**Guard triggers**
- Part 1's account guard becomes: an `account_ledgers` row must exist for `(NEW.account_id, NEW.ledger_id)`.
- New `BEFORE UPDATE OF transfer_pair_id`: both sides must be in one ledger.
- The link guards (INSERT and UPDATE) are already there from Part 1.
- New `tx_move_keeps_refs`: refuse to change `ledger_id` while the row still has a pair, links, tags, a recurring item or dues. The move code clears these first, in the same transaction.
- New index `transactions(account_id, ledger_id, date)`.

### 3.2 Three kinds of query

1. **Ledger-wide** (`ledger_id = @ledger`): everything by default, including reports, `transaction_lines`, totals, filters, recurring detection, AI, payee stats and lists. Each row is in exactly one ledger, so nothing is counted twice.
2. **Membership** (`ledger_accounts`): every read of accounts. This is what makes the card appear in each member ledger: net worth, `balancesAt`, the transaction sort order (`OUT`, transactions.ts:78), the AI card set (import.ts:260), matching's account join (matching.ts:69), CSV export (reports.ts:423), report account names (custom-reports.ts:97), the existence checks in insert, update, import and recurring, and the counts. Institution counts, deletion and merging go through `account_ledgers` (institutions.ts).
3. **Card-wide** (`account_id = @account`, through `accountScope(accountId)`, a listed escape in the checker). Its rows return to bank or import code with their `ledger_id` and never go into an API response as they are. The complete list:
   - `applyRemoteTransactions`: local rows, `byExternalId`, orphans, adoption candidates, `logPayloads`, `landed`
   - `latestBankPayload`
   - `localStamp`, `previewSwitch` and `applySwitch` rows
   - `caughtUp`'s oldest date
   - `alignWithBank`, through `cardBalance`
   - **`applyKept`'s external-id set (service.ts:634)**
   - `findDuplicates` (CSV) and `findByExternalId`
   - the refund "bought from this merchant" lookup, used to decide whether a credit is a card payment (read only)
   - `undoBatch`

   Each has a test proving it sees moved rows.

### 3.3 Sharing, the home ledger, unsharing, changing the home

`services/sharing.ts`, routes under the home ledger:

- `GET /accounts/:id/sharing` returns each member ledger the caller may use, with its held count, its part, and whether it is the home.
- `PUT /accounts/:id/sharing { ledgers, home, ?dryRun }` makes the sharing exactly what is given, in one transaction.
  - Checks:
    - the account must be a credit card (409 otherwise)
    - the caller must be able to use the home and every ledger added or removed (403 names the ledger)
    - target ledgers must not be archived
  - **Adding a ledger** inserts a membership row, with an institution in that ledger found or created by the home institution's name. Nothing moves.
  - **Removing a ledger** (unsharing): its rows on the card go back to the home ledger through a move of kind `unshare` (§3.4), shown in the dry run first. Then, in that ledger:
    - set `recurring_items.account_id` to NULL
    - list the custom reports that filter on the card in the response, so they can be fixed
    - delete its institution row if it is now empty
    - delete the membership row
  - **Changing the home ledger** (the new home must be a member): `UPDATE accounts SET ledger_id = new`. The opening balance and snapshots follow the role, so the old home's part becomes the sum of its rows and the new home's part takes the rest. The response shows both ledgers' parts before and after, and both ledgers get an activity entry. `bank_accounts` needs no change, since it has no `ledger_id` after Part 1.
- **Home only** (409 with the home ledger's slug otherwise):
  - account-level PATCH fields
  - `POST /balance` and snapshots (`requireManualBalance` gains `requireHome`)
  - every `/accounts/:id/bank*` route, link, unlink, fill and switch review
  - CSV preview, commit and undo for the card
  - `DELETE` of the card, which needs every member ledger
- **Leaving from a member ledger:** `DELETE /accounts/:id` there returns 409, "Visa is shared from Personal. Remove this ledger from its sharing there." Archive, institution and reorder work in any member ledger.
- `bankLinks()` finds the link by account id. A member ledger sees `bank.managedIn: {slug, name}` ("Synced in Personal").

### 3.4 Moving transactions

`services/moves.ts`, `moveTransactions(fromCtx, { ids, to, pairWith?, strict?, dryRun })`. It returns `{ moveId, moved, carried, unlinked, unpaired, recategorized, recurringDetached, tagsCreated, skipped }` and runs as one transaction across both ledgers.

1. **Check.** Each id must be held by `from`, not deleted, and on an account that has a membership row for `to`. `to` is not `from` and not archived, and the caller may use both. Rows that don't fit are `skipped`, or with `strict` the whole move fails with 400. The limit is 500 ids per request.
2. **Refunds move with their purchase.** A transaction moves together with its links on the same card held by `from`: a purchase with its refunds, a refund with its purchase, and the bills of a payback on the card. Those come along as `carried`. A link to a row that can't move (a payback in chequing, or an account `to` doesn't have) is deleted as `releaseTransactionLinks` does, and `settleLinkedCategory` runs on the money-in side in `from`.
3. **Transfers and card payments.** A paired leg whose other side stays behind is unpaired on both sides, as "Not a transfer" does (transactions.ts:686-700). A `transfer_rejections` row is added so matching never pairs them again. Each side keeps its money-moving category.
   - Example: Personal's chequing paid part of Household's balance. Personal's net worth falls with no spending, and Household's part falls with no income, which is correct for each ledger.
   - With `pairWith`, the moved payment is paired with a withdrawal held in `to`.
4. **Recurring.** In `from`, its dues and not-payments are recorded in the move, then deleted, `recurring_item_id` is cleared, and the item is recalculated after commit. In `to`, `matchRecurring` may link it to that ledger's own item and stamp its category.
5. **Category** (`categoryIn(toCtx, id)`):
   - kept if it is on in `to`
   - otherwise the category with the same name, if it is on in `to`
   - otherwise `to`'s history suggestion, marked for review unless it auto-applies
   - otherwise uncategorized, with AI categorizing it in the background when AI is on and the move is not a dry run
   - The source becomes: `linked`, recomputed from the links that came along; `recurring`, replaced by `to`'s item, or `user` if none; `rule` (card payment), from `cardPaymentCategory(toCtx)`; anything else is kept.
   - `learn()` is never called: moving isn't choosing a category.
6. **Tags** move by name. Missing ones are created in `to` and listed in `tagsCreated`.
7. **Notes and name** stay on the row.
8. **Write.** `ledger_id = to`, `moved_at = now` for hand moves, `updated_at = now`. Delete the row's hints and insert the `transaction_moves` row.
9. **Activity in both ledgers.** In `from`: "Moved 3 transactions on Visa to Household". In `to`: "3 transactions on Visa moved here from Personal".
10. **Undo** (`POST /moves/:id/undo`, the caller needs both ledgers):
    - It is allowed while every row is still held by `to` and no later move includes it. Otherwise it returns 409 listing the rows.
    - It restores the before-state wherever it can: category fields, tags by name, the recurring item with dues and not-payments (if the item still exists), the pair (if the other leg is still unpaired, removing the rejection the move added) and the links (if both sides still exist).
    - Anything it can't put back is listed.
    - Edits made in `to` after the move are discarded. The confirmation says so.

An edit, delete, restore, the nightly purge (by the holding ledger's job) or a bank update changes a moved row in place, and the row stays where it is.

### 3.5 Balances and net worth

- **Card balance**, from the new `cardBalance(accountId, at?)`: today's formula across all ledgers. That is the latest snapshot or the opening balance, plus every non-deleted transaction after it. It is the bank's number.
- **A ledger's part** (`balanceMinor` in the DTO):
  - a member ledger: the sum of the non-deleted rows it holds
  - the home ledger: the card balance minus the members' parts, so it keeps the opening balance and the snapshots
  - The parts always add up to the card balance.
- `LIST_SQL` filters counts and sums by `t.ledger_id = @ledger`, and the home ledger subtracts the other ledgers' sums.
- `balancesAt` computes the card total per date and splits it the same way. Before `opening_date` every part is 0.
- `netWorth` reads accounts through `ledger_accounts`, so a member ledger's net worth includes its part. (The earlier design wrongly said net worth used `balanceMinor`.)
- `runningBalances` starts from the ledger's part and walks back through the rows it holds. `monthToDate` stays ledger-scoped.
- New DTO field `Account.sharing = { homeLedger, isHome, ledgers, cardBalanceMinor, cardMonthMinor } | null`, where `ledgers` lists only the ledgers the caller may use.
- **Card-wide figures are shown only to callers who may use every member ledger.** For anyone else, in a member ledger, these are null or hidden: `cardBalanceMinor`, `cardMonthMinor`, `bank.balanceMinor`, `bank.balanceDate`, `openingBalanceMinor`, `balanceAsOf` and the snapshot routes. Otherwise the home's part could be worked out from them. The web session (you) sees everything.
- **Deleting a moved row in a member ledger:** if the home has a snapshot dated after the row, the card balance doesn't change, so the home's part shifts by that amount at once. Without a snapshot, the next sync's balance check moves it into the home's opening balance. Either way the UI warns and offers "Move instead".

### 3.6 Bank sync into the home ledger

- `applyRemoteTransactions` runs with the home context and reads the card's rows card-wide, each with its ledger. It gets other ledgers' contexts from the registry, which `AppContext` now carries.
  - **New rows** go into the home ledger. That includes fetch-history, a switch's bank-only rows and `fill`.
  - **Known ids** are updated in place, so a moved row gets the bank's date, amount and status and stays moved. Payee carry-over updates the holding ledger's stats.
  - **Pending to posted:** a pending charge moved to B that posts (Plaid `replaces`, or SimpleFIN orphan matching, both card-wide) keeps its id and is updated in B. No new row appears in home.
  - **Corrections:** `corrected_at` is kept on the row wherever it is.
  - **Adoption:** a row you added by hand in B (§3.7) is adopted in place and stays in B.
  - **Removals and vanished pending rows** are soft-deleted in place and logged in the holding ledger. Recurring items are recalculated there.
  - `ApplyResult.byLedger` holds each ledger's updated, adopted and removed counts.
- `applyToLinked`: home gets today's "Synced Visa…" activity entry. Each other ledger with changes gets "Bank updated 2, removed 1 on Visa", and `settle()` runs in every ledger that changed.
- **The balance check:** `alignWithBank` (service.ts:901) compares the bank's balance with **`cardBalance`**, never with the home's part, and adjusts the home's opening balance or snapshot as today. Compared with the part, every move would look like a gap, and the moved money would be counted twice. `caughtUp`'s oldest date is card-wide.
- **Switch review** is home only. Rows are card-wide, and each local row carries `ledger: {slug, name} | null`. Removing a row held elsewhere needs that ledger (403). Added rows go to home.
- `refreshPayees` and `applyKept` are card-wide (service.ts:634 included).
- Sync permission: `requireConnectionLedgers` keeps checking the home ledger only. Sync writes only bank facts into rows other ledgers hold, and it **never moves rows**, because there are no automatic follows in v1 (§3.8).

### 3.7 CSV import and manual entry

- Preview, commit and undo for a shared card are home only. From a member ledger they return 409 with a link to the home ledger.
- `findDuplicates` and `findByExternalId` are card-wide. A file that overlaps moved rows imports nothing twice, and the preview shows "Already in Household" (`duplicateLedger`), naming the ledger only when the caller may use it.
- A `POST /transactions` with an external id already held by a ledger the caller can't use returns 409 "already recorded in another ledger", with no details.
- `undoBatch` deletes the batch's rows wherever they are, after releasing their links in each holding ledger. The caller needs every holding ledger, and the dialog says "2 of them are in Household now".
- **Manual entry** (form or `POST /transactions`) on a shared card in a member ledger puts the row in that ledger, since you added it there. The next sync adopts it in place.

### 3.8 Matching and hints (no automatic moves)

You said no automatic rules yet. Automatic follows inside sync would also let a key limited to one ledger move rows into another. So v1 only **suggests**:
- **Refunds:** for a credit on a shared card, the card-wide purchase lookup decides that it is a refund, not a card payment. That way a refund of a moved purchase is never filed as "Credit card payment". If the purchase is held in another ledger, the refund stays where it landed, unlinked, and gets a `move_hint(reason 'refund')`.
- **Card payments:** look for the matching withdrawal in the credit's own ledger first, as today. If the only candidate is in another member ledger, add a `move_hint(reason 'card_payment', ref_id withdrawal)`. Moving with `pairWith` then pairs them.
- **Recurring:** when a new row on the card would match an active recurring item in another member ledger, add a `move_hint(reason 'recurring')`.
  - The hint is added even if the home ledger's own item matched too, because `insertTransaction` calls `matchRecurring` straight away (transactions.ts:613).
  - If the payee's previous payment was moved by hand to that ledger, the home ledger doesn't link the new row to its own item.
- `moved_at` and `transfer_rejections` block hints that would undo a hand move.
- A hint names a ledger only when the caller may use it. A hint is deleted when its row moves or is dismissed.

### 3.9 Ledger lifecycle and backups

- **Deleting a member ledger:** its rows on shared cards go back to home (move kind `ledger_delete`), then its memberships are removed. The delete dialog shows the counts.
- **Deleting a home ledger:** 409 unless the body has `newHomes: { [accountId]: slug }`. The home changes for each card first, then the step above runs.
- **Erasing or restoring one ledger that shares a card:** 409, "Remove it from Visa's sharing first". The full backup stays allowed.
- **Archiving** is allowed. An archived ledger can't receive moves or be added to a card. Warn when a home ledger is archived, because its daily jobs stop.
- **A member ledger's export** includes the shared card as a stripped account row: name, type and currency, opening balance 0, no snapshots, notes, import mapping or payloads, with its own institution and the rows it holds. Restoring that file elsewhere, or after unsharing, brings the card back as a plain account of that ledger with no bank link. Nothing of the home ledger leaks.
- **The home ledger's export** includes the full account and only the rows it holds.
- Per-ledger counts on `/ledgers` stay per ledger, with each row counted once.

### 3.10 Version-one rules and limits

| Rule | Reason |
|---|---|
| Only credit cards can be shared. | Your decision. It also keeps net worth simple (only liabilities split). |
| One home ledger. Sync, CSV import, the balance check, snapshots and bank actions happen there. | One place where new rows land and the bank's balance is reconciled. |
| Moves are by hand only. Refunds and card payments get hints, not moves. | Your decision. Automatic moves inside sync would also break API-key scoping. |
| A transaction belongs wholly to one ledger: no splits. | There is no split feature today. Splits would be a separate project. |
| **A lump-sum payment can't be divided.** Parts may not settle: one ledger's part keeps growing while another's shows a credit. | It follows directly from "a ledger's part is the sum of the rows it holds". Open question 5 has the options. |
| Links and transfer pairs never span ledgers. | That keeps `transaction_lines`, the link triggers and the totals unchanged in each ledger. |
| Account-level fields are edited from home only. | One owner per fact. Archive, institution and order are per ledger. |
| Card-wide figures only for callers who can use every member ledger. | Otherwise the other ledgers' parts could be worked out. |
| The type can't change while shared. Archived ledgers can't be added or receive moves. | Avoid states the rules don't cover. |
| No single-ledger erase or restore while sharing a card. | Keeps the parts summing to the bank in every path. |
| Undo only while no later move touched the rows. | Undo restores a recorded state, and a later move makes that state stale. |
| At most 500 ids per move. | Keeps one synchronous transaction short. |

### 3.11 REST API

Every route declares its scope and schemas and gets OpenAPI text explaining "home ledger", "part" and "move" (openapi.ts). New shared zod schemas: `accountSharingSchema`, `moveRequestSchema`, `moveResultSchema`, `transactionMoveSchema`, `moveHint`, `duplicateLedger`, and the ledger field on switch-review rows. The route-coverage test covers every route.

| Route | Notes |
|---|---|
| `POST /ledgers/:ledger/transactions/move` | write scope, idempotency key, `?dryRun`. Body `{ ids, to, pairWith?, strict? }`, returns `MoveResult`. |
| `GET /ledgers/:ledger/moves?limit` | recent moves in or out of this ledger |
| `POST /ledgers/:ledger/moves/:id/undo` | returns `MoveResult` |
| `GET /ledgers/:ledger/accounts/:id/sharing` | per-ledger counts and parts, plus the card total when allowed |
| `PUT /ledgers/:ledger/accounts/:id/sharing` | `?dryRun`, body `{ ledgers, home }`, home only |
| `POST /accounts` | accepts `sharedWith` (credit only) |
| `GET` / `DELETE /ledgers/:ledger/transactions/:id/move-hint` | read, dismiss. `Transaction.moveHint` in the DTO |
| `GET /transactions/:id` for a row another ledger holds | 404 "It's in Household now", naming the ledger only if the caller may use it |
| `DELETE /ledgers/:ledger` | accepts `newHomes` |
| DTOs | `Account.sharing`, `bank.managedIn`, `duplicateLedger`, switch-review `ledger` |

### 3.12 MCP

- New tools:
  - `move_transactions { ledger, ids | filter (as search_transactions), to, pairWith?, dryRun }`, which shows category changes, links dropped, pairs undone and recurring detached before it commits
  - `undo_move`
  - `share_account { ledger, account, ledgers, home }`
- `create_account` gains `sharedWith`. `accountView` gains sharing (home, ledgers, part, and the card total when allowed). `transactionView` gains `moveHint`.
- `list_accounts` notes "your part" for shared cards.
- `import_transactions` and `record_balance` in a member ledger relay the API's 409 text.
- The MCP lookup cache (context.ts:102-143) is keyed by ledger. It drops an account entry after a sharing change, and drops everything when the server reports a new storage version, for example after the conversion.
- Tool text says "home ledger", never "default ledger".

### 3.13 Web UI

- **TransactionTable.vue:** "Move to…" in the selection toolbar, listing the ledgers shared by every selected row's card, disabled with a tooltip otherwise.
  - A confirmation shows the dry run: carried refunds, links dropped, pairs undone, category changes, recurring detached, and that undo discards later edits.
  - A toast "Moved 3 to Household · Undo" follows.
- **TransactionForm / TransactionPanel:** a ledger row on shared-card rows ("Personal · Move…") and a hint banner ("Looks like Household's Netflix: Move · Dismiss").
- **AccountFormDialog:** a "Share with" checklist and a home picker, credit only. In a member ledger, account-level fields are read-only with "Change it in Personal".
- **AccountDetailPage:** "Your part $X · card balance $Y". Bank, balance and import actions are hidden in member ledgers, with a "Synced in Personal" link. AccountsPage shows a "Shared" badge.
- **LedgerSwitcher:** on a shared card's page, it opens the same account in the other ledger (ids are global).
- **queries.ts:** `useMoveTransactions`, `useUndoMove` and `useSharing`. After a move, a sharing change or a sync, invalidate both ledgers' caches (`['l', slug]`). The response lists the affected ledgers.
- **LedgersSettings:** the delete dialog lists shared cards and asks for new homes.

### 3.14 API key scoping

A new `requireLedgers(actor, ids)` in api/auth.ts. The rules:
- **Moves:** both `from` and `to`. A key limited to B can neither pull rows out of A nor push into A.
- **Undoing a move:** both ledgers.
- **Sharing changes:** the home ledger and every ledger added or removed.
- **Deleting the card:** every member ledger.
- **Undoing an import:** every ledger holding its rows.
- **Switch-review removals of rows held elsewhere:** that ledger.
- **Sync:** the home ledger. It writes only bank facts and never moves rows.
- **Card-wide figures, other ledgers' names in hints, duplicate notes, 404 and 409 messages, and switch-review rows:** only shown when the caller may use the ledgers involved.

### 3.15 Part 2 phases and tests

**Phase 2a: membership and the balance model, invisible (proposed v0.4.1)**
- `account_ledgers` with the backfill and the insert trigger.
- The `ledger_accounts` view over it. Per-ledger fields read from and written to membership. Institutions counted through membership.
- `cardBalance`, the parts in `LIST_SQL`, `balancesAt` and `netWorth`.
- The new tables (`transaction_moves`, `move_hints`) and guard triggers, unused for now.
- `AppContext` gains the registry, if Part 1 didn't add it.
- Tests: every account has one membership row equal to its `ledger_id`, the full suite and the goldens unchanged, the insert trigger covers raw inserts (test helpers, seed-demo, restore), and the guard rejects a non-member transaction.

**Phase 2b: sharing, moves and card-wide bank and import, through the API and MCP (proposed v0.5.0)**

Sharing must not ship without the card-wide sync, or sync would duplicate moved rows. This phase includes `sharing.ts`, `moves.ts` with undo, home-only guards, the §3.2 card-wide list, the bank changes, CSV, manual entry, lifecycle, export of member ledgers, key scoping, OpenAPI and the MCP tools.

Tests:
- **Parts and balances**
  - After moving -$120 to B, B's part is -$120 and home's part is the bank's balance plus $120. They sum to the card balance, with and without a snapshot, at past month-ends and in each ledger's net worth.
  - B's running balance ends at B's part.
- **Bank sync on moved rows**
  - A sync after a move with the bank's balance unchanged leaves the opening balance unchanged.
  - A pending row moved to B posts in B (Plaid `replaces`, and SimpleFIN orphan matching), with no new row in home.
  - Corrections are kept. A removal is soft-deleted in B and logged in B.
  - Fetch history adds no duplicates.
  - `refreshPayees` updates moved rows.
- **Switch review and CSV**
  - Switch review lists moved rows with their ledger, and removal needs that ledger.
  - A CSV that overlaps moved rows imports nothing twice. Import from B returns 409. Undoing a partly moved batch needs both ledgers.
- **Moves**
  - Category mapping in all four branches, with `learn()` untouched.
  - A refund is carried with its purchase. A payback from chequing is unlinked and settled.
  - A transfer is unpaired with a rejection, and neither ledger's matching pairs it again. `pairWith` works.
  - Recurring is detached and re-matched. Tags are created by name.
  - Undo restores everything, and returns 409 after a later move.
  - A dry run changes nothing: no AI started, no activity, no `transaction_moves` row.
- **Permissions**
  - B-only and A-only keys are refused for cross moves.
  - Card totals, bank balance, opening balance and snapshots are hidden from a B-only key. Every field of the account DTO is checked.
- **Lifecycle**
  - Unsharing moves rows home and cleans up recurring items, the institution and the report list.
  - Changing the home moves the opening-balance role, and the next sync lands in the new home.
  - Deleting a member ledger, or a home ledger with `newHomes`, keeps the parts summing to the bank. Single-ledger erase or restore returns 409.
  - A member ledger's export holds no snapshots or opening balance, and restores as a plain account after unsharing.
- **Delete in a member ledger**
  - With a later snapshot in home, home's part shifts at once.
  - Without one, the next sync shifts the opening balance.
- **Isolation**
  - The twin test gets a shared card: each ledger lists only what it holds, and a moved id is 404 in A.
- **MCP**
  - Resolve the card by name in B, dry-run a move, relay the 409.

**Phase 2c: the web UI (proposed v0.6.0)**
- Everything in §3.13.
- Tests: component tests where they exist, plus a manual run in two ledgers covering share, move, undo, sync and unshare.

**Phase 2d: hints (patch or minor)**
- `move_hints` for refunds, card payments and recurring, with their routes, DTO and UI banner.
- Tests:
  - A refund of a purchase moved to B gets a refund hint and is never called a card payment.
  - A payment whose only withdrawal is in B gets a hint.
  - A recurring hint is created even when home matched its own item.
  - Hints respect `moved_at` and rejections, and are deleted on move.

**Docs for Part 2:** features.md (shared cards, parts, limits), api.md, mcp.md, bank-sync.md ("syncs into the home ledger; moved transactions stay where you put them") and the changelog.

---

## 4. Open questions for you

1. **Renumbering:** should the default ledger keep its ids while other ledgers are renumbered above every existing id? **Recommended: yes.** Single-ledger installs see no change at all, and a stale id in a renumbered ledger gives 404, never the wrong row. The offsets are recorded in `storage.merged`. A permanent lookup table from old to new ids isn't worth its complexity, and the release notes list what changes (API scripts, MCP memory, bookmarks, three browser-storage keys).
2. **Downgrade guard:** a text stub `meta.db` rather than a bridge release v0.2.4 that refuses to start? **Recommended: the stub.** It works for users who skip versions. A bridge release adds nothing then, and v0.2.4 can stay the Phase 1.1 groundwork release.
3. **Leaving the shared category list renumbers that ledger's category ids** (today it doesn't). Acceptable? **Recommended: yes**, documented in the API text and the activity entry. It is a rare, explicit action, and the alternative is composite category keys everywhere.
4. **Old full-backup zips over an existing install:** refuse to start with a clear message, rather than adding an "import full backup" upload? **Recommended: refuse now.** Add the upload later if it's asked for.
5. **Lump-sum card payments** can't be divided, so ledger parts may never settle. **Recommended for v1:** keep your rule exactly, a ledger's part is the sum of what it holds. Document the limit and show each part clearly; the workaround is to move the payment to the ledger whose part it mostly pays. If it bothers you in use, add **card settlements** as a follow-up: a non-bank record moving part of the card's debt from one ledger to another. The settlements sum to zero across the card and count in each ledger's part and net worth.
6. **Refund and card-payment follow-moves:** move automatically or only suggest? **Recommended: only suggest in v1**, as move hints with one click. This matches "no automatic rules yet", and automatic moves during sync would let a key limited to one ledger move rows into another.
7. **Manual entry on a shared card in a member ledger:** put the row in that ledger? **Recommended: yes.** You added it there, and the next sync adopts it in place.
8. **Tags on a move:** carry them by name, creating missing ones? **Recommended: yes.** Dropping them would lose labels silently.
9. **A category that is off in the target ledger:** map by name, then the target's suggestion, then uncategorized? **Recommended: yes**, rather than switching the category on in the target behind its back.
10. **Unsharing:** move the ledger's rows back to home automatically (with a dry-run count), or refuse until that ledger moves them? **Recommended: move them home.**
11. **Deleting a synced, moved row in a member ledger:** warn and offer "Move instead", or block? **Recommended: warn.** Blocking would surprise users, since deleting rows works everywhere else.
12. **Restore and bank links:** keep cutting a ledger's bank links on restore even when the account ids are unchanged? **Recommended: yes in Part 1** (no visible change), and revisit later.
13. **Fail closed in production:** should the pin checker and write guards stay on in production, giving a 500 instead of a leak? **Recommended: yes.** The cost is negligible.
14. **Another ledger's id: 404 or 403?** **Recommended: 404**, worded exactly like a missing id, so the id's existence isn't revealed.
15. **Pruning `data/backups`:** with one database, each pre-migrate snapshot is the whole install. **Recommended: keep today's no-pruning**, and say so in self-hosting.md.

---

## 5. Risks and how each is handled

| Risk | Handling |
|---|---|
| A query without its ledger pin shows or changes another ledger's data (about 500 statements). | The pin checker rejects unpinned SQL at prepare time. Write guards abort writes outside the scope. Guard triggers stop cross-ledger references. Accounts are read only through `ledger_accounts`. The twin isolation test runs in both directions over every route and MCP tool. Static checks forbid raw handles. |
| Whole-table statements (restore, erase, catalog sync, demo seed) wipe every ledger. | Listed as dangerous sites and rewritten first, generated from `tables.ts`. They run under scope `[ledgerId]` with the guards on. The isolation test runs erase and restore. |
| The conversion loses or corrupts data. | Work copies, with the originals never written. A `.partial` build with no journal. A column-driven row comparison plus money, balance and net-worth checks using frozen copies of today's code. Atomic rename. Originals kept as the backup. The dry-run CLI on your real data before release. A rehearsal on a copied volume. |
| A crash or `docker stop` mid-conversion. | Everything before the rename is thrown away and redone. After the rename, the next boot finishes from the hash record. The OS-held lock can't brick boot. Leftover `.partial*` files are removed. Progress is logged per ledger. The docs say not to redeploy during the first start. |
| Restored old files, or a downgrade, get silently set aside. | Every original file is hashed. Any mismatch refuses to start with an explanation. The stub stops pre-merge versions. |
| Shared-list category ids collide, or get nulled on first sync. | Category ids stay the catalog's. The default ledger's list keeps identity. The frozen sync runs on the work copies until nothing needs syncing. A migration test with two shared ledgers asserts every `category_id` survives. |
| SET NULL relations break under composite keys. | Single-column FKs are kept, and same-ledger is enforced by triggers. Tests delete a category, recurring item, group and account, and run the purge. |
| Dangling references (for example `transfer_pair_id`) break the merge or point across ledgers. | Repaired before constraints apply (NULLed and logged). JSON ids are offset into reserved, never-used ranges. |
| A per-file migration or a table rebuild cascade-deletes data. | No per-file migration is ever shipped again. No migration may rebuild cascading tables. drizzle's `BEGIN` wrapping is documented in `client.ts`. |
| Bank links cut during the conversion. | The importer takes options, and the conversion keeps and remaps links. A test checks each link still points at the same-named account. |
| Saved reports silently change totals (`picked`/`keep`). | Explicit remap plus spec reparse and `filterRefs` checks in the verifier. |
| Triggers rewrite names, `linked_minor` or `updated_at` during copy. | Links are inserted before transactions, with deferred FKs on, in both the importer and the exporter. `linked_minor` is recomputed and checked. |
| Not enough disk space. | A 2.5× preflight on DATA_DIR, with all temp files under DATA_DIR. It aborts before writing anything. |
| A long conversion shows the container as unhealthy. | Docker doesn't restart unhealthy containers under `unless-stopped`. Log progress. Optionally answer `/healthz` with 503 "upgrading" during the conversion. |
| One write lock for every ledger. | better-sqlite3 already serializes writes in-process, so nothing changes there. Long operations (delete, restore, conversion) are timed with the perf script, and chunked if one blocks more than about 1s. |
| Guard-trigger overhead on bulk imports. | Measure a 20k-row import. Expect tens of milliseconds per 10k rows. |
| A rarely used path fails closed in production. | Twin-test breadth, then the call-site coverage report (Phase 1.4). Job failures are surfaced in App settings, not only in logs. |
| Part 2: the bank balance compared with a ledger's part, counting moved money twice. | `alignWithBank` and `caughtUp` use `cardBalance`. A dedicated test runs a sync after a move. |
| Part 2: a card-wide query keeps a ledger filter, so sync or import duplicates moved rows in home. | The complete card-wide list in §3.2, each through the `accountScope` helper and each with its own test (applyKept included). |
| Part 2: a shared card vanishes from member ledgers in some code path. | All account reads go through `ledger_accounts` (Part 1). The checker forbids raw account reads. Net worth is tested per ledger. |
| Part 2: leaks to limited keys (card totals, bank balance, opening balance, snapshots, names in hints or messages). | The visibility rule in §3.5 and §3.14. The permission test checks every DTO field and message. |
| Part 2: lump-sum payments leave parts unsettled. | Documented as a v1 limit. Settlements as a follow-up (open question 5). |
| Part 2: undo discards edits made after a move. | Stated in the confirmation, and undo is refused after a later move. |
| Part 2: recurring items in member ledgers miss payments that keep landing in home. | Recurring hints, including when home matched its own item. Home doesn't link a payee whose last payment was moved by hand. |
| Part 2: moves fire link triggers and break `linked_minor` or names. | The fixed order (drop links, move rows, re-match) is tested with a refund of one bill and a payback covering several bills. |

---

## 6. Rough size of each phase

These are estimates for one engineer who knows the codebase, including tests.

| Phase | What | Lines touched (rough) | Effort |
|---|---|---|---|
| 1.1 Groundwork | handle conversion across ~33 files, drizzle-to-SQL, static checks, golden and legacy fixtures, twin baseline, frozen legacy copies | 3,000 to 4,000 (mostly mechanical) | 1 to 1.5 weeks |
| 1.2 Converter as dry run | unified schema and views and triggers, id plan, JSON remap, importer, exporter, verifier, orchestrator with fault injection, CLI entry | 3,500 to 5,000 | 2 to 2.5 weeks |
| 1.3 The switch | pins in every statement, checker, write guards, `ledger_accounts`, storage and registry, boot detection and stub, setup and backup ports, category switching and fan-out, dry run, jobs, docs, rehearsal | 8,000 to 10,000 | 4 to 5 weeks |
| 1.4 Follow-ups | call-site coverage enforcement, atomic create-from-backup | 500 | 2 to 3 days |
| 2a Membership and balances | `account_ledgers`, view swap, institutions, `cardBalance`, parts, new tables and triggers | 1,500 | 1 week |
| 2b Sharing, moves, card-wide sync and import (API and MCP) | sharing, moves and undo, home guards, card-wide list, bank and CSV changes, lifecycle, export, key scoping, OpenAPI, MCP tools | 5,000 to 6,000 | 3 to 4 weeks |
| 2c Web UI | move dialog and toast, form ledger row, sharing dialog, account page parts, switcher, delete dialog | 2,000 to 2,500 | 1.5 weeks |
| 2d Hints | refund, payment and recurring hints, routes, banner | 800 to 1,000 | 3 to 4 days |

In total, Part 1 is about 8 to 9 weeks and Part 2 about 6 to 7 weeks. Phase 1.3 is the biggest and riskiest step, which is why Phase 1.2 ships the converter as a dry run first, so you can check it against your own data before anything changes for users.