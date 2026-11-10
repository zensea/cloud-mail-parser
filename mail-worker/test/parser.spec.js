import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src';
import parserService, { validateWebhook } from '../src/service/parser-service';
import { initParserSchema } from '../src/init/parser-schema';
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
    await initParserSchema(env.db);
});

async function api(path, { method = 'GET', body, userId = 1 } = {}) {
    const ctx = createExecutionContext();
    const headers = { 'Content-Type': 'application/json' };
    if (userId) {
        const token = `test-session-${userId}`;
        headers.Authorization = await jwtUtils.generateToken({ env }, { userId, token }, 3600);
        await env.kv.put(`auth-uid:${userId}`, JSON.stringify({ tokens: [token], user: { userId, email: `${userId}@example.test` }, refreshTime: new Date().toISOString() }));
    }
    const response = await worker.fetch(new Request(`https://local.test/api${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }), env, ctx);
    await waitOnExecutionContext(ctx);
    return response.json();
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

describe('webhook target validation', () => {
    it.each(['http://example.com', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://foo.internal', 'https://example.com:8443', 'https://user:pass@example.com'])('rejects unsafe destination %s', url => {
        expect(() => validateWebhook(url)).toThrow();
    });
});
