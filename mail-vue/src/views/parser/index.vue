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
        <el-select id="parser-mailbox" :model-value="selectedAccount" filterable :disabled="changingRuleBlocked" @update:model-value="changeAccount">
          <el-option v-for="account in accounts" :key="account.accountId" :value="account.accountId" :label="account.email" />
        </el-select>
        <label for="parser-config">{{ t('parser.ruleSet') }}</label>
        <el-select id="parser-config" :model-value="draft.id || 0" filterable :disabled="changingRuleBlocked" @update:model-value="changeRuleSet">
          <el-option v-if="!draft.id" :value="0" :label="t('parser.newRuleSet')" />
          <el-option v-for="config in configs" :key="config.id" :value="config.id" :label="`#${config.id} ${config.name}`" />
        </el-select>
        <el-button :disabled="changingRuleBlocked" @click="newRuleSet">{{ t('parser.addRuleSet') }}</el-button>
        <el-tag v-if="draft.id" type="info">v{{ draft.version }}</el-tag>
        <el-tag v-if="dirty" type="warning">{{ t('parser.unsaved') }}</el-tag>
      </div>
      <p class="help">{{ t('parser.ruleSetHelp') }}</p>
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
                <el-form-item :label="t('parser.retentionDays')" for="parser-retention">
                  <el-input-number id="parser-retention" v-model="draft.retentionDays" :min="0" :max="60" :precision="0" />
                  <p class="help">{{ t('parser.retentionHelp') }}</p>
                </el-form-item>
              </el-form>
              <condition-editor v-model="draft.conditions" />
              <rule-editor v-model="draft.rules" :attachment-names="attachmentNames" />
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
                  <el-form-item :label="t('parser.from')" for="parser-sample-from"><el-input id="parser-sample-from" v-model="sampleInput.from" /></el-form-item>
                  <el-form-item :label="t('parser.to')" for="parser-sample-to"><el-input id="parser-sample-to" v-model="sampleInput.to" /></el-form-item>
                  <el-form-item :label="t('parser.body')" for="parser-sample-body"><el-input id="parser-sample-body" v-model="sampleInput.text" type="textarea" :rows="7" /></el-form-item>
                  <template v-if="hasCsvRule">
                    <el-form-item :label="t('parser.sampleCsvName')" for="parser-csv-name"><el-input id="parser-csv-name" v-model="sampleCsv.name" maxlength="255" /></el-form-item>
                    <el-form-item :label="t('parser.sampleCsvText')" for="parser-csv-text"><el-input id="parser-csv-text" v-model="sampleCsv.text" type="textarea" :rows="5" /></el-form-item>
                  </template>
                  <el-collapse>
                    <el-collapse-item :title="t('parser.html')" name="sample-extra">
                      <el-input v-model="sampleInput.html" :aria-label="t('parser.html')" type="textarea" :rows="4" />
                    </el-collapse-item>
                  </el-collapse>
                </template>
                <p v-else class="help">{{ t('parser.csvFiles') }}: {{ attachmentNames.join(', ') || t('parser.unavailable') }}</p>
              </el-form>
              <div class="preview-actions">
                <el-button type="primary" plain :loading="busy.previewing" @click="runPreview">{{ t('parser.runPreview') }}</el-button>
                <el-button :loading="busy.submitting" :disabled="!selectedSample || !draft.id || !draft.enabled || dirty || preview?.match?.matched === false" @click="submit">{{ t('parser.submit') }}</el-button>
              </div>
              <p class="help">{{ t('parser.submitHelp') }}</p>
              <template v-if="preview">
                <template v-if="preview.match && draft.conditions.length">
                  <el-alert :title="t(preview.match.matched ? 'parser.matchPassed' : 'parser.matchSkipped')" :type="preview.match.matched ? 'success' : 'info'" :closable="false" show-icon />
                  <ul class="match-checks"><li v-for="check in preview.match.checks" :key="check.index">
                    {{ check.matched ? '✓' : '✕' }} {{ check.source === 'to' ? t('parser.deliveryAddress') : t(`parser.sources.${check.source}`) }} · {{ t(`parser.matchOperators.${check.operator}`) }}: {{ draft.conditions[check.index]?.value }}
                  </li></ul>
                </template>
                <template v-if="preview.match?.matched !== false">
                <el-alert :title="t(preview.errors.length ? 'parser.previewInvalid' : 'parser.previewValid')" :type="preview.errors.length ? 'warning' : 'success'" :closable="false" show-icon />
                <table-results :data="preview.data" />
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
              </template>
              <el-empty v-else :description="t('parser.emptyPreview')" :image-size="70" />
            </section>
          </div>
        </el-tab-pane>
        <el-tab-pane :label="t('parser.results')" name="results">
          <div class="results-toolbar">
            <label for="parser-export-field">{{ t('parser.exportTable') }}</label>
            <el-select id="parser-export-field" v-model="exportTableField" :empty-values="[null, undefined]" :disabled="busy.exporting" :aria-label="t('parser.exportTable')" style="width: 200px">
              <el-option value="" :label="t('parser.exportPerEmail')" />
              <el-option v-for="field in exportTables" :key="field.key" :value="field.key" :label="field.key" />
            </el-select>
            <label for="parser-export-size">{{ t('parser.exportSize') }}</label>
            <el-input-number id="parser-export-size" v-model="exportBatchSize" :disabled="busy.exporting" :min="1" :max="exportTableField ? 10 : 100" :precision="0" />
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
        <p v-if="detail.status === 'expired'" class="help">{{ t('parser.expiredHelp') }}</p>
        <table-results :data="detail.data" />
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
import ConditionEditor from './condition-editor.vue';
import TableResults from './table-results.vue';
import { parserAccounts, parserConfigs, parserSave, parserSamples, parserPreview, parserEnqueue, parserJobs, parserJob, parserRetry, parserDownload } from '@/request/parser.js';

const { t } = useI18n();
const accounts = ref([]), configs = ref([]), selectedAccount = ref(0), selectedSample = ref(0), samples = ref([]);
const activeTab = ref('configuration'), draft = ref({ rules: [], conditions: [] }), baseline = ref(''), preview = ref(null), error = ref('');
const busy = reactive({ loading: false, saving: false, previewing: false, submitting: false, jobs: false, exporting: false, retrying: false });
const jobs = ref([]), cursor = ref(0), nextCursor = ref(0), cursorStack = ref([]), hasMore = ref(false);
const drawerOpen = ref(false), detail = ref(null);
const exportCursor = reactive({ csv: '0_0', json: '0_0' }), exportMore = reactive({ csv: false, json: false });
const sampleInput = reactive({ subject: 'Order A-100', text: t('parser.sampleOrder'), html: '', from: '', to: '' });
const sampleCsv = reactive({ name: 'orders.csv', text: 'item,quantity\nWidget,2\nCable,3' });
const hasCsvRule = computed(() => draft.value.rules.some(rule => rule.source === 'csvAttachment'));
const attachmentNames = computed(() => selectedSample.value ? samples.value.find(sample => sample.emailId === selectedSample.value)?.attachmentNames || [] : [sampleCsv.name].filter(Boolean));
const exportTableField = ref('');
const exportBatchSize = ref(100);
const exportTables = computed(() => configs.value.find(config => config.id === draft.value.id)?.rules.filter(rule => ['htmlTable', 'csvAttachment'].includes(rule.source)) || []);
const dirty = computed(() => baseline.value && JSON.stringify(draft.value) !== baseline.value);
const changingRuleBlocked = computed(() => busy.loading || busy.saving || busy.exporting || busy.submitting || busy.retrying || busy.detail);
let jobRequest = 0;
let jobContext = '';
let poll;
const pretty = value => value == null ? '—' : JSON.stringify(value, null, 2);
const tagType = status => ({ parsed: 'success', sent: 'success', failed: 'danger', none: 'info', expired: 'info' }[status] || 'warning');

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
async function selectRuleSet(saved) {
  draft.value = saved ? { ...JSON.parse(JSON.stringify(saved)), webhookSecret: '', clearWebhookSecret: false } : {
    accountId: selectedAccount.value, name: `${t('parser.defaultName')}${configs.value.length ? ` ${configs.value.length + 1}` : ''}`, enabled: false, retentionDays: 30, conditions: [], webhookUrl: '', webhookSecret: '', clearWebhookSecret: false,
    rules: [{ key: 'order_id', source: 'text', required: true, filters: [{ type: 'regex', pattern: '(?:订单号|Order ID): ([A-Z0-9-]+)', flags: 'm', group: 1 }] }]
  };
  baseline.value = JSON.stringify(draft.value);
  preview.value = null; jobs.value = []; cursor.value = 0; cursorStack.value = []; hasMore.value = false;
  detail.value = null; drawerOpen.value = false; jobRequest++; busy.jobs = false;
  exportTableField.value = ''; resetExports();
  if (draft.value.id) await loadJobs();
  else activeTab.value = 'configuration';
}
async function selectAccount(accountId, parserId = 0) {
  const [mailboxConfigs, mailboxSamples] = await Promise.all([parserConfigs(accountId), parserSamples(accountId)]);
  selectedAccount.value = accountId; selectedSample.value = 0;
  configs.value = mailboxConfigs; samples.value = mailboxSamples;
  await selectRuleSet(configs.value.find(config => config.id === parserId) || configs.value[0]);
}
async function changeAccount(accountId) {
  if (await confirmDiscard()) await run('loading', () => selectAccount(accountId));
}
async function changeRuleSet(id) {
  if (id === (draft.value.id || 0)) return;
  if (await confirmDiscard()) await run('loading', () => selectRuleSet(configs.value.find(config => config.id === id)));
}
async function newRuleSet() {
  if (await confirmDiscard()) await run('loading', () => selectRuleSet(null));
}
async function reload() {
  if (!await confirmDiscard()) return;
  await run('loading', async () => {
    accounts.value = await parserAccounts();
    const desired = selectedAccount.value || useAccountStore().currentAccountId;
    const account = accounts.value.find(item => item.accountId === desired) || accounts.value[0];
    if (account) await selectAccount(account.accountId, draft.value.id);
  });
}
async function save() {
  await run('saving', async () => {
    const saved = await parserSave(draft.value);
    configs.value = [saved, ...configs.value.filter(config => config.id !== saved.id)].sort((a, b) => b.id - a.id);
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
  return { accountId: selectedAccount.value, parserId: draft.value.id || 0, rules: draft.value.rules, conditions: draft.value.conditions,
    ...(selectedSample.value ? { emailId: selectedSample.value } : { sample: { ...sampleInput, attachments: hasCsvRule.value ? [sampleCsv] : [] } }) };
}
async function submit() {
  await run('submitting', async () => {
    const result = await parserEnqueue(draft.value.id, selectedSample.value);
    if (result.matched === false) { ElMessage.info(t('parser.notSubmitted')); return; }
    cursor.value = 0; cursorStack.value = [];
    activeTab.value = 'results';
    await loadJobs();
    ElMessage.success(t('parser.submitted'));
  });
}
async function loadJobs() {
  const parserId = draft.value.id, pageCursor = cursor.value;
  if (!parserId) return;
  const context = `${parserId}:${pageCursor}`;
  if (busy.jobs && jobContext === context) return;
  jobContext = context;
  const request = ++jobRequest;
  busy.jobs = true;
  try {
    const data = await parserJobs(parserId, pageCursor);
    if (request !== jobRequest || draft.value.id !== parserId || cursor.value !== pageCursor) return;
    jobs.value = data.rows; hasMore.value = data.hasMore; nextCursor.value = data.nextCursor;
  } catch (reason) { if (request === jobRequest) error.value = reason.message || t('parser.loadFailed'); }
  finally { if (request === jobRequest) busy.jobs = false; }
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
    const data = await parserDownload(draft.value.id, format, exportCursor[format], format === 'csv' ? exportTableField.value : '', exportBatchSize.value);
    const url = URL.createObjectURL(data.blob);
    const link = document.createElement('a');
    link.href = url; link.download = `parsed-emails-${draft.value.id}-${Date.now()}.${format}`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    exportCursor[format] = data.hasMore ? data.nextCursor : '0_0';
    exportMore[format] = data.hasMore;
  });
}
watch(activeTab, tab => { if (tab === 'results') loadJobs(); });
watch([() => draft.value.rules, () => draft.value.conditions, selectedSample, sampleInput, sampleCsv], () => { preview.value = null; }, { deep: true });
watch(exportTableField, value => { exportBatchSize.value = Math.min(exportBatchSize.value || 100, value ? 10 : 100); exportCursor.csv = '0_0'; exportMore.csv = false; });
watch(exportTables, tables => { if (!tables.some(field => field.key === exportTableField.value)) exportTableField.value = ''; });
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
.match-checks { font-size: 13px; margin: 12px 0; overflow-wrap: anywhere; }
.trace-field { margin: 14px 0; }
.trace-field li { margin-top: 10px; }
.trace-field span { color: var(--el-text-color-secondary); font-size: 12px; }
.result-summary { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 80px; overflow: auto; font: 12px/1.5 ui-monospace, Consolas, monospace; }
.rules-detail { margin-top: 24px; }
@media (max-width: 1100px) { .workspace { grid-template-columns: 1fr; } }
@media (max-width: 600px) { .parser-page { padding: 16px; } h1 { font-size: 21px; } .preview-column { padding: 14px; } .mailbox-bar > .el-select { width: 100%; } }
</style>
