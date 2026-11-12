import http from '@/axios/index.js';

export const parserAccounts = () => http.get('/parser/accounts');
export const parserConfigs = accountId => http.get('/parser/configs', { params: { accountId } });
export const parserSave = config => config.id ? http.put(`/parser/configs/${config.id}`, config) : http.post('/parser/configs', config);
export const parserSamples = accountId => http.get('/parser/samples', { params: { accountId } });
export const parserPreview = payload => http.post('/parser/preview', payload);
export const parserEnqueue = (parserId, emailId) => http.post('/parser/enqueue', { parserId, emailId });
export const parserJobs = (parserId, cursor = 0) => http.get('/parser/jobs', { params: { parserId, cursor } });
export const parserJob = id => http.get(`/parser/jobs/${id}`);
export const parserRetry = (id, kind) => http.post(`/parser/jobs/${id}/retry`, { kind });
export const parserDownloadLinks = parserId => http.get('/parser/download-links', { params: { parserId } });
export const parserCreateDownload = payload => http.post('/parser/download-links', payload);
export const parserUpdateDownload = (id, payload) => http.put(`/parser/download-links/${id}`, payload);
export const parserRotateDownload = id => http.post(`/parser/download-links/${id}/rotate`);
export const parserRevokeDownload = id => http.delete(`/parser/download-links/${id}`);

export function parserDownloadUrl(path) {
    const base = (import.meta.env.VITE_BASE_URL || '').replace(/\/$/, '');
    return new URL(`${base}${path}`, window.location.origin).toString();
}

export async function parserDownload(parserId, format, cursor, tableField = '', size = 100, options = {}) {
    const url = new URL(parserDownloadUrl('/parser/export'));
    url.search = new URLSearchParams({ ...options, fields: (options.fields || []).join(','), parserId, format, cursor, tableField, size });
    return downloadResponse(url, format);
}

export function parserDownloadFile(options) {
    const url = new URL(parserDownloadUrl('/parser/download'));
    url.search = new URLSearchParams({ ...options, fields: (options.fields || []).join(',') });
    return downloadResponse(url, options.format);
}

async function downloadResponse(url, format) {
    const response = await fetch(url, { headers: { Authorization: localStorage.getItem('token') || '' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const filename = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1];
    if (response.headers.get('Content-Type')?.includes('text/csv')) {
        return { blob: await response.blob(), filename, nextCursor: response.headers.get('X-Next-Cursor'), hasMore: response.headers.get('X-Has-More') === 'true' };
    }
    const payload = await response.json();
    if (payload.code !== 200) throw new Error(payload.message);
    return { blob: new Blob([JSON.stringify(payload.data, null, 2)], { type: 'application/json' }), filename, ...payload.data };
}
