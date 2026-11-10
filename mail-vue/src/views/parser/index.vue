<template>
  <div class="parser-page" v-loading="busy.loading">
    <div class="page-heading">
      <div><h1>{{ t('parser.title') }}</h1><p>{{ t('parser.description') }}</p></div>
      <el-button :loading="busy.loading" @click="reload">{{ t('parser.refresh') }}</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="message" />
    <el-empty v-if="!busy.loading && !accounts.length" :description="t('parser.noAccounts')" />
    <template v-if="accounts.length">
      <div class="mailbox-bar">
        <label for="parser-mailbox">{{ t('parser.mailbox') }}</label>
        <el-select id="parser-mailbox" :model-value="selectedAccount" filterable :disabled="busy.saving" @update:model-value="changeAccount">
          <el-option v-for="account in accounts" :key="account.accountId" :value="account.accountId" :label="account.email" />
        </el-select>
        <el-tag v-if="draft.id" type="info">v{{ draft.version }}</el-tag>
        <el-tag v-if="dirty" type="warning">{{ t('parser.unsaved') }}</el-tag>
      </div>
      <el-tabs v-model="activeTab">
        <el-tab-pane :label="t('parser.configuration')" name="configuration">
          <div class="workspace">
            <div class="editor-column">
              <el-form label-position="top" @submit.prevent="save">
                <el-form-item :label="t('parser.name')" for="parser-name">
                  <el-input id="parser-name" v-model="draft.name" maxlength="80" />
                </el-form-item>
                <el-form-item :label="t('parser.enabled')" for="parser-enabled">
                  <el-switch id="parser-enabled" v-model="draft.enabled" :aria-label="t('parser.enabled')" />
                  <p class="help">{{ t('parser.enabledHelp') }}</p>
                </el-form-item>
              </el-form>
              <rule-editor v-model="draft.rules" />
              <section class="delivery-settings" aria-labelledby="parser-webhook-heading">
                <h3 id="parser-webhook-heading">{{ t('parser.webhook') }}</h3>
                <p class="help">{{ t('parser.webhookHelp') }}</p>
                <el-form label-position="top">
                  <el-form-item :label="t('parser.webhookUrl')" for="parser-webhook-url">
                    <el-input id="parser-webhook-url" v-model="draft.webhookUrl" placeholder="https://" maxlength="2048" />
                  </el-form-item>
                  <el-form-item :label="t('parser.webhookSecret')" for="parser-webhook-secret">
                    <el-input id="parser-webhook-secret" v-model="draft.webhookSecret" type="password" show-password autocomplete="new-password" :placeholder="t('parser.secretPlaceholder')" maxlength="1024" />
                  </el-form-item>
                  <template v-if="draft.hasWebhookSecret">
                    <el-tag type="info">{{ t('parser.secretSet') }}</el-tag>
                    <el-checkbox v-model="draft.clearWebhookSecret" class="clear-secret">{{ t('parser.clearSecret') }}</el-checkbox>
                  </template>
                </el-form>
              </section>
              <div class="save-bar"><el-button type="primary" :loading="busy.saving" @click="save">{{ t('parser.save') }}</el-button></div>
            </div>
            <section class="preview-column" aria-labelledby="parser-preview-heading">
              <h3 id="parser-preview-heading">{{ t('parser.preview') }}</h3>
              <p class="help">{{ t('parser.sampleHelp') }}</p>
              <el-form label-position="top">
                <el-form-item :label="t('parser.sample')" for="parser-sample">
                  <el-select id="parser-sample" v-model="selectedSample" filterable @change="preview = null">
                    <el-option :value="0" :label="t('parser.custom')" />
                    <el-option v-for="sample in samples" :key="sample.emailId" :value="sample.emailId" :label="`#${sample.emailId} ${sample.subject || '—'}`" />
                  </el-select>
                </el-form-item>
                <template v-if="!selectedSample">
                  <el-form-item :label="t('parser.subject')" for="parser-sample-subject"><el-input id="parser-sample-subject" v-model="sampleInput.subject" /></el-form-item>
                  <el-form-item :label="t('parser.body')" for="parser-sample-body"><el-input id="parser-sample-body" v-model="sampleInput.text" type="textarea" :rows="7" /></el-form-item>
                  <el-collapse>
                    <el-collapse-item :title="t('parser.html')" name="sample-extra">
                      <el-input v-model="sampleInput.html" :aria-label="t('parser.html')" type="textarea" :rows="4" />
                      <el-input v-model="sampleInput.from" :aria-label="t('parser.from')" :placeholder="t('parser.from')" class="extra-input" />
                      <el-input v-model="sampleInput.to" :aria-label="t('parser.to')" :placeholder="t('parser.to')" class="extra-input" />
                    </el-collapse-item>
                  </el-collapse>
                </template>
              </el-form>
              <div class="preview-actions">
                <el-button type="primary" plain :loading="busy.previewing" @click="runPreview">{{ t('parser.runPreview') }}</el-button>
                <el-button :loading="busy.submitting" :disabled="!selectedSample || !draft.id || !draft.enabled || dirty" @click="submit">{{ t('parser.submit') }}</el-button>
              </div>
              <p class="help">{{ t('parser.submitHelp') }}</p>
              <template v-if="preview">
                <el-alert :title="t(preview.errors.length ? 'parser.previewInvalid' : 'parser.previewValid')" :type="preview.errors.length ? 'warning' : 'success'" :closable="false" show-icon />
                <h4>{{ t('parser.output') }}</h4>
                <pre class="json-output" aria-live="polite">{{ pretty(preview.data) }}</pre>
                <ul v-if="preview.errors.length" class="field-errors"><li v-for="item in preview.errors" :key="item.field">{{ item.field }}: {{ item.message }}</li></ul>
                <el-collapse>
                  <el-collapse-item :title="t('parser.steps')" name="steps">
                    <div v-for="field in preview.fields" :key="field.key" class="trace-field">
                      <strong>{{ field.key }}</strong>
                      <ol><li v-for="(step, index) in field.steps" :key="index"><span>{{ index }} · {{ step.type === 'source' ? t('parser.sourceStep') : t(`parser.types.${step.type}`) }}</span><pre>{{ step.value }}</pre></li></ol>
                    </div>
                  </el-collapse-item>
                </el-collapse>
              </template>
              <el-empty v-else :description="t('parser.emptyPreview')" :image-size="70" />
            </section>
          </div>
        </el-tab-pane>
        <el-tab-pane :label="t('parser.results')" name="results">
          <div class="results-toolbar">
            <el-button :disabled="!draft.id" :loading="busy.jobs" @click="loadJobs">{{ t('parser.refresh') }}</el-button>
            <el-button v-for="format in ['csv', 'json']" :key="format" :disabled="!draft.id" :loading="busy.exporting" @click="download(format)">
              {{ exportMore[format] ? t('parser.exportNext', { format: format.toUpperCase() }) : t(format === 'csv' ? 'parser.exportCsv' : 'parser.exportJson') }}
            </el-button>
          </div>
          <p class="help">{{ t('parser.exportHelp') }}</p>
          <el-table v-loading="busy.jobs" :data="jobs" :empty-text="t('parser.noJobs')" row-key="id" style="width: 100%">
            <el-table-column prop="id" :label="t('parser.id')" width="75" />
            <el-table-column prop="emailId" :label="t('parser.emailId')" width="100" />
            <el-table-column prop="version" :label="t('parser.version')" width="100" />
            <el-table-column :label="t('parser.state')" min-width="110"><template #default="{ row }"><el-tag :type="tagType(row.status)">{{ t(`parser.states.${row.status}`) }}</el-tag></template></el-table-column>
            <el-table-column :label="t('parser.delivery')" min-width="110"><template #default="{ row }"><el-tag :type="tagType(row.dispatchStatus)">{{ t(`parser.states.${row.dispatchStatus}`) }}</el-tag></template></el-table-column>
            <el-table-column :label="t('parser.output')" min-width="220"><template #default="{ row }"><pre class="result-summary">{{ row.error || pretty(row.data) }}</pre></template></el-table-column>
            <el-table-column :label="t('parser.detail')" width="100" fixed="right"><template #default="{ row }"><el-button size="small" @click="openJob(row.id)">{{ t('parser.detail') }}</el-button></template></el-table-column>
          </el-table>
          <div class="pagination">
            <el-button :disabled="!cursorStack.length || busy.jobs" @click="previousPage">{{ t('parser.previous') }}</el-button>
            <el-button :disabled="!hasMore || busy.jobs" @click="nextPage">{{ t('parser.next') }}</el-button>
            <el-button v-if="cursorStack.length" :disabled="busy.jobs" @click="firstPage">{{ t('parser.backToFirst') }}</el-button>
          </div>
        </el-tab-pane>
      </el-tabs>
    </template>
    <el-drawer v-model="drawerOpen" :title="`${t('parser.detail')} #${detail?.id || ''}`" size="min(640px, 100%)">
      <template v-if="detail">
        <el-descriptions :column="2" border>
          <el-descriptions-item :label="t('parser.emailId')">{{ detail.emailId }}</el-descriptions-item>
          <el-descriptions-item :label="t('parser.version')">{{ detail.version }}</el-descriptions-item>
          <el-descriptions-item :label="t('parser.state')">{{ t(`parser.states.${detail.status}`) }}</el-descriptions-item>
          <el-descriptions-item :label="t('parser.delivery')">{{ t(`parser.states.${detail.dispatchStatus}`) }}</el-descriptions-item>
          <el-descriptions-item v-if="detail.webhookUrl" :label="t('parser.webhookUrl')" :span="2">{{ detail.webhookUrl }}</el-descriptions-item>
        </el-descriptions>
        <p v-if="detail.error || detail.dispatchError" class="field-errors">{{ detail.error || detail.dispatchError }}</p>
        <ul class="field-errors"><li v-for="item in detail.errors" :key="item.field">{{ item.field }}: {{ item.message }}</li></ul>
        <h4>{{ t('parser.output') }}</h4><pre class="json-output">{{ pretty(detail.data) }}</pre>
        <div class="preview-actions">
          <el-button v-if="detail.status === 'failed'" :loading="busy.retrying" @click="retry('parse')">{{ t('parser.retryParse') }}</el-button>
          <el-button v-if="detail.dispatchStatus === 'failed'" :loading="busy.retrying" @click="retry('dispatch')">{{ t('parser.retryDispatch') }}</el-button>
        </div>
        <h4>{{ t('parser.deliveries') }}</h4>
        <el-table :data="detail.deliveries">
          <el-table-column prop="attempt" :label="t('parser.attempts')" width="95" />
          <el-table-column prop="statusCode" :label="t('parser.response')" width="100" />
          <el-table-column :label="t('parser.time')" width="170"><template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template></el-table-column>
          <el-table-column prop="error" :label="t('parser.error')" />
        </el-table>
        <el-collapse class="rules-detail"><el-collapse-item :title="t('parser.savedRules')" name="rules"><pre class="json-output">{{ pretty(detail.rules) }}</pre></el-collapse-item></el-collapse>
      </template>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAccountStore } from '@/store/account.js';
import RuleEditor from './rule-editor.vue';
import { parserAccounts, parserConfigs, parserSave, parserSamples, parserPreview, parserEnqueue, parserJobs, parserJob, parserRetry, parserDownload } from '@/request/parser.js';

const { t } = useI18n();
const accounts = ref([]), configs = ref([]), selectedAccount = ref(0), selectedSample = ref(0), samples = ref([]);
const activeTab = ref('configuration'), draft = ref({ rules: [] }), baseline = ref(''), preview = ref(null), error = ref('');
const busy = reactive({ loading: false, saving: false, previewing: false, submitting: false, jobs: false, exporting: false, retrying: false });
const jobs = ref([]), cursor = ref(0), nextCursor = ref(0), cursorStack = ref([]), hasMore = ref(false);
const drawerOpen = ref(false), detail = ref(null);
const exportCursor = reactive({ csv: '0_0', json: '0_0' }), exportMore = reactive({ csv: false, json: false });
const sampleInput = reactive({ subject: 'Order A-100', text: t('parser.sampleOrder'), html: '', from: '', to: '' });
const dirty = computed(() => baseline.value && JSON.stringify(draft.value) !== baseline.value);
let poll;
const pretty = value => value == null ? '—' : JSON.stringify(value, null, 2);
const tagType = status => ({ parsed: 'success', sent: 'success', failed: 'danger', none: 'info' }[status] || 'warning');

async function run(key, action) {
  if (busy[key]) return;
  busy[key] = true; error.value = '';
  try { return await action(); }
  catch (reason) { error.value = reason.message || t('parser.loadFailed'); }
  finally { busy[key] = false; }
}
async function confirmDiscard() {
  if (!dirty.value) return true;
  try { await ElMessageBox.confirm(t('parser.leave'), t('parser.unsaved'), { confirmButtonText: t('parser.confirm'), cancelButtonText: t('parser.cancel'), type: 'warning' }); return true; }
  catch { return false; }
}
function resetExports() { for (const format of ['csv', 'json']) { exportCursor[format] = '0_0'; exportMore[format] = false; } }
async function selectAccount(accountId) {
  selectedAccount.value = accountId;
  const saved = configs.value.find(config => config.accountId === accountId);
  draft.value = saved ? { ...JSON.parse(JSON.stringify(saved)), webhookSecret: '', clearWebhookSecret: false } : {
    accountId, name: t('parser.defaultName'), enabled: false, webhookUrl: '', webhookSecret: '', clearWebhookSecret: false,
    rules: [{ key: 'order_id', source: 'text', required: true, filters: [{ type: 'regex', pattern: '(?:订单号|Order ID): ([A-Z0-9-]+)', flags: 'm', group: 1 }] }]
  };
  baseline.value = JSON.stringify(draft.value);
  preview.value = null; selectedSample.value = 0; jobs.value = []; cursor.value = 0; cursorStack.value = []; hasMore.value = false;
  resetExports();
  samples.value = await parserSamples(accountId);
  if (draft.value.id) await loadJobs();
}
async function changeAccount(accountId) {
  if (await confirmDiscard()) await run('loading', () => selectAccount(accountId));
}
async function reload() {
  if (!await confirmDiscard()) return;
  await run('loading', async () => {
    [accounts.value, configs.value] = await Promise.all([parserAccounts(), parserConfigs()]);
    const desired = selectedAccount.value || useAccountStore().currentAccountId;
    const account = accounts.value.find(item => item.accountId === desired) || accounts.value[0];
    if (account) await selectAccount(account.accountId);
  });
}
async function save() {
  await run('saving', async () => {
    const saved = await parserSave(draft.value);
    configs.value = [...configs.value.filter(config => config.id !== saved.id), saved];
    draft.value = { ...saved, webhookSecret: '', clearWebhookSecret: false };
    baseline.value = JSON.stringify(draft.value);
    resetExports();
    ElMessage.success(t('parser.saved'));
  });
}
async function runPreview() {
  await run('previewing', async () => {
    const payload = JSON.stringify(previewPayload());
    const result = await parserPreview(JSON.parse(payload));
    if (payload === JSON.stringify(previewPayload())) preview.value = result;
  });
}
function previewPayload() {
  return { accountId: selectedAccount.value, rules: draft.value.rules,
    ...(selectedSample.value ? { emailId: selectedSample.value } : { sample: sampleInput }) };
}
async function submit() {
  await run('submitting', async () => {
    await parserEnqueue(draft.value.id, selectedSample.value);
    cursor.value = 0; cursorStack.value = [];
    activeTab.value = 'results';
    await loadJobs();
    ElMessage.success(t('parser.submitted'));
  });
}
async function loadJobs() {
  if (!draft.value.id) return;
  await run('jobs', async () => {
    const data = await parserJobs(draft.value.id, cursor.value);
    jobs.value = data.rows; hasMore.value = data.hasMore; nextCursor.value = data.nextCursor;
  });
}
async function nextPage() { cursorStack.value.push(cursor.value); cursor.value = nextCursor.value; await loadJobs(); }
async function previousPage() { cursor.value = cursorStack.value.pop() || 0; await loadJobs(); }
async function firstPage() { cursor.value = 0; cursorStack.value = []; await loadJobs(); }
async function openJob(id) { await run('detail', async () => { detail.value = await parserJob(id); drawerOpen.value = true; }); }
async function retry(kind) {
  await run('retrying', async () => {
    await parserRetry(detail.value.id, kind);
    detail.value = await parserJob(detail.value.id);
    await loadJobs();
    ElMessage.success(t('parser.retried'));
  });
}
async function download(format) {
  await run('exporting', async () => {
    const data = await parserDownload(draft.value.id, format, exportCursor[format]);
    const url = URL.createObjectURL(data.blob);
    const link = document.createElement('a');
    link.href = url; link.download = `parsed-emails-${Date.now()}.${format}`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    exportCursor[format] = data.hasMore ? data.nextCursor : '0_0';
    exportMore[format] = data.hasMore;
  });
}
watch(activeTab, tab => { if (tab === 'results') loadJobs(); });
watch([() => draft.value.rules, selectedSample, sampleInput], () => { preview.value = null; }, { deep: true });
onBeforeRouteLeave(confirmDiscard);
onMounted(() => {
  reload();
  poll = setInterval(() => {
    if (activeTab.value === 'results' && draft.value.id) loadJobs();
  }, 5000);
});
onBeforeUnmount(() => clearInterval(poll));
</script>

<style scoped>
.parser-page { height: 100%; overflow: auto; min-width: 0; padding: 24px; }
.page-heading { display: flex; justify-content: space-between; align-items: start; gap: 16px; margin-bottom: 24px; }
h1 { font-size: 24px; line-height: 1.3; font-weight: 600; }
.page-heading p, .help { color: var(--el-text-color-secondary); font-size: 13px; margin: 8px 0 16px; }
.page-heading p { margin-bottom: 0; }
.message { margin-bottom: 16px; }
.mailbox-bar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 20px; }
.mailbox-bar > .el-select { width: min(360px, 100%); }
.mailbox-bar label { font-weight: 500; }
.workspace { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(300px, 0.8fr); gap: 28px; align-items: start; }
.editor-column, .preview-column { min-width: 0; }
.preview-column { padding: 20px; background: var(--el-fill-color-blank); border: 1px solid var(--el-border-color); border-radius: 8px; }
h3 { font-size: 16px; font-weight: 600; }
h4 { font-size: 14px; font-weight: 600; margin: 20px 0 10px; }
.delivery-settings { margin-top: 28px; padding-top: 24px; border-top: 1px solid var(--el-border-color); }
.clear-secret { margin-left: 12px; }
.save-bar { margin: 20px 0 28px; }
.preview-actions, .results-toolbar, .pagination { display: flex; gap: 10px; flex-wrap: wrap; margin: 16px 0; }
.preview-actions .el-button + .el-button, .results-toolbar .el-button + .el-button, .pagination .el-button + .el-button { margin-left: 0; }
.extra-input { margin-top: 10px; }
.json-output, .trace-field pre { padding: 12px; border-radius: 6px; background: var(--el-fill-color-light); white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.6 ui-monospace, Consolas, monospace; max-height: 350px; overflow: auto; }
.field-errors { color: var(--el-color-danger); font-size: 13px; margin: 12px 0; overflow-wrap: anywhere; }
.trace-field { margin: 14px 0; }
.trace-field li { margin-top: 10px; }
.trace-field span { color: var(--el-text-color-secondary); font-size: 12px; }
.result-summary { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 80px; overflow: auto; font: 12px/1.5 ui-monospace, Consolas, monospace; }
.rules-detail { margin-top: 24px; }
@media (max-width: 1100px) { .workspace { grid-template-columns: 1fr; } }
@media (max-width: 600px) { .parser-page { padding: 16px; } h1 { font-size: 21px; } .preview-column { padding: 14px; } .mailbox-bar > .el-select { width: 100%; } }
</style>
