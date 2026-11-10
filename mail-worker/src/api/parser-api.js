import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import parserService from '../service/parser-service';
import { csvExport } from '../lib/parser-engine';
import { bodyLimit } from 'hono/body-limit';
import BizError from '../error/biz-error';

const owner = c => userContext.getUserId(c);
const processLater = c => c.executionCtx.waitUntil(parserService.process(c.env.db, { userId: owner(c) }).catch(error => console.error('Parser background task failed', error)));
async function requestBody(c) {
    let data;
    try { data = await c.req.json(); } catch { throw new BizError('Invalid JSON request', 400); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new BizError('Expected a JSON object', 400);
    return data;
}

app.use('/parser/*', bodyLimit({ maxSize: 262144 }));
app.use('/parser/*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });

app.get('/parser/accounts', async c => c.json(result.ok(await parserService.accounts(c.env.db, owner(c)))));
app.get('/parser/configs', async c => c.json(result.ok(await parserService.configs(c.env.db, owner(c)))));
app.post('/parser/configs', async c => c.json(result.ok(await parserService.saveConfig(c.env.db, owner(c), await requestBody(c)))));
app.put('/parser/configs/:id', async c => c.json(result.ok(await parserService.saveConfig(c.env.db, owner(c), await requestBody(c), c.req.param('id')))));
app.get('/parser/samples', async c => c.json(result.ok(await parserService.samples(c.env.db, owner(c), c.req.query('accountId')))));
app.post('/parser/preview', async c => {
    return c.json(result.ok(await parserService.preview(c.env.db, owner(c), await requestBody(c), { env: c.env })));
});
app.post('/parser/enqueue', async c => {
    const { parserId, emailId } = await requestBody(c);
    const job = await parserService.enqueue(c.env.db, owner(c), parserId, emailId, { env: c.env });
    if (job.id) processLater(c);
    return c.json(result.ok(job));
});
app.get('/parser/jobs', async c => c.json(result.ok(await parserService.jobs(c.env.db, owner(c), c.req.query()))));
app.get('/parser/jobs/:id', async c => c.json(result.ok(await parserService.job(c.env.db, owner(c), c.req.param('id')))));
app.post('/parser/jobs/:id/retry', async c => {
    const { kind } = await requestBody(c);
    await parserService.retry(c.env.db, owner(c), c.req.param('id'), kind);
    processLater(c);
    return c.json(result.ok());
});
app.get('/parser/export', async c => {
    if (c.req.query('format') && !['csv', 'json'].includes(c.req.query('format'))) throw new BizError('Unsupported export format', 400);
    const data = await parserService.exportRows(c.env.db, owner(c), c.req.query());
    if (c.req.query('format') === 'csv') {
        c.header('Content-Type', 'text/csv; charset=utf-8');
        c.header('Content-Disposition', 'attachment; filename="parsed-emails.csv"');
        c.header('X-Next-Cursor', data.nextCursor);
        c.header('X-Has-More', String(data.hasMore));
        c.header('Cache-Control', 'no-store');
        let csv;
        try { csv = csvExport(data.rows, c.req.query('tableField')); }
        catch (error) { throw new BizError(error.message, 400); }
        return c.body(csv);
    }
    c.header('Cache-Control', 'no-store');
    return c.json(result.ok(data));
});
