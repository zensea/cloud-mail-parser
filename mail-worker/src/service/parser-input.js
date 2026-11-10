import { emailInput, validateRules } from '../lib/parser-engine';
import r2Service from './r2-service';
import BizError from '../error/biz-error';

const CSV_BYTES = 65536;

function decode(bytes) {
    if (bytes.byteLength > CSV_BYTES) throw new Error('CSV attachment exceeds 64 KiB');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('CSV attachments must use UTF-8 encoding'); }
}

async function storedCsv(env, file) {
    if (file.size > CSV_BYTES) throw new Error('CSV attachment exceeds 64 KiB');
    let reader;
    try {
        const object = await r2Service.getObj({ env }, file.key);
        if (!object || object.ok === false || !object.body) throw new Error('Unavailable');
        reader = object.body.getReader();
        const chunks = [];
        let length = 0;
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > CSV_BYTES) {
                await reader.cancel();
                throw new BizError('CSV attachment exceeds 64 KiB', 400);
            }
            chunks.push(value);
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return decode(bytes);
    } catch (error) {
        if (error.code === 400 || error.message === 'CSV attachments must use UTF-8 encoding') throw error;
        throw new BizError('CSV storage temporarily unavailable; retry later', 503);
    } finally { reader?.releaseLock(); }
}

// Storage keys come exclusively from owned email metadata, never from request input.
export async function readEmailInput(db, row, rules, { env, attachments } = {}) {
    const names = [...new Set(validateRules(rules).filter(rule => rule.source === 'csvAttachment').map(rule => rule.options.attachmentName))];
    if (names.length > 5) throw new Error('Use at most 5 CSV attachments per email');
    const files = [];
    if (names.length) {
        const metadata = attachments ?? (await db.prepare(`SELECT filename, key, size FROM attachments
            WHERE email_id=? AND user_id=? AND account_id=? AND type=0 AND content_id IS NULL`)
            .bind(row.email_id ?? row.emailId, row.user_id ?? row.userId, row.account_id ?? row.accountId).all()).results;
        for (const name of names) {
            const matches = metadata.filter(file => file.filename === name && !file.contentId);
            if (matches.length > 1) throw new Error('CSV attachment name is ambiguous');
            if (!matches.length) continue; // Required fields report missing files through normal validation.
            const file = matches[0];
            files.push({ name, text: attachments ? decode(file.content) : await storedCsv(env, file) });
        }
    }
    return emailInput({ subject: row.subject, text: row.text, content: row.content,
        sendEmail: row.send_email ?? row.sendEmail, toEmail: row.to_email ?? row.toEmail, attachments: files });
}
