import BizError from '../error/biz-error';
import { validateRules, parseEmail, emailInput, checkSize } from '../lib/parser-engine';

const LEASE_MS = 60000;
const MAX_PARSE_ATTEMPTS = 3;
const MAX_DISPATCH_ATTEMPTS = 5;
const configFields = 'id, user_id, account_id, name, enabled, version, rules_json, webhook_url, webhook_secret, start_email_id, created_at, updated_at';

export function positiveId(value) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1) throw new BizError('Invalid identifier', 400);
    return id;
}

export function validateWebhook(value) {
    if (!value) return '';
    if (typeof value !== 'string' || value.length > 2048) throw new BizError('Invalid webhook URL', 400);
    let url;
    try { url = new URL(value); } catch { throw new BizError('Invalid webhook URL', 400); }
    const host = url.hostname;
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') ||
        !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') || host.includes('[') ||
        /\.(?:localhost|local|internal|test|invalid|example)$/.test(host) || host.endsWith('.')) {
        throw new BizError('Use an HTTPS webhook on a public domain with the default port', 400);
    }
    return url.toString();
}

function configView(row) {
    return { id: row.id, accountId: row.account_id, name: row.name, enabled: !!row.enabled, version: row.version,
        rules: JSON.parse(row.rules_json), webhookUrl: row.webhook_url, hasWebhookSecret: !!row.webhook_secret,
        createdAt: row.created_at, updatedAt: row.updated_at };
}

function jobView(row, detail = false) {
    const result = row.result_json ? JSON.parse(row.result_json) : null;
    return { id: row.id, parserId: row.parser_id, accountId: row.account_id, emailId: row.email_id, version: row.version,
        status: row.status, attempts: row.attempts, error: row.error, data: result?.data ?? null, errors: result?.errors ?? [],
        dispatchStatus: row.dispatch_status, dispatchAttempts: row.dispatch_attempts, dispatchError: row.dispatch_error,
        createdAt: row.created_at, parsedAt: row.parsed_at, sentAt: row.sent_at,
        ...(detail ? { rules: JSON.parse(row.rules_json), webhookUrl: row.webhook_url } : {}) };
}

async function ownConfig(db, id, userId) {
    const row = await db.prepare(`SELECT ${configFields} FROM parser_config WHERE id = ? AND user_id = ?`).bind(positiveId(id), userId).first();
    if (!row) throw new BizError('Parser configuration not found', 404);
    return row;
}

async function ownAccount(db, accountId, userId) {
    const row = await db.prepare('SELECT account_id, email FROM account WHERE account_id = ? AND user_id = ? AND is_del = 0').bind(positiveId(accountId), userId).first();
    if (!row) throw new BizError('Mailbox not found', 404);
    return row;
}

async function ownEmail(db, emailId, userId, accountId) {
    const row = await db.prepare(`SELECT * FROM email WHERE email_id = ? AND user_id = ? AND account_id = ? AND type = 0 AND status = 0 AND is_del = 0`)
        .bind(positiveId(emailId), userId, accountId).first();
    if (!row) throw new BizError('Received email not found', 404);
    return row;
}

function rowInput(row) {
    return emailInput({ subject: row.subject, text: row.text, content: row.content, sendEmail: row.send_email ?? row.sendEmail, toEmail: row.to_email ?? row.toEmail });
}

async function addJob(db, config, email) {
    const now = Date.now();
    let input = 'null';
    let error = '';
    try { input = JSON.stringify(rowInput(email)); } catch (reason) { error = reason.message; }
    const emailId = email.email_id ?? email.emailId;
    await db.prepare(`INSERT OR IGNORE INTO parser_job
        (parser_id,user_id,account_id,email_id,version,rules_json,input_json,status,error,available_at,webhook_url,webhook_secret,created_at,updated_at)
        SELECT id,user_id,account_id,?,version,rules_json,?,?,?, ?,webhook_url,webhook_secret,?,? FROM parser_config
        WHERE id = ? AND user_id = ? AND version = ? AND enabled = 1`)
        .bind(emailId, input, error ? 'failed' : 'pending', error, now, now, now, config.id, config.user_id, config.version).run();
    return db.prepare('SELECT * FROM parser_job WHERE parser_id = ? AND email_id = ? AND version = ?')
        .bind(config.id, emailId, config.version).first();
}

const parserService = {
    async accounts(db, userId) {
        const { results } = await db.prepare('SELECT account_id AS accountId, email, name FROM account WHERE user_id = ? AND is_del = 0 ORDER BY account_id DESC LIMIT 500').bind(userId).all();
        return results;
    },

    async configs(db, userId) {
        const { results } = await db.prepare(`SELECT ${configFields} FROM parser_config WHERE user_id = ? ORDER BY id DESC`).bind(userId).all();
        return results.map(configView);
    },

    async saveConfig(db, userId, params, id) {
        if (!params || typeof params !== 'object') throw new BizError('Invalid configuration', 400);
        const accountId = positiveId(params.accountId);
        await ownAccount(db, accountId, userId);
        if (typeof params.name !== 'string' || !params.name.trim() || params.name.length > 80) throw new BizError('Use a name of 1 to 80 characters', 400);
        if (typeof params.enabled !== 'boolean') throw new BizError('Enabled must be a boolean', 400);
        if (params.clearWebhookSecret !== undefined && typeof params.clearWebhookSecret !== 'boolean') throw new BizError('Clear credential must be a boolean', 400);
        let rules;
        try { rules = validateRules(params.rules); } catch (error) { throw new BizError(error.message, 400); }
        const url = validateWebhook(params.webhookUrl);
        if (params.webhookSecret !== undefined && (typeof params.webhookSecret !== 'string' || params.webhookSecret.length > 1024 || /[\r\n]/.test(params.webhookSecret))) {
            throw new BizError('Invalid webhook credential', 400);
        }
        const now = Date.now();
        if (id) {
            const old = await ownConfig(db, id, userId);
            if (old.account_id !== accountId) throw new BizError('The mailbox of an existing parser cannot be changed', 400);
            if (params.version !== old.version) throw new BizError('Configuration changed. Reload before saving.', 409);
            const secret = params.clearWebhookSecret ? '' : params.webhookSecret || old.webhook_secret;
            const row = await db.prepare(`UPDATE parser_config SET name=?,enabled=?,version=version+1,rules_json=?,webhook_url=?,webhook_secret=?,updated_at=?
                WHERE id=? AND user_id=? AND version=? RETURNING *`)
                .bind(params.name.trim(), Number(params.enabled), JSON.stringify(rules), url, secret, now, old.id, userId, old.version).first();
            if (!row) throw new BizError('Configuration changed. Reload before saving.', 409);
            return configView(row);
        }
        const row = await db.prepare(`INSERT INTO parser_config (user_id,account_id,name,enabled,rules_json,webhook_url,webhook_secret,start_email_id,created_at,updated_at)
            SELECT ?,?,?,?,?,?,?,COALESCE(MAX(email_id),0),?,? FROM email WHERE account_id = ?
            ON CONFLICT(user_id,account_id) DO NOTHING RETURNING *`)
            .bind(userId, accountId, params.name.trim(), Number(params.enabled), JSON.stringify(rules), url, params.webhookSecret || '', now, now, accountId).first();
        if (!row) throw new BizError('This mailbox already has a parser', 409);
        return configView(row);
    },

    async samples(db, userId, accountId) {
        await ownAccount(db, accountId, userId);
        const { results } = await db.prepare(`SELECT email_id AS emailId, subject, create_time AS createTime FROM email
            WHERE user_id=? AND account_id=? AND type=0 AND status=0 AND is_del=0 ORDER BY email_id DESC LIMIT 30`).bind(userId, Number(accountId)).all();
        return results;
    },

    async preview(db, userId, params) {
        await ownAccount(db, params.accountId, userId);
        const input = params.emailId ? rowInput(await ownEmail(db, params.emailId, userId, Number(params.accountId))) : emailInput(params.sample || {});
        try { return parseEmail(params.rules, input, true); } catch (error) { throw new BizError(error.message, 400); }
    },

    async enqueue(db, userId, parserId, emailId) {
        const config = await ownConfig(db, parserId, userId);
        await ownAccount(db, config.account_id, userId);
        if (!config.enabled) throw new BizError('Enable this parser before processing emails', 409);
        const row = await addJob(db, config, await ownEmail(db, emailId, userId, config.account_id));
        if (!row) throw new BizError('Configuration changed. Reload before processing.', 409);
        return jobView(row);
    },

    async receive(db, email) {
        if (!email.userId || !email.accountId) return;
        const config = await db.prepare('SELECT * FROM parser_config WHERE user_id=? AND account_id=? AND enabled=1').bind(email.userId, email.accountId).first();
        return config ? !!(await addJob(db, config, email)) : false;
    },

    async reconcile(db) {
        const { results: configs } = await db.prepare(`SELECT c.* FROM parser_config c JOIN account a ON a.account_id=c.account_id AND a.user_id=c.user_id AND a.is_del=0
            JOIN user u ON u.user_id=c.user_id AND u.status=0 AND u.is_del=0
            WHERE c.enabled=1 ORDER BY c.last_scanned_at,c.id LIMIT 10`).all();
        for (const config of configs) {
            const { results: emails } = await db.prepare(`SELECT e.* FROM email e WHERE e.user_id=? AND e.account_id=? AND e.email_id>?
                AND e.type=0 AND e.status=0 AND e.is_del=0 AND NOT EXISTS (SELECT 1 FROM parser_job j WHERE j.parser_id=? AND j.email_id=e.email_id)
                ORDER BY e.email_id LIMIT 10`).bind(config.user_id, config.account_id, config.start_email_id, config.id).all();
            for (const email of emails) await addJob(db, config, email);
            await db.prepare('UPDATE parser_config SET last_scanned_at=? WHERE id=?').bind(Date.now(), config.id).run();
        }
    },

    async jobs(db, userId, params) {
        const parserId = positiveId(params.parserId);
        await ownConfig(db, parserId, userId);
        const cursor = Number(params.cursor || 0);
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new BizError('Invalid cursor', 400);
        const size = params.size ? Math.min(50, positiveId(params.size)) : 20;
        const { results } = await db.prepare(`SELECT * FROM parser_job WHERE user_id=? AND parser_id=? AND (?=0 OR id<?) ORDER BY id DESC LIMIT ?`)
            .bind(userId, parserId, cursor, cursor, size + 1).all();
        const rows = results.slice(0, size);
        return { rows: rows.map(row => jobView(row)), hasMore: results.length > size, nextCursor: rows.at(-1)?.id || 0 };
    },

    async job(db, userId, id) {
        const row = await db.prepare('SELECT * FROM parser_job WHERE id=? AND user_id=?').bind(positiveId(id), userId).first();
        if (!row) throw new BizError('Parser job not found', 404);
        const { results } = await db.prepare('SELECT attempt,status_code AS statusCode,error,created_at AS createdAt FROM parser_delivery WHERE job_id=? AND user_id=? ORDER BY id DESC LIMIT 50').bind(row.id, userId).all();
        return { ...jobView(row, true), deliveries: results };
    },

    async retry(db, userId, id, kind) {
        const row = await db.prepare('SELECT * FROM parser_job WHERE id=? AND user_id=?').bind(positiveId(id), userId).first();
        if (!row) throw new BizError('Parser job not found', 404);
        const config = await ownConfig(db, row.parser_id, userId);
        await ownAccount(db, row.account_id, userId);
        if (!config.enabled) throw new BizError('Enable this parser before retrying', 409);
        const now = Date.now();
        let updated;
        if (kind === 'parse') {
            // A delivered result is immutable. New rules produce a new version/job.
            updated = await db.prepare(`UPDATE parser_job SET status='pending',attempts=0,available_at=?,lease_token='',lease_until=0,error='',updated_at=?
                WHERE id=? AND user_id=? AND status='failed' RETURNING id`).bind(now, now, row.id, userId).first();
        } else if (kind === 'dispatch') {
            updated = await db.prepare(`UPDATE parser_job SET dispatch_status='pending',dispatch_attempts=0,dispatch_available_at=?,dispatch_lease_token='',dispatch_lease_until=0,dispatch_error='',updated_at=?
                WHERE id=? AND user_id=? AND status='parsed' AND dispatch_status='failed' RETURNING id`).bind(now, now, row.id, userId).first();
        } else throw new BizError('Invalid retry kind', 400);
        if (!updated) throw new BizError('Only failed jobs can be retried', 409);
    },

    async exportRows(db, userId, params) {
        const parserId = positiveId(params.parserId);
        await ownConfig(db, parserId, userId);
        const cursor = String(params.cursor || '0_0');
        if (!/^\d{1,16}_\d{1,16}$/.test(cursor)) throw new BizError('Invalid export cursor', 400);
        const [time, id] = cursor.split('_').map(Number);
        if (!Number.isSafeInteger(time) || !Number.isSafeInteger(id)) throw new BizError('Invalid export cursor', 400);
        const { results } = await db.prepare(`SELECT * FROM parser_job WHERE user_id=? AND parser_id=? AND status='parsed'
            AND (parsed_at>? OR (parsed_at=? AND id>?)) ORDER BY parsed_at,id LIMIT 101`).bind(userId, parserId, time, time, id).all();
        const rows = results.slice(0, 100);
        const last = rows.at(-1);
        return { rows: rows.map(row => ({ id: row.id, emailId: row.email_id, version: row.version, parsedAt: row.parsed_at, data: JSON.parse(row.result_json).data })),
            hasMore: results.length > 100, nextCursor: last ? `${last.parsed_at}_${last.id}` : cursor };
    },

    async process(db, { userId = 0, fetcher = fetch } = {}) {
        // Expired leases are reclaimed, with a bounded number of attempts.
        const now = Date.now();
        await db.prepare(`UPDATE parser_job SET status='failed',error='Worker interrupted too many times',lease_token='',updated_at=?
            WHERE status='processing' AND lease_until<=? AND attempts>=?`).bind(now, now, MAX_PARSE_ATTEMPTS).run();
        await db.prepare(`UPDATE parser_job SET dispatch_status='failed',dispatch_error='Delivery interrupted too many times',dispatch_lease_token='',updated_at=?
            WHERE dispatch_status='sending' AND dispatch_lease_until<=? AND dispatch_attempts>=?`).bind(now, now, MAX_DISPATCH_ATTEMPTS).run();
        for (let index = 0; index < 5; index++) {
            const time = Date.now();
            const token = crypto.randomUUID();
            const job = await db.prepare(`UPDATE parser_job SET status='processing',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=? WHERE id=(
                SELECT j.id FROM parser_job j JOIN parser_config c ON c.id=j.parser_id AND c.user_id=j.user_id AND c.enabled=1
                JOIN account a ON a.account_id=j.account_id AND a.user_id=j.user_id AND a.is_del=0
                JOIN user u ON u.user_id=j.user_id AND u.status=0 AND u.is_del=0
                WHERE (?=0 OR j.user_id=?) AND j.attempts<? AND ((j.status='pending' AND j.available_at<=?) OR (j.status='processing' AND j.lease_until<=?))
                ORDER BY j.id LIMIT 1) RETURNING *`).bind(token, time + LEASE_MS, time, userId, userId, MAX_PARSE_ATTEMPTS, time, time).first();
            if (!job) break;
            let result;
            let error = '';
            try {
                if (job.input_json === 'null') throw new Error('Source snapshot unavailable; submit another email');
                result = parseEmail(JSON.parse(job.rules_json), JSON.parse(job.input_json));
                if (result.errors.length) error = 'One or more fields failed validation';
            } catch (reason) { error = reason.message; }
            const finished = Date.now();
            await db.prepare(`UPDATE parser_job SET status=?,result_json=?,error=?,parsed_at=?,dispatch_status=?,dispatch_available_at=?,lease_token='',lease_until=0,updated_at=?
                WHERE id=? AND lease_token=? AND status='processing'`)
                .bind(error ? 'failed' : 'parsed', result ? JSON.stringify(result) : null, error, error ? null : finished,
                    !error && job.webhook_url ? 'pending' : 'none', finished, finished, job.id, token).run();
        }
        for (let index = 0; index < 2; index++) {
            const time = Date.now();
            const token = crypto.randomUUID();
            const job = await db.prepare(`UPDATE parser_job SET dispatch_status='sending',dispatch_attempts=dispatch_attempts+1,dispatch_lease_token=?,dispatch_lease_until=?,updated_at=? WHERE id=(
                SELECT j.id FROM parser_job j JOIN parser_config c ON c.id=j.parser_id AND c.user_id=j.user_id AND c.enabled=1
                JOIN account a ON a.account_id=j.account_id AND a.user_id=j.user_id AND a.is_del=0
                JOIN user u ON u.user_id=j.user_id AND u.status=0 AND u.is_del=0
                WHERE (?=0 OR j.user_id=?) AND j.status='parsed' AND j.dispatch_attempts<?
                AND ((j.dispatch_status='pending' AND j.dispatch_available_at<=?) OR (j.dispatch_status='sending' AND j.dispatch_lease_until<=?)) ORDER BY j.id LIMIT 1) RETURNING *`)
                .bind(token, time + LEASE_MS, time, userId, userId, MAX_DISPATCH_ATTEMPTS, time, time).first();
            if (!job) break;
            let statusCode = null;
            let error = '';
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 10000);
            try {
                const url = validateWebhook(job.webhook_url);
                const body = JSON.stringify({ id: `parser-job-${job.id}`, emailId: job.email_id, parserId: job.parser_id,
                    version: job.version, data: JSON.parse(job.result_json).data });
                checkSize(body);
                const response = await fetcher(url, { method: 'POST', redirect: 'manual', signal: controller.signal,
                    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `parser-job-${job.id}`,
                        ...(job.webhook_secret ? { Authorization: job.webhook_secret } : {}) }, body });
                statusCode = response.status;
                if (!response.ok) error = `HTTP ${response.status}`;
                await response.body?.cancel();
            } catch { error = controller.signal.aborted ? 'Webhook timed out' : 'Webhook request failed'; }
            finally { clearTimeout(timer); }
            const finished = Date.now();
            const nextStatus = !error ? 'sent' : job.dispatch_attempts >= MAX_DISPATCH_ATTEMPTS ? 'failed' : 'pending';
            await db.batch([
                db.prepare(`INSERT INTO parser_delivery(job_id,user_id,attempt,status_code,error,created_at)
                    SELECT id,user_id,dispatch_attempts,?,?,? FROM parser_job WHERE id=? AND dispatch_lease_token=? AND dispatch_status='sending'`)
                    .bind(statusCode, error, finished, job.id, token),
                db.prepare(`UPDATE parser_job SET dispatch_status=?,dispatch_error=?,dispatch_available_at=?,dispatch_lease_token='',dispatch_lease_until=0,sent_at=?,updated_at=?
                    WHERE id=? AND dispatch_lease_token=? AND dispatch_status='sending'`)
                    .bind(nextStatus, error, finished + 60000 * 2 ** (job.dispatch_attempts - 1), !error ? finished : null, finished, job.id, token)
            ]);
        }
    }
};

export default parserService;
