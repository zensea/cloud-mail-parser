<template>
  <section class="download-panel" v-loading="busy">
    <h3>{{ t('parser.manualDownload') }}</h3>
    <p class="help">{{ t('parser.downloadScopeHelp') }}</p>
    <download-options :model-value="manual" :rules="rules" prefix="manual-download" />
    <el-button type="primary" class="download-button" @click="downloadManual">{{ t('parser.downloadNow') }}</el-button>
    <div class="section-heading"><h3>{{ t('parser.fixedDownloadLinks') }}</h3><el-button @click="openEditor()">{{ t('parser.createDownloadLink') }}</el-button></div>
    <p class="help">{{ t('parser.downloadLinkHelp') }}</p>
    <el-empty v-if="!links.length" :description="t('parser.noDownloadLinks')" :image-size="60" />
    <article v-for="link in links" :key="link.id" class="download-link">
      <div><strong>{{ link.name }}</strong> <el-tag size="small">{{ link.format.toUpperCase() }}</el-tag></div>
      <p class="help">{{ t(`parser.downloadRanges.${link.range}`) }} · {{ link.fields.length ? link.fields.join(', ') : t('parser.downloadAllFields') }}</p>
      <div class="actions">
        <el-button size="small" @click="downloadSaved(link)">{{ t('parser.downloadNow') }}</el-button>
        <el-button size="small" @click="copyLink(link)">{{ t('parser.copyDownloadLink') }}</el-button>
        <el-button size="small" @click="openEditor(link)">{{ t('parser.editDownloadLink') }}</el-button>
        <el-button size="small" type="danger" plain @click="revokeLink(link)">{{ t('parser.revokeDownloadLink') }}</el-button>
        <el-button size="small" text @click="rotateLink(link)">{{ t('parser.rotateDownloadLink') }}</el-button>
      </div>
    </article>
    <el-dialog v-model="showEditor" :title="t(editingId ? 'parser.editDownloadLink' : 'parser.createDownloadLink')" width="min(640px, 94vw)" :close-on-click-modal="!busy" :show-close="!busy">
      <el-form label-position="top" @submit.prevent="saveLink"><el-form-item :label="t('parser.downloadName')" for="download-name"><el-input id="download-name" v-model="editor.name" maxlength="80" /></el-form-item></el-form>
      <download-options v-if="showEditor" :model-value="editor" :key="editorKey" :rules="rules" prefix="link-download" />
      <template #footer><el-button :disabled="busy" @click="showEditor = false">{{ t('parser.cancel') }}</el-button><el-button type="primary" :loading="busy" @click="saveLink">{{ t('parser.saveDownloadLink') }}</el-button></template>
    </el-dialog>
    <el-dialog v-model="showUrl" :title="t('parser.copyDownloadLink')" width="min(640px, 94vw)" @closed="freshUrl = ''"><el-input v-model="freshUrl" readonly type="textarea" :rows="3" :aria-label="t('parser.downloadUrl')" /><p>{{ t('parser.downloadCopyManually') }}</p></el-dialog>
  </section>
</template>
<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import DownloadOptions from './download-options.vue';
import { parserDownloadFile, parserDownloadLinks, parserCreateDownload, parserUpdateDownload, parserRotateDownload, parserRevokeDownload, parserDownloadUrl } from '@/request/parser.js';
const props = defineProps({ parserId: { type: Number, required: true }, rules: { type: Array, required: true } });
const emit = defineEmits(['busy']);
const { t } = useI18n();
const defaults = () => ({ name: '', format: 'csv', range: 'latest100', fieldMode: 'all', fields: [], timeRange: null, tableField: '', timezoneOffset: new Date().getTimezoneOffset() });
const manual = reactive(defaults()), editor = reactive(defaults());
const busy = ref(false), links = ref([]), showEditor = ref(false), editingId = ref(0), editorKey = ref(0), showUrl = ref(false), freshUrl = ref('');
function payload(form) {
  if (form.fieldMode === 'selected' && !form.fields.length) throw new Error(t('parser.downloadChooseFields'));
  return { parserId: props.parserId, name: form.name, format: form.format, range: form.range, timezoneOffset: form.timezoneOffset,
    fields: form.fieldMode === 'selected' ? [...form.fields] : [], fromTime: form.timeRange?.[0] || 0, toTime: form.timeRange?.[1] || 0,
    tableField: form.format === 'csv' ? form.tableField : '' };
}
async function run(action) {
  if (busy.value) return;
  busy.value = true; emit('busy', true);
  try { await action(); } catch (error) { ElMessage.error(error.message || t('parser.loadFailed')); }
  finally { busy.value = false; emit('busy', false); }
}
const loadLinks = async () => { links.value = await parserDownloadLinks(props.parserId); };
function openEditor(link) {
  editingId.value = link?.id || 0; editorKey.value++;
  Object.assign(editor, defaults(), link ? { name: link.name, format: link.format, range: link.range, fields: [...link.fields],
    fieldMode: link.fields.length ? 'selected' : 'all', tableField: link.tableField, timezoneOffset: link.timezoneOffset,
    timeRange: link.fromTime || link.toTime ? [link.fromTime || 0, link.toTime || Date.now()] : null } : {});
  showEditor.value = true;
}
async function saveLink() {
  await run(async () => {
    const options = payload(editor);
    if (editingId.value) await parserUpdateDownload(editingId.value, options);
    else await parserCreateDownload(options);
    showEditor.value = false; await loadLinks();
  });
}
async function confirm(message, title) {
  try { await ElMessageBox.confirm(t(message), t(title), { confirmButtonText: t('parser.confirm'), cancelButtonText: t('parser.cancel') }); return true; } catch { return false; }
}
async function rotateLink(link) {
  if (!await confirm('parser.rotateDownloadConfirm', 'parser.rotateDownloadLink')) return;
  await run(async () => { await parserRotateDownload(link.id); await loadLinks(); ElMessage.success(t('parser.downloadLinkUpdated')); });
}
async function revokeLink(link) {
  if (!await confirm('parser.revokeDownloadConfirm', 'parser.revokeDownloadLink')) return;
  await run(async () => { await parserRevokeDownload(link.id); await loadLinks(); });
}
async function copyLink(link) {
  if (!link.path) {
    if (!await confirm('parser.downloadRecoverLink', 'parser.rotateDownloadLink')) return;
    await run(async () => { const renewed = await parserRotateDownload(link.id); await loadLinks(); await copyUrl(renewed.path); });
  } else await copyUrl(link.path);
}
async function copyUrl(path) {
  const url = parserDownloadUrl(path);
  try { await navigator.clipboard.writeText(url); ElMessage.success(t('parser.downloadCopied')); }
  catch { freshUrl.value = url; showUrl.value = true; }
}
async function saveFile(options) {
  const data = await parserDownloadFile(options);
  const url = URL.createObjectURL(data.blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = data.filename || `parsed-emails-${props.parserId}-${Date.now()}.${options.format}`;
  document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function downloadManual() { await run(() => saveFile(payload(manual))); }
async function downloadSaved(link) { await run(() => saveFile({ downloadId: link.id, format: link.format })); }
onMounted(() => run(loadLinks));
</script>
<style scoped>
.download-panel { max-width: 840px; min-width: 0; }
h3 { font-size: 16px; font-weight: 600; margin: 12px 0; }
.help { color: var(--el-text-color-secondary); font-size: 13px; margin: 10px 0 16px; overflow-wrap: anywhere; }
.download-button { margin-top: 16px; }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 32px; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; }
.actions .el-button + .el-button { margin-left: 0; }
.download-link { border: 1px solid var(--el-border-color); border-radius: 8px; padding: 14px; margin-top: 12px; }
</style>
