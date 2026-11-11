// Idempotent initialization, including atomic removal of legacy mailbox uniqueness.
export const parserSchema = [
    `CREATE TABLE IF NOT EXISTS parser_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES user(user_id) ON DELETE CASCADE,
        account_id INTEGER NOT NULL REFERENCES account(account_id) ON DELETE CASCADE,
        name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
        rules_json TEXT NOT NULL, webhook_url TEXT NOT NULL DEFAULT '', webhook_secret TEXT NOT NULL DEFAULT '',
        start_email_id INTEGER NOT NULL DEFAULT 0, last_scanned_at INTEGER NOT NULL DEFAULT 0,
        retention_days INTEGER NOT NULL DEFAULT 0, conditions_json TEXT NOT NULL DEFAULT '[]', scan_email_id INTEGER NOT NULL DEFAULT 0,
        last_processed_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_parser_config_scan ON parser_config(enabled, last_scanned_at)`,
    `CREATE INDEX IF NOT EXISTS idx_parser_config_account ON parser_config(account_id)`,
    `CREATE INDEX IF NOT EXISTS idx_parser_config_process ON parser_config(enabled, last_processed_at)`,
    `CREATE TABLE IF NOT EXISTS parser_job (
        id INTEGER PRIMARY KEY AUTOINCREMENT, parser_id INTEGER NOT NULL REFERENCES parser_config(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
        account_id INTEGER NOT NULL, email_id INTEGER NOT NULL, version INTEGER NOT NULL,
        rules_json TEXT NOT NULL, input_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0,
        lease_token TEXT NOT NULL DEFAULT '', result_json TEXT, error TEXT NOT NULL DEFAULT '',
        webhook_url TEXT NOT NULL DEFAULT '', webhook_secret TEXT NOT NULL DEFAULT '',
        dispatch_status TEXT NOT NULL DEFAULT 'none', dispatch_attempts INTEGER NOT NULL DEFAULT 0,
        dispatch_available_at INTEGER NOT NULL DEFAULT 0, dispatch_lease_until INTEGER NOT NULL DEFAULT 0,
        dispatch_lease_token TEXT NOT NULL DEFAULT '', dispatch_error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, parsed_at INTEGER, sent_at INTEGER,
        UNIQUE(parser_id, email_id, version)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_parser_job_owner ON parser_job(user_id, parser_id, id)`,
    `CREATE INDEX IF NOT EXISTS idx_parser_job_export ON parser_job(user_id, parser_id, status, parsed_at, id)`,
    `CREATE INDEX IF NOT EXISTS idx_parser_job_parse ON parser_job(status, available_at, lease_until)`,
    `CREATE INDEX IF NOT EXISTS idx_parser_job_dispatch ON parser_job(dispatch_status, dispatch_available_at, dispatch_lease_until)`,
    `CREATE INDEX IF NOT EXISTS idx_parser_job_retention ON parser_job(status, updated_at)`,
    `CREATE TABLE IF NOT EXISTS parser_delivery (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL REFERENCES parser_job(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
        attempt INTEGER NOT NULL, status_code INTEGER, error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_parser_delivery_job ON parser_delivery(user_id, job_id, id)`
];

export async function initParserSchema(db) {
    await db.batch(parserSchema.filter(sql => sql.startsWith('CREATE TABLE')).map(sql => db.prepare(sql)));
    const { results } = await db.prepare('PRAGMA table_info(parser_config)').all();
    const additions = { retention_days: 'INTEGER NOT NULL DEFAULT 0', conditions_json: "TEXT NOT NULL DEFAULT '[]'", scan_email_id: 'INTEGER NOT NULL DEFAULT 0', last_processed_at: 'INTEGER NOT NULL DEFAULT 0' };
    for (const [name, definition] of Object.entries(additions)) {
        if (!results.some(column => column.name === name)) await db.prepare(`ALTER TABLE parser_config ADD COLUMN ${name} ${definition}`).run();
    }
    const { results: indexes } = await db.prepare('PRAGMA index_list(parser_config)').all();
    for (const index of indexes.filter(index => index.unique)) {
        const { results: columns } = await db.prepare(`PRAGMA index_info(${quote(index.name)})`).all();
        if (columns.length !== 2 || !columns.some(column => column.name === 'user_id') || !columns.some(column => column.name === 'account_id')) continue;
        const tableColumns = {};
        for (const table of ['parser_config', 'parser_job', 'parser_delivery']) {
            tableColumns[table] = (await db.prepare(`PRAGMA table_info(${table})`).all()).results.map(column => column.name);
        }
        await db.batch(multiParserMigrationSql(tableColumns).map(sql => db.prepare(sql)));
        break;
    }
    await db.batch(parserSchema.filter(sql => sql.startsWith('CREATE INDEX')).map(sql => db.prepare(sql)));
}

const quote = name => `"${name.replaceAll('"', '""')}"`;

// D1 keeps ON DELETE CASCADE active. Copy all three tables, then rebuild children
// before their parent in one transaction; never drop a referenced parent first.
export function multiParserMigrationSql(tableColumns) {
    const tables = ['parser_config', 'parser_job', 'parser_delivery'];
    const backup = table => `_parser_multi_${table}`;
    return [
        ...tables.map(table => `CREATE TABLE ${backup(table)} AS SELECT * FROM ${table}`),
        `CREATE TABLE _parser_multi_sequences AS SELECT name,seq FROM sqlite_sequence WHERE name IN ('parser_config','parser_job','parser_delivery')`,
        ...tables.toReversed().map(table => `DROP TABLE ${table}`),
        ...parserSchema.filter(sql => sql.startsWith('CREATE TABLE')),
        ...tables.map(table => {
            const columns = tableColumns[table].map(quote).join(',');
            return `INSERT INTO ${table} (${columns}) SELECT ${columns} FROM ${backup(table)}`;
        }),
        `UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT b.seq FROM _parser_multi_sequences b WHERE b.name=sqlite_sequence.name),0)) WHERE name IN ('parser_config','parser_job','parser_delivery')`,
        `INSERT INTO sqlite_sequence(name,seq) SELECT b.name,b.seq FROM _parser_multi_sequences b WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence s WHERE s.name=b.name)`,
        ...parserSchema.filter(sql => sql.startsWith('CREATE INDEX')),
        ...tables.map(table => `DROP TABLE ${backup(table)}`),
        'DROP TABLE _parser_multi_sequences'
    ];
}
