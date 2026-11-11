import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src';
import parserService, { validateWebhook } from '../src/service/parser-service';
import { initParserSchema, multiParserMigrationSql } from '../src/init/parser-schema';
import jwtUtils from '../src/utils/jwt-utils';
import { email as receiveEmail } from '../src/email/email';

const rules = [{ key: 'order_id', source: 'text', required: true,
    filters: [{ type: 'regex', pattern: '订单号: ([A-Z0-9-]+)', group: 1 }] }];
const configuration = (overrides = {}) => ({ accountId: 1, name: '订单', enabled: true, rules, webhookUrl: '', ...overrides });

beforeEach(async () => {
    await env.db.exec(`CREATE TABLE account (account_id INTEGER PRIMARY KEY, email TEXT, name TEXT DEFAULT '', user_id INTEGER, status INTEGER DEFAULT 0, latest_email_time TEXT, create_time TEXT, all_receive INTEGER DEFAULT 0, sort INTEGER DEFAULT 0, is_del INTEGER DEFAULT 0);
        CREATE TABLE email (email_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, account_id INTEGER, send_email TEXT, name TEXT, sender_email TEXT DEFAULT '', subject TEXT, text TEXT, content TEXT, cc TEXT DEFAULT '[]', bcc TEXT DEFAULT '[]', recipient TEXT, to_email TEXT, to_name TEXT DEFAULT '', in_reply_to TEXT DEFAULT '', relation TEXT DEFAULT '', message_id TEXT DEFAULT '', type INTEGER DEFAULT 0, status INTEGER DEFAULT 0, resend_email_id TEXT, message TEXT, unread INTEGER DEFAULT 0, create_time TEXT DEFAULT CURRENT_TIMESTAMP, is_del INTEGER DEFAULT 0);
        CREATE TABLE user (user_id INTEGER PRIMARY KEY, email TEXT, type INTEGER DEFAULT 1, password TEXT DEFAULT '', salt TEXT DEFAULT '', status INTEGER DEFAULT 0, create_time TEXT, active_time TEXT, create_ip TEXT, active_ip TEXT, os TEXT, browser TEXT, device TEXT, sort TEXT DEFAULT '0', send_count TEXT DEFAULT '0', reg_key_id INTEGER DEFAULT 0, is_del INTEGER DEFAULT 0);
        INSERT INTO account(account_id,user_id,email) VALUES (1,1,'orders@example.test'),(2,2,'other@example.test');
        INSERT INTO user(user_id,email) VALUES (1,'admin@example.test'),(2,'other@example.test');
        INSERT INTO email(email_id,user_id,account_id,subject,text,send_email,to_email) VALUES (1,1,1,'订单 A','订单号: A-100','shop@example.test','orders@example.test'),(2,1,1,'订单 B','订单号: B-200','shop@example.test','orders@example.test'),(3,2,2,'其他订单','订单号: C-300','shop@example.test','other@example.test');`);
    await env.db.exec("ALTER TABLE email ADD COLUMN code TEXT NOT NULL DEFAULT '';");
    await env.db.exec(`CREATE TABLE attachments (att_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, email_id INTEGER NOT NULL, account_id INTEGER NOT NULL, key TEXT NOT NULL, filename TEXT, mime_type TEXT, size INTEGER, status TEXT NOT NULL DEFAULT 0, type INTEGER NOT NULL DEFAULT 0, content_id TEXT, disposition TEXT, related TEXT, encoding TEXT, create_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
    await initParserSchema(env.db);
});

async function api(path, { method = 'GET', body, userId = 1, raw = false } = {}) {
    const ctx = createExecutionContext();
    const headers = { 'Content-Type': 'application/json' };
    if (userId) {
        const token = `test-session-${userId}`;
        headers.Authorization = await jwtUtils.generateToken({ env }, { userId, token }, 3600);
        await env.kv.put(`auth-uid:${userId}`, JSON.stringify({ tokens: [token], user: { userId, email: `${userId}@example.test` }, refreshTime: new Date().toISOString() }));
    }
    const response = await worker.fetch(new Request(`https://local.test/api${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }), env, ctx);
    await waitOnExecutionContext(ctx);
    return raw ? response : response.json();
}

describe('parser on local Workers D1 and existing authentication', () => {
    it('runs the additive migration repeatedly without losing existing data', async () => {
        await initParserSchema(env.db);
        expect((await env.db.prepare('SELECT COUNT(*) AS total FROM email').first()).total).toBe(3);
    });

    it('requires a valid authenticated session', async () => {
        expect((await api('/parser/configs', { userId: 0 })).code).toBe(401);
    });

    it('isolates configuration, samples, preview, jobs, retries and exports between users', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration());
        const job = await parserService.enqueue(env.db, 1, config.id, 1);
        expect((await api('/parser/configs', { userId: 2 })).data).toEqual([]);
        for (const path of [`/parser/samples?accountId=1`, `/parser/jobs?parserId=${config.id}`, `/parser/jobs/${job.id}`, `/parser/export?parserId=${config.id}`]) {
            expect((await api(path, { userId: 2 })).code).toBe(404);
        }
        expect((await api('/parser/preview', { method: 'POST', userId: 2, body: { accountId: 1, emailId: 1, rules } })).code).toBe(404);
        expect((await api(`/parser/jobs/${job.id}/retry`, { method: 'POST', userId: 2, body: { kind: 'parse' } })).code).toBe(404);
        expect((await api(`/parser/configs/${config.id}`, { method: 'PUT', userId: 2, body: configuration({ accountId: 2, version: 1 }) })).code).toBe(404);
    });

    it('creates a config, previews, processes a sample and exports through the HTTP API', async () => {
        const config = (await api('/parser/configs', { method: 'POST', body: configuration() })).data;
        const preview = await api('/parser/preview', { method: 'POST', body: { accountId: 1, emailId: 1, rules } });
        expect(preview.data.data.order_id).toBe('A-100');
        const submitted = await api('/parser/enqueue', { method: 'POST', body: { parserId: config.id, emailId: 1 } });
        const job = (await api(`/parser/jobs/${submitted.data.id}`)).data;
        expect(job.status).toBe('parsed');
        expect(job.data.order_id).toBe('A-100');
        expect((await api(`/parser/export?parserId=${config.id}`)).data.rows[0].data.order_id).toBe('A-100');
    });

    it('does not echo webhook credentials and prevents stale configuration saves', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration({ webhookSecret: 'Bearer private' }));
        expect(JSON.stringify(await parserService.configs(env.db, 1))).not.toContain('Bearer private');
        const updated = await parserService.saveConfig(env.db, 1, configuration({ version: config.version }), config.id);
        expect(updated.version).toBe(2);
        expect(updated.hasWebhookSecret).toBe(true);
        await expect(parserService.saveConfig(env.db, 1, configuration({ version: 1 }), config.id)).rejects.toMatchObject({ code: 409 });
    });

    it('deduplicates submissions while retaining separate rule versions and immutable inputs', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration());
        const [first, second] = await Promise.all([parserService.enqueue(env.db, 1, config.id, 1), parserService.enqueue(env.db, 1, config.id, 1)]);
        expect(first.id).toBe(second.id);
        await env.db.prepare("UPDATE email SET text='changed' WHERE email_id=1").run();
        await parserService.process(env.db);
        expect((await parserService.job(env.db, 1, first.id)).data.order_id).toBe('A-100');
        await parserService.saveConfig(env.db, 1, configuration({ version: config.version }), config.id);
        const next = await parserService.enqueue(env.db, 1, config.id, 1);
        expect(next.id).not.toBe(first.id);
        expect(next.version).toBe(2);
    });

    it('repairs missed receipt registration but leaves pre-configuration emails alone', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration());
        await env.db.prepare("INSERT INTO email(user_id,account_id,text) VALUES (1,1,'订单号: D-400')").run();
        await parserService.reconcile(env.db);
        await parserService.reconcile(env.db);
        const { rows } = await parserService.jobs(env.db, 1, { parserId: config.id });
        expect(rows).toHaveLength(1);
        await parserService.process(env.db);
        expect((await parserService.job(env.db, 1, rows[0].id)).data.order_id).toBe('D-400');
    });

    it('does not parse or dispatch paused configurations', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration());
        const job = await parserService.enqueue(env.db, 1, config.id, 1);
        await parserService.saveConfig(env.db, 1, configuration({ version: 1, enabled: false }), config.id);
        await parserService.process(env.db);
        expect((await parserService.job(env.db, 1, job.id)).status).toBe('pending');
        await expect(parserService.enqueue(env.db, 1, config.id, 2)).rejects.toMatchObject({ code: 409 });
    });

    it('recovers an expired parsing lease and fences out stale workers', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration());
        const job = await parserService.enqueue(env.db, 1, config.id, 1);
        await env.db.prepare("UPDATE parser_job SET status='processing',attempts=1,lease_until=0,lease_token='old' WHERE id=?").bind(job.id).run();
        await parserService.process(env.db);
        const stale = await env.db.prepare("UPDATE parser_job SET error='stale' WHERE id=? AND lease_token='old' AND status='processing'").bind(job.id).run();
        expect(stale.meta.changes).toBe(0);
        expect((await parserService.job(env.db, 1, job.id)).status).toBe('parsed');
    });

    it('records deterministic validation failures for manual correction', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration({ rules: [{ key: 'missing', source: 'subject', required: true, filters: [{ type: 'regex', pattern: 'not present' }] }] }));
        const job = await parserService.enqueue(env.db, 1, config.id, 1);
        await parserService.process(env.db);
        const failed = await parserService.job(env.db, 1, job.id);
        expect(failed.status).toBe('failed');
        expect(failed.errors[0].field).toBe('missing');
        expect(failed.dispatchStatus).toBe('none');
    });

    it('uses durable backoff and delivers once despite concurrent workers', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration({ webhookUrl: 'https://hooks.example.com/orders', webhookSecret: 'Bearer private' }));
        const job = await parserService.enqueue(env.db, 1, config.id, 1);
        const failing = vi.fn(async () => new Response('do not log this', { status: 503 }));
        await parserService.process(env.db, { fetcher: failing });
        await parserService.process(env.db, { fetcher: failing });
        expect(failing).toHaveBeenCalledTimes(1);
        expect((await parserService.job(env.db, 1, job.id)).dispatchStatus).toBe('pending');
        await env.db.prepare('UPDATE parser_job SET dispatch_available_at=0 WHERE id=?').bind(job.id).run();
        const success = vi.fn(async () => new Response(null, { status: 204 }));
        await Promise.all([parserService.process(env.db, { fetcher: success }), parserService.process(env.db, { fetcher: success })]);
        expect(success).toHaveBeenCalledTimes(1);
        expect(success.mock.calls[0][1].headers['Idempotency-Key']).toBe(`parser-job-${job.id}`);
        const delivered = await parserService.job(env.db, 1, job.id);
        expect(delivered.dispatchStatus).toBe('sent');
        expect(delivered.deliveries).toHaveLength(2);
        expect(JSON.stringify(delivered)).not.toContain('do not log this');
        expect(JSON.stringify(delivered)).not.toContain('Bearer private');
    });

    it('stops after the delivery retry budget and supports an explicit retry', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration({ webhookUrl: 'https://hooks.example.com/orders' }));
        const job = await parserService.enqueue(env.db, 1, config.id, 1);
        for (let index = 0; index < 5; index++) {
            await env.db.prepare('UPDATE parser_job SET dispatch_available_at=0 WHERE id=?').bind(job.id).run();
            await parserService.process(env.db, { fetcher: async () => new Response(null, { status: 500 }) });
        }
        expect((await parserService.job(env.db, 1, job.id)).dispatchStatus).toBe('failed');
        await parserService.retry(env.db, 1, job.id, 'dispatch');
        await parserService.process(env.db, { fetcher: async () => new Response(null, { status: 204 }) });
        expect((await parserService.job(env.db, 1, job.id)).dispatchStatus).toBe('sent');
    });

    it('records oversized email snapshots as visible failures', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration());
        await env.db.prepare('UPDATE email SET text=? WHERE email_id=1').bind('中'.repeat(50000)).run();
        const job = await parserService.enqueue(env.db, 1, config.id, 1);
        expect(job.status).toBe('failed');
        await parserService.retry(env.db, 1, job.id, 'parse');
        await parserService.process(env.db);
        expect((await parserService.job(env.db, 1, job.id)).status).toBe('failed');
    });

    it('repairs missed jobs through the actual scheduled entry point', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration());
        await env.db.prepare("INSERT INTO email(user_id,account_id,text) VALUES(1,1,'订单号: F-600')").run();
        await worker.scheduled({ cron: '* * * * *' }, env, createExecutionContext());
        const jobs = await parserService.jobs(env.db, 1, { parserId: config.id });
        expect(jobs.rows[0].status).toBe('parsed');
        expect(jobs.rows[0].data.order_id).toBe('F-600');
    });

    it('reclaims expired delivery leases using the same idempotency key', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration({ webhookUrl: 'https://hooks.example.com/orders' }));
        const job = await parserService.enqueue(env.db, 1, config.id, 1);
        await parserService.process(env.db, { fetcher: async () => new Response(null, { status: 503 }) });
        await env.db.prepare("UPDATE parser_job SET dispatch_status='sending',dispatch_lease_until=0,dispatch_lease_token='interrupted' WHERE id=?").bind(job.id).run();
        const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
        await parserService.process(env.db, { fetcher });
        expect(fetcher.mock.calls[0][1].headers['Idempotency-Key']).toBe(`parser-job-${job.id}`);
        expect((await parserService.job(env.db, 1, job.id)).dispatchStatus).toBe('sent');
    });

    it('refuses redirects rather than forwarding credentials to another endpoint', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration({ webhookUrl: 'https://hooks.example.com/orders', webhookSecret: 'private' }));
        const job = await parserService.enqueue(env.db, 1, config.id, 1);
        const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://another.example.com' } }));
        await parserService.process(env.db, { fetcher });
        expect(fetcher.mock.calls[0][1].redirect).toBe('manual');
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect((await parserService.job(env.db, 1, job.id)).dispatchError).toBe('HTTP 302');
    });

    it('paginates exports by completion order, including older jobs completed later', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration());
        const older = await parserService.enqueue(env.db, 1, config.id, 1);
        await env.db.batch(Array.from({ length: 101 }, (_, index) => env.db.prepare(`INSERT INTO parser_job
            (parser_id,user_id,account_id,email_id,version,rules_json,input_json,status,available_at,result_json,parsed_at,created_at,updated_at)
            VALUES (?,1,1,?,1,'[]','{}','parsed',0,?,1000,0,0)`).bind(config.id, index + 100, JSON.stringify({ data: { order_id: `N-${index}` }, errors: [] }))));
        const first = await parserService.exportRows(env.db, 1, { parserId: config.id });
        expect(first.rows).toHaveLength(100);
        expect(first.hasMore).toBe(true);
        const second = await parserService.exportRows(env.db, 1, { parserId: config.id, cursor: first.nextCursor });
        expect(second.rows).toHaveLength(1);
        await parserService.process(env.db);
        const late = await parserService.exportRows(env.db, 1, { parserId: config.id, cursor: second.nextCursor });
        expect(late.rows[0].id).toBe(older.id);
    });

    it('rejects invalid configuration and request bodies without creating data', async () => {
        expect((await api('/parser/configs', { method: 'POST', body: configuration({ accountId: 2 }) })).code).toBe(404);
        expect((await api('/parser/configs', { method: 'POST', body: configuration({ rules: [] }) })).code).toBe(400);
        expect((await api('/parser/preview', { method: 'POST', body: [] })).code).toBe(400);
        expect(await parserService.configs(env.db, 1)).toEqual([]);
    });

    it('cascades mailbox deletion to configuration, snapshots and delivery history only for its owner', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration({ webhookUrl: 'https://hooks.example.com/orders' }));
        await parserService.saveConfig(env.db, 2, configuration({ accountId: 2 }));
        await parserService.enqueue(env.db, 1, config.id, 1);
        await parserService.process(env.db, { fetcher: async () => new Response(null, { status: 204 }) });
        expect((await env.db.prepare('SELECT COUNT(*) AS total FROM parser_delivery').first()).total).toBe(1);
        await env.db.prepare('DELETE FROM account WHERE account_id=1').run();
        expect((await env.db.prepare('SELECT COUNT(*) AS total FROM parser_job').first()).total).toBe(0);
        expect((await env.db.prepare('SELECT COUNT(*) AS total FROM parser_delivery').first()).total).toBe(0);
        expect(await parserService.configs(env.db, 1)).toEqual([]);
        expect(await parserService.configs(env.db, 2)).toHaveLength(1);
    });

    it('pauses banned users and cascades permanent user deletion', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration());
        const job = await parserService.enqueue(env.db, 1, config.id, 1);
        await env.db.prepare('UPDATE user SET status=1 WHERE user_id=1').run();
        await parserService.process(env.db);
        expect((await parserService.job(env.db, 1, job.id)).status).toBe('pending');
        await env.db.prepare('DELETE FROM user WHERE user_id=1').run();
        expect((await env.db.prepare('SELECT COUNT(*) AS total FROM parser_job').first()).total).toBe(0);
        expect(await parserService.configs(env.db, 1)).toEqual([]);
    });

    it('enqueues and parses through the real MIME receipt handler', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration());
        await env.kv.put('setting:', JSON.stringify({ receive: 0, emailPrefixFilter: '', noRecipient: 1, aiCode: 1, tgBotStatus: 1, forwardStatus: 1, webhookStatus: 1 }));
        const ctx = createExecutionContext();
        const raw = 'From: Shop <shop@example.test>\r\nTo: orders@example.test\r\nSubject: New order\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n订单号: E-500';
        const reject = vi.fn();
        const bytes = new TextEncoder().encode(raw);
        const split = bytes.indexOf(0xe8) + 1; // Split inside a Chinese UTF-8 character.
        const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)); controller.close(); } });
        await receiveEmail({ from: 'shop@example.test', to: 'orders@example.test', raw: stream, setReject: reject }, env, ctx);
        await waitOnExecutionContext(ctx);
        expect(reject).not.toHaveBeenCalled();
        const jobs = await parserService.jobs(env.db, 1, { parserId: config.id });
        expect(jobs.rows[0].status).toBe('parsed');
        expect(jobs.rows[0].data.order_id).toBe('E-500');
    });
});

const csvRules = [{ key: 'items', source: 'csvAttachment', required: true,
    options: { attachmentName: 'orders.csv', delimiter: ',', hasHeader: true }, filters: [{ type: 'tableTrim' }] }];
async function csvFile({ userId = 1, emailId = 1, accountId = 1, name = 'orders.csv', text = 'item,qty\n苹果,2', bytes, size } = {}) {
    await env.kv.put('setting:', JSON.stringify({ emailPrefixFilter: '', resendTokens: {} }));
    const key = `attachments/parser-${crypto.randomUUID()}.csv`;
    const data = bytes || new TextEncoder().encode(text);
    await env.kv.put(key, data);
    await env.db.prepare('INSERT INTO attachments(user_id,email_id,account_id,key,filename,size) VALUES(?,?,?,?,?,?)')
        .bind(userId, emailId, accountId, key, name, size ?? data.byteLength).run();
    return key;
}

describe('CSV ownership, immutable snapshots and structured exports', () => {
    it('previews owned stored attachments through HTTP and snapshots them before processing', async () => {
        const key = await csvFile();
        const config = await parserService.saveConfig(env.db, 1, configuration({ rules: csvRules }));
        const payload = { accountId: 1, emailId: 1, rules: csvRules };
        expect((await api('/parser/preview', { method: 'POST', body: payload })).data.data.items).toEqual([{ item: '苹果', qty: '2' }]);
        expect((await parserService.samples(env.db, 1, 1))[1].attachmentNames).toEqual(['orders.csv']);
        const job = await parserService.enqueue(env.db, 1, config.id, 1, { env });
        await env.kv.delete(key);
        await parserService.process(env.db);
        expect((await parserService.job(env.db, 1, job.id)).data.items).toEqual([{ item: '苹果', qty: '2' }]);
        expect((await parserService.enqueue(env.db, 1, config.id, 1, { env })).id).toBe(job.id);
        const csv = await api(`/parser/export?parserId=${config.id}&format=csv&tableField=items`, { raw: true });
        expect(csv.headers.get('Content-Type')).toContain('text/csv');
        expect(await csv.text()).toContain('"苹果","2"');
        expect((await api(`/parser/export?parserId=${config.id}`)).data.rows[0].data.items).toHaveLength(1);
    });
    it('does not read another owner file or honor injected attachments on an owned email preview', async () => {
        await csvFile({ userId: 2, emailId: 1, accountId: 1 });
        const preview = await api('/parser/preview', { method: 'POST', body: { accountId: 1, emailId: 1, rules: csvRules,
            sample: { attachments: [{ name: 'orders.csv', text: 'item\nforged' }] } } });
        expect(preview.data.data.items).toBeNull();
        expect(preview.data.errors[0].message).toContain('empty');
        expect((await api('/parser/preview', { method: 'POST', userId: 2, body: { accountId: 2, emailId: 1, rules: csvRules } })).code).toBe(404);
    });
    it('leaves transient storage errors eligible for reconciliation instead of persisting a broken snapshot', async () => {
        const key = await csvFile();
        const config = await parserService.saveConfig(env.db, 1, configuration({ rules: csvRules }));
        await env.kv.delete(key);
        await expect(parserService.enqueue(env.db, 1, config.id, 1, { env })).rejects.toMatchObject({ code: 503 });
        expect((await parserService.jobs(env.db, 1, { parserId: config.id })).rows).toHaveLength(0);
        await env.kv.put(key, 'item,qty\nRestored,1');
        expect((await parserService.enqueue(env.db, 1, config.id, 1, { env })).status).toBe('pending');
    });
    it('rejects duplicate filenames, non UTF-8 content and oversized files, including inaccurate metadata', async () => {
        await csvFile(); await csvFile();
        await expect(parserService.preview(env.db, 1, { accountId: 1, emailId: 1, rules: csvRules }, { env })).rejects.toThrow(/ambiguous/);
        await env.db.prepare('DELETE FROM attachments').run();
        await csvFile({ bytes: new Uint8Array([0xff, 0xfe, 0x00]) });
        await expect(parserService.preview(env.db, 1, { accountId: 1, emailId: 1, rules: csvRules }, { env })).rejects.toThrow(/UTF-8/);
        await env.db.prepare('DELETE FROM attachments').run();
        await csvFile({ text: 'x'.repeat(65537), size: 1 });
        await expect(parserService.preview(env.db, 1, { accountId: 1, emailId: 1, rules: csvRules }, { env })).rejects.toThrow(/64 KiB/);
    });
    it('parses a real multipart MIME CSV attachment at receipt without waiting for a storage read', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration({ rules: csvRules }));
        await env.kv.put('setting:', JSON.stringify({ receive: 0, emailPrefixFilter: '', noRecipient: 1, aiCode: 1, tgBotStatus: 1, forwardStatus: 1, webhookStatus: 1 }));
        const raw = ['From: Shop <shop@example.test>', 'To: orders@example.test', 'Subject: CSV order',
            'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="parser-test"', '',
            '--parser-test', 'Content-Type: text/plain; charset=utf-8', '', 'Order attached',
            '--parser-test', 'Content-Type: text/csv; charset=utf-8', 'Content-Disposition: attachment; filename="orders.csv"',
            'Content-Transfer-Encoding: base64', '', btoa('item,qty\r\nWidget,2\r\n'), '--parser-test--', ''].join('\r\n');
        const ctx = createExecutionContext();
        const reject = vi.fn();
        await receiveEmail({ from: 'shop@example.test', to: 'orders@example.test', raw: new Response(raw).body, setReject: reject }, env, ctx);
        await waitOnExecutionContext(ctx);
        expect(reject).not.toHaveBeenCalled();
        const job = (await parserService.jobs(env.db, 1, { parserId: config.id })).rows[0];
        expect(job.status).toBe('parsed');
        expect(job.data.items).toEqual([{ item: 'Widget', qty: '2' }]);
        expect((await parserService.samples(env.db, 1, 1))[0].attachmentNames).toEqual(['orders.csv']);
    });
    it('paginates table exports in ten-email batches and filters versions without that table', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration({ rules: csvRules }));
        await env.db.batch(Array.from({ length: 12 }, (_, index) => env.db.prepare(`INSERT INTO parser_job
            (parser_id,user_id,account_id,email_id,version,rules_json,input_json,status,available_at,result_json,parsed_at,created_at,updated_at)
            VALUES (?,1,1,?,1,'[]','{}','parsed',0,?,1000,0,0)`).bind(config.id, index + 100, JSON.stringify({ data: index === 11 ? { legacy: 'yes' } : { items: [{ item: `N-${index}` }] }, errors: [] }))));
        const first = await parserService.exportRows(env.db, 1, { parserId: config.id, tableField: 'items' });
        expect(first.rows).toHaveLength(10); expect(first.hasMore).toBe(true);
        const second = await parserService.exportRows(env.db, 1, { parserId: config.id, tableField: 'items', cursor: first.nextCursor });
        expect(second.rows).toHaveLength(1); expect(second.hasMore).toBe(false);
        const small = await parserService.exportRows(env.db, 1, { parserId: config.id, tableField: 'items', size: '1' });
        expect(small.rows).toHaveLength(1); expect(small.hasMore).toBe(true);
        expect((await api(`/parser/export?parserId=${config.id}&size=0`)).code).toBe(400);
        expect((await api(`/parser/export?parserId=${config.id}&tableField=items.bad`)).code).toBe(400);
    });
});

describe('retention migration and terminal job cleanup', () => {
    it('upgrades a legacy configuration without enabling destructive cleanup or changing rules', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration());
        await env.db.prepare('ALTER TABLE parser_config DROP COLUMN retention_days').run();
        await initParserSchema(env.db); await initParserSchema(env.db);
        const saved = (await parserService.configs(env.db, 1))[0];
        expect(saved.retentionDays).toBe(0); expect(saved.rules).toEqual(config.rules); expect(saved.version).toBe(1);
    });
    it('validates retention and preserves it for older API clients', async () => {
        for (const retentionDays of [-1, 61, 1.5, '30']) {
            await expect(parserService.saveConfig(env.db, 1, configuration({ retentionDays }))).rejects.toMatchObject({ code: 400 });
        }
        const config = await parserService.saveConfig(env.db, 1, configuration({ retentionDays: 30 }));
        const updated = await parserService.saveConfig(env.db, 1, configuration({ version: 1 }), config.id);
        expect(updated.retentionDays).toBe(30);
    });
    it('scrubs terminal content and credentials, retaining deduplication even after reconciliation', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration({ retentionDays: 1, webhookUrl: 'https://hooks.example.com/orders', webhookSecret: 'Bearer old-secret' }));
        const email = await env.db.prepare("INSERT INTO email(user_id,account_id,text) VALUES(1,1,'订单号: OLD-1') RETURNING email_id").first();
        const job = await parserService.enqueue(env.db, 1, config.id, email.email_id);
        await parserService.process(env.db, { fetcher: async () => new Response(null, { status: 204 }) });
        await env.db.prepare('UPDATE parser_job SET updated_at=0 WHERE id=?').bind(job.id).run();
        await worker.scheduled({ cron: '* * * * *' }, env, createExecutionContext());
        const cleared = await env.db.prepare('SELECT * FROM parser_job WHERE id=?').bind(job.id).first();
        expect(cleared).toMatchObject({ status: 'expired', input_json: 'null', rules_json: '[]', result_json: null, webhook_url: '', webhook_secret: '', error: '', dispatch_error: '' });
        expect((await parserService.job(env.db, 1, job.id)).deliveries).toEqual([]);
        expect((await parserService.exportRows(env.db, 1, { parserId: config.id })).rows).toEqual([]);
        await parserService.reconcile(env.db);
        expect((await parserService.jobs(env.db, 1, { parserId: config.id })).rows).toHaveLength(1);
        await expect(parserService.enqueue(env.db, 1, config.id, email.email_id)).rejects.toMatchObject({ code: 410 });
        await parserService.saveConfig(env.db, 1, configuration({ version: 1, retentionDays: 1 }), config.id);
        expect((await parserService.enqueue(env.db, 1, config.id, email.email_id)).version).toBe(2);
        expect((await env.db.prepare('SELECT text FROM email WHERE email_id=?').bind(email.email_id).first()).text).toBe('订单号: OLD-1');
    });
    it('preserves active work, disabled retention and another owner history', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration({ retentionDays: 1 }));
        const pending = await parserService.enqueue(env.db, 1, config.id, 1);
        const processing = await parserService.enqueue(env.db, 1, config.id, 2);
        await env.db.prepare("UPDATE parser_job SET updated_at=0,status=CASE WHEN id=? THEN 'processing' ELSE status END,lease_until=?").bind(processing.id, Date.now() + 60000).run();
        const otherConfig = await parserService.saveConfig(env.db, 2, configuration({ accountId: 2, retentionDays: 0 }));
        const other = await parserService.enqueue(env.db, 2, otherConfig.id, 3);
        await env.db.prepare("UPDATE parser_job SET status='parsed',dispatch_status='pending',updated_at=0 WHERE id=?").bind(other.id).run();
        expect(await parserService.cleanup(env.db)).toBe(0);
        expect((await parserService.job(env.db, 1, pending.id)).status).toBe('pending');
        expect((await parserService.job(env.db, 1, processing.id)).status).toBe('processing');
        await env.db.prepare("UPDATE parser_job SET status='failed',updated_at=0 WHERE id=?").bind(pending.id).run();
        expect(await parserService.cleanup(env.db)).toBe(1);
        expect((await parserService.job(env.db, 2, other.id)).status).toBe('parsed');
        await parserService.saveConfig(env.db, 2, configuration({ accountId: 2, version: 1, retentionDays: 1 }), otherConfig.id);
        expect(await parserService.cleanup(env.db)).toBe(0); // Delivery still pending.
        await env.db.prepare("UPDATE parser_job SET dispatch_status='sending' WHERE id=?").bind(other.id).run();
        expect(await parserService.cleanup(env.db)).toBe(0);
        await env.db.prepare("UPDATE parser_job SET dispatch_status='failed' WHERE id=?").bind(other.id).run();
        expect(await parserService.cleanup(env.db)).toBe(1);
    });
    it('cleans a bounded batch per invocation and respects recently completed jobs', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration({ retentionDays: 1 }));
        await env.db.batch(Array.from({ length: 55 }, (_, index) => env.db.prepare(`INSERT INTO parser_job
            (parser_id,user_id,account_id,email_id,version,rules_json,input_json,status,available_at,created_at,updated_at)
            VALUES (?,1,1,?,1,'[]','{}','failed',0,0,?)`).bind(config.id, index + 100, index === 54 ? Date.now() : 0)));
        expect(await parserService.cleanup(env.db)).toBe(50);
        expect(await parserService.cleanup(env.db)).toBe(4);
        expect(await parserService.cleanup(env.db)).toBe(0);
        expect((await env.db.prepare("SELECT COUNT(*) AS total FROM parser_job WHERE status='failed'").first()).total).toBe(1);
    });
});

const matchCondition = (source, value, operator = 'equals') => ({ source, value, operator });

describe('matching conditions across preview, receipt and durable recovery', () => {
    it('upgrades previous schemas with no restrictions and preserves existing configuration', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration());
        await env.db.prepare('ALTER TABLE parser_config DROP COLUMN conditions_json').run();
        await env.db.prepare('ALTER TABLE parser_config DROP COLUMN scan_email_id').run();
        await initParserSchema(env.db); await initParserSchema(env.db);
        const updated = (await parserService.configs(env.db, 1))[0];
        expect(updated).toMatchObject({ id: config.id, version: 1, conditions: [], retentionDays: 0 });
        expect(updated.rules).toEqual(config.rules);
        expect((await parserService.enqueue(env.db, 1, config.id, 1)).status).toBe('pending');
    });
    it('normalizes and versions conditions, preserves them for older clients and rejects invalid saves', async () => {
        const conditions = [matchCondition('subject', '订单', 'contains')];
        const config = await parserService.saveConfig(env.db, 1, configuration({ conditions }));
        expect(config.conditions).toEqual([{ ...conditions[0], caseSensitive: false }]);
        const updated = await parserService.saveConfig(env.db, 1, configuration({ version: 1 }), config.id);
        expect(updated.conditions).toEqual(config.conditions); expect(updated.version).toBe(2);
        const invalid = await api(`/parser/configs/${config.id}`, { method: 'PUT', body: configuration({ version: 2, conditions: [matchCondition('subject', '(?<=a)b', 'regex')] }) });
        expect(invalid.code).toBe(400);
        expect((await parserService.configs(env.db, 1))[0].version).toBe(2);
        const cleared = await parserService.saveConfig(env.db, 1, configuration({ version: 2, conditions: [] }), config.id);
        expect(cleared.conditions).toEqual([]);
    });
    it('reports each preview condition and skips extraction without an error or job when unmatched', async () => {
        const conditions = [matchCondition('from', 'shop@example.test'), matchCondition('subject', 'INVOICE', 'contains')];
        const preview = await api('/parser/preview', { method: 'POST', body: { accountId: 1, emailId: 1, rules, conditions } });
        expect(preview.code).toBe(200);
        expect(preview.data.match).toMatchObject({ matched: false, checks: [{ matched: true }, { matched: false }] });
        expect(preview.data.data).toEqual({}); expect(preview.data.fields).toEqual([]);
        expect((await env.db.prepare('SELECT COUNT(*) AS total FROM parser_job').first()).total).toBe(0);
        const accepted = await api('/parser/preview', { method: 'POST', body: { accountId: 1, emailId: 1, rules, conditions: [conditions[0]] } });
        expect(accepted.data.match.matched).toBe(true); expect(accepted.data.data.order_id).toBe('A-100');
    });
    it('enforces saved conditions for manual submission and leaves mail untouched', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration({ conditions: [matchCondition('subject', 'INVOICE', 'contains')] }));
        const rejected = await api('/parser/enqueue', { method: 'POST', body: { parserId: config.id, emailId: 1, conditions: [] } });
        expect(rejected.code).toBe(200); expect(rejected.data.matched).toBe(false); expect(rejected.data.id).toBeUndefined();
        expect((await parserService.jobs(env.db, 1, { parserId: config.id })).rows).toEqual([]);
        expect((await env.db.prepare('SELECT subject,is_del FROM email WHERE email_id=1').first())).toMatchObject({ subject: '订单 A', is_del: 0 });
        expect((await api('/parser/enqueue', { method: 'POST', userId: 2, body: { parserId: config.id, emailId: 1 } })).code).toBe(404);
    });
    it('does not access missing CSV storage for non-matching mail', async () => {
        const key = await csvFile(); await env.kv.delete(key);
        const conditions = [matchCondition('subject', 'INVOICE', 'contains')];
        const config = await parserService.saveConfig(env.db, 1, configuration({ rules: csvRules, conditions }));
        const preview = await parserService.preview(env.db, 1, { accountId: 1, emailId: 1, rules: csvRules, conditions }, { env });
        expect(preview.match.matched).toBe(false);
        expect((await parserService.enqueue(env.db, 1, config.id, 1, { env })).matched).toBe(false);
        expect((await parserService.jobs(env.db, 1, { parserId: config.id })).rows).toEqual([]);
    });
    it('scans past more than one batch of non-matching mail without creating skipped jobs or blocking later matches', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration({ conditions: [matchCondition('subject', '订单', 'contains')] }));
        await env.db.batch(Array.from({ length: 25 }, () => env.db.prepare("INSERT INTO email(user_id,account_id,subject,text) VALUES(1,1,'Newsletter','ignored')")));
        const accepted = await env.db.prepare("INSERT INTO email(user_id,account_id,subject,text) VALUES(1,1,'新订单','订单号: LAST-1') RETURNING email_id").first();
        for (let index = 0; index < 4; index++) await worker.scheduled({ cron: '* * * * *' }, env, createExecutionContext());
        const jobs = await parserService.jobs(env.db, 1, { parserId: config.id });
        expect(jobs.rows).toHaveLength(1); expect(jobs.rows[0].data.order_id).toBe('LAST-1');
        expect((await env.db.prepare('SELECT scan_email_id FROM parser_config WHERE id=?').bind(config.id).first()).scan_email_id).toBe(accepted.email_id);
        expect((await env.db.prepare('SELECT COUNT(*) AS total FROM email').first()).total).toBe(29);
    });
    it('does not advance past a receipt still saving, including its temporary deleted flag', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration({ conditions: [matchCondition('subject', '订单', 'contains')] }));
        const saving = await env.db.prepare("INSERT INTO email(user_id,account_id,subject,text,status,is_del) VALUES(1,1,'新订单','订单号: EARLY-1',6,1) RETURNING email_id").first();
        await env.db.prepare("INSERT INTO email(user_id,account_id,subject,text) VALUES(1,1,'新订单','订单号: LATER-1')").run();
        await parserService.reconcile(env.db);
        expect((await parserService.jobs(env.db, 1, { parserId: config.id })).rows).toEqual([]);
        await env.db.prepare('UPDATE email SET status=0,is_del=0 WHERE email_id=?').bind(saving.email_id).run();
        await worker.scheduled({ cron: '* * * * *' }, env, createExecutionContext());
        expect((await parserService.jobs(env.db, 1, { parserId: config.id })).rows.map(row => row.data.order_id).sort()).toEqual(['EARLY-1', 'LATER-1']);
    });
    it('keeps transient attachment failures before the scan cursor eligible for recovery', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration({ rules: csvRules, conditions: [matchCondition('subject', 'ACCEPT')] }));
        const first = await env.db.prepare("INSERT INTO email(user_id,account_id,subject) VALUES(1,1,'ACCEPT') RETURNING email_id").first();
        const key = await csvFile({ emailId: first.email_id }); await env.kv.delete(key);
        const later = await env.db.prepare("INSERT INTO email(user_id,account_id,subject) VALUES(1,1,'ACCEPT') RETURNING email_id").first();
        await csvFile({ emailId: later.email_id });
        await parserService.reconcile(env.db, { env });
        expect((await parserService.jobs(env.db, 1, { parserId: config.id })).rows).toEqual([]);
        await env.kv.put(key, 'item,qty\nRestored,1');
        await worker.scheduled({ cron: '* * * * *' }, env, createExecutionContext());
        const jobs = (await parserService.jobs(env.db, 1, { parserId: config.id })).rows;
        expect(jobs).toHaveLength(2); expect(jobs.every(job => job.status === 'parsed')).toBe(true);
    });
    it('does not replay previously skipped mail after condition changes; explicit submission uses the new version', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration({ conditions: [matchCondition('subject', 'INVOICE')] }));
        const email = await env.db.prepare("INSERT INTO email(user_id,account_id,subject,text) VALUES(1,1,'ORDER','订单号: SKIP-1') RETURNING email_id").first();
        await parserService.reconcile(env.db);
        await parserService.saveConfig(env.db, 1, configuration({ version: 1, conditions: [] }), config.id);
        await parserService.reconcile(env.db);
        expect((await parserService.jobs(env.db, 1, { parserId: config.id })).rows).toEqual([]);
        const submitted = await api('/parser/enqueue', { method: 'POST', body: { parserId: config.id, emailId: email.email_id } });
        expect(submitted.data.version).toBe(2);
        expect((await parserService.job(env.db, 1, submitted.data.id)).data.order_id).toBe('SKIP-1');
    });
    it('preserves already registered job snapshots when conditions are edited', async () => {
        const config = await parserService.saveConfig(env.db, 1, configuration());
        const job = await parserService.enqueue(env.db, 1, config.id, 1);
        await parserService.saveConfig(env.db, 1, configuration({ version: 1, conditions: [matchCondition('subject', 'NO MATCH')] }), config.id);
        await parserService.process(env.db);
        expect((await parserService.job(env.db, 1, job.id)).data.order_id).toBe('A-100');
        expect((await parserService.enqueue(env.db, 1, config.id, 1)).matched).toBe(false);
    });
    it('filters through the real MIME handler using the From header and delivered mailbox', async () => {
        const conditions = [matchCondition('from', 'shop@example.test'), matchCondition('to', 'orders@example.test'), matchCondition('subject', 'ORDER', 'contains')];
        const config = await parserService.saveConfig(env.db, 1, configuration({ conditions }));
        await env.kv.put('setting:', JSON.stringify({ receive: 0, emailPrefixFilter: '', noRecipient: 1, aiCode: 1, tgBotStatus: 1, forwardStatus: 1, webhookStatus: 1 }));
        const reject = vi.fn();
        for (const subject of ['Newsletter', 'New ORDER']) {
            const raw = `From: Shop <shop@example.test>\r\nTo: original@example.test\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n订单号: MIME-1`;
            const ctx = createExecutionContext();
            await receiveEmail({ from: 'bounce@example.test', to: 'orders@example.test', raw: new Response(raw).body, setReject: reject }, env, ctx);
            await waitOnExecutionContext(ctx);
        }
        expect(reject).not.toHaveBeenCalled();
        const jobs = (await parserService.jobs(env.db, 1, { parserId: config.id })).rows;
        expect(jobs).toHaveLength(1); expect(jobs[0].data.order_id).toBe('MIME-1');
        expect((await env.db.prepare('SELECT COUNT(*) AS total FROM email').first()).total).toBe(5);
    });
});

async function legacyConfigTable() {
    await env.db.prepare('DROP TABLE parser_config').run();
    await env.db.prepare(`CREATE TABLE parser_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES user(user_id) ON DELETE CASCADE,
        account_id INTEGER NOT NULL REFERENCES account(account_id) ON DELETE CASCADE,
        name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
        rules_json TEXT NOT NULL, webhook_url TEXT NOT NULL DEFAULT '', webhook_secret TEXT NOT NULL DEFAULT '',
        start_email_id INTEGER NOT NULL DEFAULT 0, last_scanned_at INTEGER NOT NULL DEFAULT 0,
        retention_days INTEGER NOT NULL DEFAULT 0, conditions_json TEXT NOT NULL DEFAULT '[]', scan_email_id INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(user_id,account_id))`).run();
}

async function parserSnapshot() {
    const data = {};
    for (const table of ['parser_config', 'parser_job', 'parser_delivery']) data[table] = (await env.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results;
    return data;
}

describe('multi-rule schema migration preserves history', () => {
    it('removes the legacy inline uniqueness without cascading history or reusing identifiers', async () => {
        await legacyConfigTable();
        const config = await parserService.saveConfig(env.db, 1, configuration({ webhookUrl: 'https://hooks.example.com/old', webhookSecret: 'Bearer preserved' }));
        const job = await parserService.enqueue(env.db, 1, config.id, 1);
        await parserService.enqueue(env.db, 1, config.id, 2);
        await env.db.prepare("UPDATE parser_job SET status='parsed',result_json=?,dispatch_status='sent',parsed_at=100,sent_at=101,lease_token='preserved-lease',lease_until=102 WHERE id=?")
            .bind(JSON.stringify({ data: { order_id: 'A-100' }, errors: [] }), job.id).run();
        await env.db.prepare('INSERT INTO parser_delivery(job_id,user_id,attempt,status_code,created_at) VALUES(?,1,1,204,101)').bind(job.id).run();
        await env.db.prepare("INSERT INTO parser_config(id,user_id,account_id,name,rules_json,created_at,updated_at) VALUES(900,2,2,'deleted','[]',0,0)").run();
        await env.db.prepare('DELETE FROM parser_config WHERE id=900').run();
        await env.db.prepare("INSERT INTO parser_job(id,parser_id,user_id,account_id,email_id,version,rules_json,input_json,available_at,created_at,updated_at) VALUES(900,?,1,1,900,1,'[]','{}',0,0,0)").bind(config.id).run();
        await env.db.prepare('DELETE FROM parser_job WHERE id=900').run();
        await env.db.prepare('INSERT INTO parser_delivery(id,job_id,user_id,attempt,status_code,created_at) VALUES(900,?,1,2,503,102)').bind(job.id).run();
        await env.db.prepare('DELETE FROM parser_delivery WHERE id=900').run();
        const before = await parserSnapshot();
        await initParserSchema(env.db); await initParserSchema(env.db);
        const after = await parserSnapshot();
        expect(after.parser_config).toEqual(before.parser_config.map(row => ({ ...row, last_processed_at: 0 })));
        expect(after.parser_job).toEqual(before.parser_job); expect(after.parser_delivery).toEqual(before.parser_delivery);
        expect((await env.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
        const second = await parserService.saveConfig(env.db, 1, configuration({ name: '第二套', webhookUrl: 'https://hooks.example.com/new' }));
        expect(second.id).toBeGreaterThan(900);
        const next = await parserService.enqueue(env.db, 1, second.id, 1);
        expect(next.id).toBeGreaterThan(900);
        await parserService.process(env.db, { parserId: second.id, fetcher: async () => new Response(null, { status: 204 }) });
        expect((await env.db.prepare('SELECT MAX(id) AS id FROM parser_delivery').first()).id).toBeGreaterThan(900);
        await env.db.prepare('DELETE FROM account WHERE account_id=1').run();
        expect((await env.db.prepare('SELECT COUNT(*) AS total FROM parser_job').first()).total).toBe(0);
        expect((await env.db.prepare('SELECT COUNT(*) AS total FROM parser_delivery').first()).total).toBe(0);
    });

    it.each(['restore', 'indexes'])('rolls the rebuild back if %s fails and can safely retry', async stage => {
        await legacyConfigTable();
        const config = await parserService.saveConfig(env.db, 1, configuration());
        await parserService.enqueue(env.db, 1, config.id, 1);
        await parserService.enqueue(env.db, 1, config.id, 2);
        await env.db.prepare('ALTER TABLE parser_config ADD COLUMN last_processed_at INTEGER NOT NULL DEFAULT 0').run();
        const before = await parserSnapshot();
        const columns = {};
        for (const table of ['parser_config', 'parser_job', 'parser_delivery']) columns[table] = (await env.db.prepare(`PRAGMA table_info(${table})`).all()).results.map(column => column.name);
        const sql = multiParserMigrationSql(columns);
        if (stage === 'restore') sql.splice(sql.findIndex(statement => statement.startsWith('INSERT INTO parser_config')) + 1, 0, 'INSERT INTO parser_config SELECT * FROM parser_config');
        else sql.splice(sql.findIndex(statement => statement.startsWith('CREATE INDEX')), 0, 'CREATE UNIQUE INDEX _parser_test_conflict ON parser_job(user_id)');
        await expect(env.db.batch(sql.map(statement => env.db.prepare(statement)))).rejects.toThrow();
        expect(await parserSnapshot()).toEqual(before);
        expect((await env.db.prepare("SELECT name FROM sqlite_master WHERE name GLOB '_parser_multi_*'").all()).results).toEqual([]);
        expect((await env.db.prepare('PRAGMA index_list(parser_config)').all()).results.some(index => index.unique)).toBe(true);
        await initParserSchema(env.db);
        expect((await parserService.saveConfig(env.db, 1, configuration())).id).not.toBe(config.id);
        expect((await parserService.jobs(env.db, 1, { parserId: config.id })).rows).toHaveLength(2);
    });
});

describe('independent rule sets in one mailbox', () => {
    it('creates multiple sets through HTTP and scopes the mailbox list and ownership', async () => {
        const first = (await api('/parser/configs', { method: 'POST', body: configuration({ name: '订单号' }) })).data;
        const second = (await api('/parser/configs', { method: 'POST', body: configuration({ name: '金额' }) })).data;
        expect(first.id).not.toBe(second.id); expect(first.version).toBe(1); expect(second.version).toBe(1);
        expect((await api('/parser/configs?accountId=1')).data).toHaveLength(2);
        expect((await api('/parser/configs?accountId=1', { userId: 2 })).code).toBe(404);
        expect((await api('/parser/configs', { userId: 2 })).data).toEqual([]);
        const updated = await parserService.saveConfig(env.db, 1, configuration({ name: '订单号 v2', version: 1 }), first.id);
        expect(updated.version).toBe(2);
        expect((await parserService.configs(env.db, 1)).find(row => row.id === second.id).version).toBe(1);
    });

    it('keeps submissions, snapshots, results and exports isolated for the same email', async () => {
        const first = await parserService.saveConfig(env.db, 1, configuration());
        const second = await parserService.saveConfig(env.db, 1, configuration({ name: '金额', rules: [{ key: 'amount', source: 'text', required: true,
            filters: [{ type: 'regex', pattern: '金额: (\\d+)', group: 1 }, { type: 'number' }] }] }));
        await env.db.prepare("UPDATE email SET text='订单号: A-100 金额: 12' WHERE email_id=1").run();
        const [a, b] = await Promise.all([parserService.enqueue(env.db, 1, first.id, 1), parserService.enqueue(env.db, 1, second.id, 1)]);
        expect(a.id).not.toBe(b.id);
        expect((await parserService.enqueue(env.db, 1, first.id, 1)).id).toBe(a.id);
        await env.db.prepare("UPDATE email SET text='changed' WHERE email_id=1").run();
        await parserService.process(env.db);
        expect((await parserService.job(env.db, 1, a.id)).data).toEqual({ order_id: 'A-100' });
        expect((await parserService.job(env.db, 1, b.id)).data).toEqual({ amount: 12 });
        expect((await parserService.exportRows(env.db, 1, { parserId: first.id })).rows.map(row => row.id)).toEqual([a.id]);
        expect((await parserService.exportRows(env.db, 1, { parserId: second.id })).rows.map(row => row.id)).toEqual([b.id]);
    });

    it('fans out real MIME receipt to every matching enabled set without short-circuiting', async () => {
        const first = await parserService.saveConfig(env.db, 1, configuration());
        const second = await parserService.saveConfig(env.db, 1, configuration({ rules: [{ key: 'subject', source: 'subject', filters: [{ type: 'upper' }] }] }));
        const excluded = await parserService.saveConfig(env.db, 1, configuration({ conditions: [matchCondition('subject', 'No match')] }));
        const paused = await parserService.saveConfig(env.db, 1, configuration({ enabled: false }));
        await env.kv.put('setting:', JSON.stringify({ receive: 0, emailPrefixFilter: '', noRecipient: 1, aiCode: 1, tgBotStatus: 1, forwardStatus: 1, webhookStatus: 1 }));
        const raw = 'From: Shop <shop@example.test>\r\nTo: orders@example.test\r\nSubject: New order\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n订单号: MULTI-1';
        const ctx = createExecutionContext(), reject = vi.fn();
        await receiveEmail({ from: 'shop@example.test', to: 'orders@example.test', raw: new Response(raw).body, setReject: reject }, env, ctx);
        await waitOnExecutionContext(ctx);
        expect(reject).not.toHaveBeenCalled();
        const a = (await parserService.jobs(env.db, 1, { parserId: first.id })).rows;
        const b = (await parserService.jobs(env.db, 1, { parserId: second.id })).rows;
        expect(a).toHaveLength(1); expect(b).toHaveLength(1); expect(a[0].emailId).toBe(b[0].emailId);
        expect(a[0].data.order_id).toBe('MULTI-1'); expect(b[0].data.subject).toBe('NEW ORDER');
        for (const config of [excluded, paused]) expect((await parserService.jobs(env.db, 1, { parserId: config.id })).rows).toEqual([]);
    });

    it('continues healthy registration and scanning when a sibling CSV store is unavailable', async () => {
        const csv = await parserService.saveConfig(env.db, 1, configuration({ rules: csvRules }));
        const text = await parserService.saveConfig(env.db, 1, configuration());
        const email = await env.db.prepare("INSERT INTO email(user_id,account_id,text) VALUES(1,1,'订单号: SAFE-1') RETURNING *").first();
        const key = await csvFile({ emailId: email.email_id }); await env.kv.delete(key);
        expect(await parserService.receive(env.db, { ...email, userId: 1, accountId: 1, emailId: email.email_id }, { env })).toBe(true);
        await parserService.process(env.db);
        expect((await parserService.jobs(env.db, 1, { parserId: text.id })).rows[0].data.order_id).toBe('SAFE-1');
        await parserService.reconcile(env.db, { env });
        const cursors = (await env.db.prepare('SELECT id,scan_email_id FROM parser_config ORDER BY id').all()).results;
        expect(cursors.find(row => row.id === csv.id).scan_email_id).toBeLessThan(email.email_id);
        expect(cursors.find(row => row.id === text.id).scan_email_id).toBe(email.email_id);
        await env.kv.put(key, 'item,qty\nRecovered,1'); await parserService.tick(env.db, { env });
        expect((await parserService.jobs(env.db, 1, { parserId: csv.id })).rows[0].data.items).toEqual([{ item: 'Recovered', qty: '1' }]);
        expect((await parserService.jobs(env.db, 1, { parserId: text.id })).rows).toHaveLength(1);
    });

    it('processes later rule sets while an earlier webhook is still waiting, with bounded concurrency', async () => {
        const configs = [];
        for (const path of ['slow', 'fast1', 'fast2', 'last']) configs.push(await parserService.saveConfig(env.db, 1, configuration({ name: path, webhookUrl: `https://hooks.example.com/${path}` })));
        await env.db.prepare("INSERT INTO email(user_id,account_id,text) VALUES(1,1,'订单号: CONCURRENT-1')").run();
        let release, reachedLast = false, active = 0, peak = 0;
        const hold = new Promise(resolve => { release = resolve; });
        const ids = new Set();
        const running = parserService.tick(env.db, { fetcher: async (url, options) => {
            active++; peak = Math.max(peak, active); ids.add(options.headers['Idempotency-Key']);
            try {
                if (url.endsWith('/slow')) await hold;
                if (url.endsWith('/last')) reachedLast = true;
                return new Response(null, { status: 204 });
            } finally { active--; }
        } });
        try {
            await vi.waitFor(() => expect(reachedLast).toBe(true), { timeout: 1500, interval: 20 });
            const slow = (await parserService.jobs(env.db, 1, { parserId: configs[0].id })).rows[0];
            expect(slow.dispatchStatus).toBe('sending');
            await vi.waitFor(async () => expect((await parserService.jobs(env.db, 1, { parserId: configs[3].id })).rows[0].dispatchStatus).toBe('sent'));
        } finally { release(); await running; }
        expect(peak).toBeLessThanOrEqual(3); expect(ids.size).toBe(4);
        for (const config of configs) expect((await parserService.jobs(env.db, 1, { parserId: config.id })).rows[0].dispatchStatus).toBe('sent');
    });

    it('isolates validation failures, manual processing and retry from sibling pending jobs', async () => {
        const failed = await parserService.saveConfig(env.db, 1, configuration({ rules: [{ key: 'missing', source: 'subject', required: true, filters: [{ type: 'regex', pattern: 'not present' }] }] }));
        const good = await parserService.saveConfig(env.db, 1, configuration());
        const pending = await parserService.enqueue(env.db, 1, good.id, 1);
        const result = (await api('/parser/enqueue', { method: 'POST', body: { parserId: failed.id, emailId: 1 } })).data;
        expect((await parserService.job(env.db, 1, result.id)).status).toBe('failed');
        expect((await parserService.job(env.db, 1, pending.id)).status).toBe('pending');
        expect((await api(`/parser/jobs/${result.id}/retry`, { method: 'POST', body: { kind: 'parse' } })).code).toBe(200);
        expect((await parserService.job(env.db, 1, pending.id)).attempts).toBe(0);
        await parserService.process(env.db);
        expect((await parserService.job(env.db, 1, pending.id)).data.order_id).toBe('A-100');
    });

    it('pauses only the selected set while siblings continue processing', async () => {
        const paused = await parserService.saveConfig(env.db, 1, configuration());
        const active = await parserService.saveConfig(env.db, 1, configuration());
        const a = await parserService.enqueue(env.db, 1, paused.id, 1), b = await parserService.enqueue(env.db, 1, active.id, 1);
        await parserService.saveConfig(env.db, 1, configuration({ version: 1, enabled: false }), paused.id);
        await parserService.process(env.db);
        expect((await parserService.job(env.db, 1, a.id)).status).toBe('pending');
        expect((await parserService.job(env.db, 1, b.id)).status).toBe('parsed');
    });

    it('keeps webhook failures, credentials and manual delivery retries isolated', async () => {
        const a = await parserService.saveConfig(env.db, 1, configuration({ webhookUrl: 'https://hooks.example.com/a', webhookSecret: 'Bearer A' }));
        const b = await parserService.saveConfig(env.db, 1, configuration({ webhookUrl: 'https://hooks.example.com/b', webhookSecret: 'Bearer B' }));
        const ja = await parserService.enqueue(env.db, 1, a.id, 1), jb = await parserService.enqueue(env.db, 1, b.id, 1);
        const fetcher = vi.fn(async (url, options) => {
            expect(options.headers.Authorization).toBe(url.endsWith('/a') ? 'Bearer A' : 'Bearer B');
            return new Response(null, { status: url.endsWith('/a') ? 503 : 204 });
        });
        await parserService.process(env.db, { fetcher });
        expect((await parserService.job(env.db, 1, ja.id)).dispatchStatus).toBe('pending');
        const sibling = await parserService.job(env.db, 1, jb.id);
        expect(sibling.dispatchStatus).toBe('sent');
        await env.db.prepare("UPDATE parser_job SET dispatch_status='failed' WHERE id=?").bind(ja.id).run();
        const retry = await parserService.retry(env.db, 1, ja.id, 'dispatch');
        await parserService.process(env.db, { parserId: retry.parserId, fetcher: async (url, options) => {
            expect(url).toBe('https://hooks.example.com/a'); expect(options.headers.Authorization).toBe('Bearer A');
            expect(options.headers['Idempotency-Key']).toBe(`parser-job-${ja.id}`);
            return new Response(null, { status: 204 });
        } });
        expect((await parserService.job(env.db, 1, ja.id)).dispatchStatus).toBe('sent');
        expect(await parserService.job(env.db, 1, jb.id)).toEqual(sibling);
    });

    it('allocates each set its own parse budget rather than letting a backlog monopolize a round', async () => {
        const backlog = await parserService.saveConfig(env.db, 1, configuration()), other = await parserService.saveConfig(env.db, 1, configuration());
        for (let index = 0; index < 6; index++) {
            const email = await env.db.prepare("INSERT INTO email(user_id,account_id,text) VALUES(1,1,'订单号: BULK-1') RETURNING email_id").first();
            await parserService.enqueue(env.db, 1, backlog.id, email.email_id);
        }
        const job = await parserService.enqueue(env.db, 1, other.id, 1);
        await parserService.process(env.db);
        expect((await parserService.job(env.db, 1, job.id)).status).toBe('parsed');
        const rows = (await parserService.jobs(env.db, 1, { parserId: backlog.id })).rows;
        expect(rows.filter(row => row.status === 'parsed')).toHaveLength(5); expect(rows.filter(row => row.status === 'pending')).toHaveLength(1);
    });

    it('rotates scheduled batches across more than ten rule sets', async () => {
        const configs = [];
        for (let index = 0; index < 12; index++) configs.push(await parserService.saveConfig(env.db, 1, configuration({ name: `set-${index}` })));
        await env.db.prepare("INSERT INTO email(user_id,account_id,text) VALUES(1,1,'订单号: FAIR-1')").run();
        await parserService.tick(env.db);
        expect((await env.db.prepare('SELECT COUNT(*) AS total FROM parser_job').first()).total).toBe(10);
        await parserService.tick(env.db);
        expect((await env.db.prepare("SELECT COUNT(*) AS total FROM parser_job WHERE status='parsed'").first()).total).toBe(12);
        for (const config of configs) expect((await parserService.jobs(env.db, 1, { parserId: config.id })).rows).toHaveLength(1);
    });

    it('applies retention only to the rule set whose policy expired', async () => {
        const expired = await parserService.saveConfig(env.db, 1, configuration({ retentionDays: 1 }));
        const kept = await parserService.saveConfig(env.db, 1, configuration({ retentionDays: 0 }));
        const a = await parserService.enqueue(env.db, 1, expired.id, 1), b = await parserService.enqueue(env.db, 1, kept.id, 1);
        await parserService.process(env.db); await env.db.prepare('UPDATE parser_job SET updated_at=0').run();
        expect(await parserService.cleanup(env.db)).toBe(1);
        expect((await parserService.job(env.db, 1, a.id)).status).toBe('expired'); expect((await parserService.job(env.db, 1, b.id)).status).toBe('parsed');
    });
});

describe('webhook target validation', () => {
    it.each(['http://example.com', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://foo.internal', 'https://example.com:8443', 'https://user:pass@example.com'])('rejects unsafe destination %s', url => {
        expect(() => validateWebhook(url)).toThrow();
    });
});
