import http from '@/axios/index.js';

export const parserAccounts = () => http.get('/parser/accounts');
export const parserConfigs = () => http.get('/parser/configs');
export const parserSave = config => config.id ? http.put(`/parser/configs/${config.id}`, config) : http.post('/parser/configs', config);
export const parserSamples = accountId => http.get('/parser/samples', { params: { accountId } });
export const parserPreview = payload => http.post('/parser/preview', payload);
export const parserEnqueue = (parserId, emailId) => http.post('/parser/enqueue', { parserId, emailId });
export const parserJobs = (parserId, cursor = 0) => http.get('/parser/jobs', { params: { parserId, cursor } });
export const parserJob = id => http.get(`/parser/jobs/${id}`);
export const parserRetry = (id, kind) => http.post(`/parser/jobs/${id}/retry`, { kind });

export async function parserDownload(parserId, format, cursor) {
    const base = (import.meta.env.VITE_BASE_URL || '').replace(/\/$/, '');
    const url = new URL(`${base}/parser/export`, window.location.origin);
    url.search = new URLSearchParams({ parserId, format, cursor });
    const response = await fetch(url, { headers: { Authorization: localStorage.getItem('token') || '' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (format === 'csv' && response.headers.get('Content-Type')?.includes('text/csv')) {
        return { blob: await response.blob(), nextCursor: response.headers.get('X-Next-Cursor'), hasMore: response.headers.get('X-Has-More') === 'true' };
    }
    const payload = await response.json();
    if (payload.code !== 200) throw new Error(payload.message);
    return { blob: new Blob([JSON.stringify(payload.data, null, 2)], { type: 'application/json' }), ...payload.data };
}
