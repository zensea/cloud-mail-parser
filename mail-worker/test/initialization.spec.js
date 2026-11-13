import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it } from 'vitest';
import worker from '../src';
import jwtUtils from '../src/utils/jwt-utils';
import constant from '../src/const/constant';

async function request(path, { method = 'GET', body, token } = {}) {
    const ctx = createExecutionContext();
    const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) };
    const response = await worker.fetch(new Request(`https://local.test/api${path}`, {
        method, headers, ...(body ? { body: JSON.stringify(body) } : {})
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
}

it('initializes main and parser schemas together and authenticates a real login', async () => {
    const initPath = `/init/${env.jwt_secret}`;
    expect(await (await request(initPath)).text()).toBe('success');
    expect(await env.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_email_user_create_time'").first()).not.toBeNull();
    const tables = await env.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('parser_config','parser_job','parser_delivery','parser_download')").all();
    expect(tables.results).toHaveLength(4);

    const credentials = { email: 'admin@example.test', password: 'LocalMerge2026!' };
    expect((await (await request('/register', { method: 'POST', body: credentials })).json()).code).toBe(200);
    const login = await (await request('/login', { method: 'POST', body: credentials })).json();
    expect(login.code).toBe(200);
    const token = login.data.token;
    expect((await jwtUtils.verifyToken({ env }, token)).gen).toBe(constant.AUTH_GEN);
    const accounts = await (await request('/parser/accounts', { token })).json();
    expect(accounts.code).toBe(200);
    const created = await (await request('/parser/configs', { method: 'POST', token, body: {
        accountId: accounts.data[0].accountId, name: '初始化合并验证', enabled: false,
        rules: [{ key: 'subject', source: 'subject', required: false, filters: [] }]
    } })).json();
    expect(created.code).toBe(200);

    expect(await (await request(initPath)).text()).toBe('success');
    const configs = await (await request('/parser/configs', { token })).json();
    expect(configs.code).toBe(200);
    expect(configs.data.map(config => config.id)).toContain(created.data.id);
});
