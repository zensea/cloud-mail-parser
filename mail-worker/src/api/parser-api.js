import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import parserService from '../service/parser-service';
import { csvExport } from '../lib/parser-engine';
import { bodyLimit } from 'hono/body-limit';
import BizError from '../error/biz-error';
import parserDownloads from '../service/parser-download-service';
import { checkSize } from '../lib/parser-engine';

const owner = c => userContext.getUserId(c);
const processLater = (c, parserId) => c.executionCtx.waitUntil(parserService.process(c, { userId: owner(c), parserId }).catch(error => console.error('Parser background task failed', error)));
async function requestBody(c) {
    let data;
    try { data = await c.req.json(); } catch { throw new BizError('Invalid JSON request', 400); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new BizError('Expected a JSON object', 400);
    return data;
}

app.use('/parser/*', bodyLimit({ maxSize: 262144 }));
app.use('/parser/*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });

app.get('/parser/accounts', async c => c.json(result.ok(await parserService.accounts(c, owner(c)))));
app.get('/parser/configs', async c => c.json(result.ok(await parserService.configs(c, owner(c), c.req.query('accountId')))));
app.post('/parser/configs', async c => c.json(result.ok(await parserService.saveConfig(c, owner(c), await requestBody(c)))));
app.put('/parser/configs/:id', async c => c.json(result.ok(await parserService.saveConfig(c, owner(c), await requestBody(c), c.req.param('id')))));
app.get('/parser/samples', async c => c.json(result.ok(await parserService.samples(c, owner(c), c.req.query('accountId')))));
app.post('/parser/preview', async c => {
    return c.json(result.ok(await parserService.preview(c, owner(c), await requestBody(c))));
});
app.post('/parser/enqueue', async c => {
    const { parserId, emailId } = await requestBody(c);
    const job = await parserService.enqueue(c, owner(c), parserId, emailId);
    if (job.id) processLater(c, job.parserId);
    return c.json(result.ok(job));
});
app.get('/parser/jobs', async c => c.json(result.ok(await parserService.jobs(c, owner(c), c.req.query()))));
app.get('/parser/jobs/:id', async c => c.json(result.ok(await parserService.job(c, owner(c), c.req.param('id')))));
app.post('/parser/jobs/:id/retry', async c => {
    const { kind } = await requestBody(c);
    const retried = await parserService.retry(c, owner(c), c.req.param('id'), kind);
    processLater(c, retried.parserId);
    return c.json(result.ok());
});
app.get('/parser/export', async c => {
    if (c.req.query('format') && !['csv', 'json'].includes(c.req.query('format'))) throw new BizError('Unsupported export format', 400);
    const data = await parserService.exportRows(c, owner(c), c.req.query());
    return exportResponse(c, data, { format: c.req.query('format') || 'json', tableField: c.req.query('tableField'), parserId: c.req.query('parserId') });
});

app.get('/parser/download', async c => {
    const params = c.req.query();
    if (params.downloadId) {
        const { data, options } = await parserDownloads.file(c, owner(c), params.downloadId);
        return exportResponse(c, data, options);
    }
    if (!['csv', 'json'].includes(params.format)) throw new BizError('Unsupported export format', 400);
    return exportResponse(c, await parserService.downloadRows(c, owner(c), params), params);
});
app.get('/parser/download-links', async c => c.json(result.ok(await parserDownloads.list(c, owner(c), c.req.query('parserId')))));
app.post('/parser/download-links', async c => c.json(result.ok(await parserDownloads.create(c, owner(c), await requestBody(c)))));
app.put('/parser/download-links/:id', async c => c.json(result.ok(await parserDownloads.update(c, owner(c), c.req.param('id'), await requestBody(c)))));
app.post('/parser/download-links/:id/rotate', async c => c.json(result.ok(await parserDownloads.rotate(c, owner(c), c.req.param('id')))));
app.delete('/parser/download-links/:id', async c => {
    await parserDownloads.revoke(c, owner(c), c.req.param('id'));
    return c.json(result.ok());
});
app.get('/parser-download/:token', async c => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Robots-Tag', 'noindex, nofollow');
    try {
        const { data, options } = await parserDownloads.download(c, c.req.param('token'), c.req.query());
        return exportResponse(c, data, options);
    } catch (error) {
        const status = error.name === 'BizError' ? error.code : 500;
        return c.json(result.fail(status === 500 ? 'Download unavailable' : error.message, status), status);
    }
});

function exportResponse(c, data, options) {
    let body;
    try {
        body = options.format === 'csv' ? csvExport(data.rows, options.tableField) : JSON.stringify(result.ok(data));
        checkSize(body, 4194304);
    } catch (error) { throw new BizError(`${error.message}; choose fewer results or fields`, 400); }
    c.header('Content-Type', options.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="parsed-emails-${Number(options.parserId)}.${options.format}"`);
    c.header('X-Next-Cursor', data.nextCursor);
    c.header('X-Has-More', String(data.hasMore));
    c.header('Access-Control-Expose-Headers', 'X-Next-Cursor, X-Has-More, Content-Disposition');
    c.header('Cache-Control', 'no-store');
    return c.body(body);
}
