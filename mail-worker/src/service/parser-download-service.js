import BizError from '../error/biz-error';
import parserService, { ownConfig, positiveId } from './parser-service';
import { downloadOptions } from '../lib/parser-export';

const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const hash = async token => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
const token = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const view = row => ({ id: row.id, parserId: row.parser_id, name: row.name, format: row.format, fields: JSON.parse(row.fields_json),
    tableField: row.table_field, fromTime: row.from_time, toTime: row.to_time, range: row.range_mode, timezoneOffset: row.timezone_offset,
    size: row.batch_size, createdAt: row.created_at, updatedAt: row.updated_at });

async function encryptionKey(secret) {
    if (!secret) throw new Error('Download encryption key unavailable');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
    return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(value, secret) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(secret), new TextEncoder().encode(value));
    return hex(iv) + hex(new Uint8Array(encrypted));
}
async function pathFor(row, secret) {
    if (!row.token_encrypted) return null;
    try {
        const bytes = Uint8Array.from(row.token_encrypted.match(/../g), value => parseInt(value, 16));
        const value = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await encryptionKey(secret), bytes.slice(12)));
        return `/parser-download/${value}`;
    } catch { return null; } // Old links and a rotated server key can be regenerated.
}
function settings(params) {
    if (typeof params.name !== 'string' || !params.name.trim() || params.name.length > 80) throw new BizError('Use a download name of 1 to 80 characters', 400);
    if (!['csv', 'json'].includes(params.format)) throw new BizError('Unsupported export format', 400);
    return downloadOptions({ ...params, range: params.range ?? 'legacy' });
}

async function owned(db, userId, id) {
    const row = await db.prepare('SELECT * FROM parser_download WHERE id=? AND user_id=?').bind(positiveId(id), userId).first();
    if (!row) throw new BizError('Download link not found', 404);
    await ownConfig(db, row.parser_id, userId);
    return row;
}

export default {
    async list(db, userId, parserId, secret) {
        await ownConfig(db, parserId, userId);
        const { results } = await db.prepare('SELECT * FROM parser_download WHERE user_id=? AND parser_id=? ORDER BY id DESC').bind(userId, positiveId(parserId)).all();
        return Promise.all(results.map(async row => ({ ...view(row), path: await pathFor(row, secret) })));
    },
    async create(db, userId, params, key) {
        const config = await ownConfig(db, params.parserId, userId);
        const options = settings(params), secret = token(), now = Date.now();
        const row = await db.prepare(`INSERT INTO parser_download
            (parser_id,user_id,name,format,fields_json,table_field,from_time,to_time,batch_size,token_hash,created_at,updated_at,range_mode,timezone_offset,token_encrypted)
            SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM parser_download WHERE parser_id=? AND user_id=?)<20 RETURNING *`)
            .bind(config.id, userId, params.name.trim(), params.format, JSON.stringify(options.fields), options.tableField,
                options.fromTime, options.toTime, options.size, await hash(secret), now, now, options.range, options.timezoneOffset, await seal(secret, key), config.id, userId).first();
        if (!row) throw new BizError('A rule set can have up to 20 download links; revoke an unused link first', 409);
        return { ...view(row), path: `/parser-download/${secret}` };
    },
    async update(db, userId, id, params, key) {
        const current = await owned(db, userId, id);
        if (params.parserId !== undefined && positiveId(params.parserId) !== current.parser_id) throw new BizError('A download link cannot change rule sets', 400);
        const options = settings(params);
        const row = await db.prepare(`UPDATE parser_download SET name=?,format=?,fields_json=?,table_field=?,from_time=?,to_time=?,batch_size=?,range_mode=?,timezone_offset=?,updated_at=?
            WHERE id=? AND user_id=? RETURNING *`).bind(params.name.trim(), params.format, JSON.stringify(options.fields), options.tableField, options.fromTime, options.toTime,
                options.size, options.range, options.timezoneOffset, Date.now(), current.id, userId).first();
        if (!row) throw new BizError('Download link not found', 404);
        return { ...view(row), path: await pathFor(row, key) };
    },
    async file(db, userId, id) {
        const row = await owned(db, userId, id);
        const options = view(row);
        return { data: await parserService.downloadRows(db, userId, options), options };
    },
    async rotate(db, userId, id, key) {
        await owned(db, userId, id);
        const secret = token();
        const row = await db.prepare('UPDATE parser_download SET token_hash=?,token_encrypted=?,updated_at=? WHERE id=? AND user_id=? RETURNING *')
            .bind(await hash(secret), await seal(secret, key), Date.now(), positiveId(id), userId).first();
        if (!row) throw new BizError('Download link not found', 404);
        return { ...view(row), path: `/parser-download/${secret}` };
    },
    async revoke(db, userId, id) {
        await owned(db, userId, id);
        await db.prepare('DELETE FROM parser_download WHERE id=? AND user_id=?').bind(positiveId(id), userId).run();
    },
    async download(db, secret, query) {
        if (!/^[a-f0-9]{64}$/.test(secret)) throw new BizError('Download link not found', 404);
        const row = await db.prepare(`SELECT d.* FROM parser_download d JOIN parser_config c ON c.id=d.parser_id AND c.user_id=d.user_id
            JOIN account a ON a.account_id=c.account_id AND a.user_id=c.user_id AND a.is_del=0 AND a.status=0
            JOIN user u ON u.user_id=c.user_id AND u.status=0 AND u.is_del=0 WHERE d.token_hash=?`).bind(await hash(secret)).first();
        if (!row) throw new BizError('Download link not found', 404);
        // The bearer URL fixes the rule set and output scope. Only pagination can
        // be chosen by the caller; query parameters cannot widen access.
        const options = view(row);
        const data = row.range_mode === 'legacy' ? await parserService.exportRows(db, row.user_id, { ...options, cursor: query.cursor }) : await parserService.downloadRows(db, row.user_id, options);
        return { data, options };
    }
};
