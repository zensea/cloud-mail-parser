<template>
  <div class="download-options">
    <el-form label-position="top" @submit.prevent>
      <div class="basic-options">
        <el-form-item :label="t('parser.downloadFormat')" :for="`${prefix}-format`">
          <el-select :id="`${prefix}-format`" v-model="form.format"><el-option label="CSV" value="csv" /><el-option label="JSON" value="json" /></el-select>
        </el-form-item>
        <el-form-item :label="t('parser.downloadRange')" :for="`${prefix}-range`">
          <el-select :id="`${prefix}-range`" v-model="form.range">
            <el-option v-for="range in ranges" :key="range" :value="range" :label="t(`parser.downloadRanges.${range}`)" />
          </el-select>
        </el-form-item>
      </div>
      <el-collapse v-model="advanced">
        <el-collapse-item name="options" :title="t(configured ? 'parser.downloadAdvancedSet' : 'parser.downloadAdvanced')">
          <el-form-item :label="t('parser.downloadFields')">
            <el-radio-group v-model="form.fieldMode" :aria-label="t('parser.downloadFields')">
              <el-radio value="all">{{ t('parser.downloadAllFields') }}</el-radio><el-radio value="selected">{{ t('parser.downloadSelectedFields') }}</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item v-if="form.fieldMode === 'selected'" :label="t('parser.downloadSelectedFields')" :for="`${prefix}-fields`">
            <el-select :id="`${prefix}-fields`" v-model="form.fields" multiple filterable allow-create default-first-option>
              <el-option v-for="rule in rules" :key="rule.key" :value="rule.key" :label="rule.key" />
            </el-select>
          </el-form-item>
          <el-form-item v-if="['custom', 'legacy'].includes(form.range)" :label="t('parser.downloadTimeRange')">
            <el-date-picker v-model="form.timeRange" type="datetimerange" value-format="x" :start-placeholder="t('parser.downloadFrom')" :end-placeholder="t('parser.downloadTo')" :aria-label="t('parser.downloadTimeRange')" />
          </el-form-item>
          <el-form-item v-if="form.format === 'csv' && tableRules.length" :label="t('parser.exportTable')" :for="`${prefix}-table`">
            <el-select :id="`${prefix}-table`" v-model="form.tableField" :empty-values="[null, undefined]">
              <el-option value="" :label="t('parser.exportPerEmail')" />
              <el-option v-for="rule in tableRules" :key="rule.key" :value="rule.key" :label="rule.key" />
            </el-select>
          </el-form-item>
        </el-collapse-item>
      </el-collapse>
    </el-form>
  </div>
</template>
<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
const props = defineProps({ modelValue: { type: Object, required: true }, rules: { type: Array, required: true }, prefix: { type: String, required: true } });
const { t } = useI18n();
const form = computed(() => props.modelValue), advanced = ref([]);
const ranges = computed(() => ['latest1', 'latest100', 'latest1000', 'today', 'last7days', 'all', 'custom', ...(form.value.range === 'legacy' ? ['legacy'] : [])]);
const tableRules = computed(() => props.rules.filter(rule => ['htmlTable', 'csvAttachment'].includes(rule.source)));
const configured = computed(() => form.value.fieldMode === 'selected' || (form.value.format === 'csv' && !!form.value.tableField) || ['custom', 'legacy'].includes(form.value.range));
watch(() => form.value.range, range => { if (['custom', 'legacy'].includes(range)) advanced.value = ['options']; }, { immediate: true });
watch([() => form.value.tableField, () => form.value.fieldMode], ([field, mode]) => {
  if (field && mode === 'selected' && !form.value.fields.includes(field)) form.value.fields.push(field);
});
</script>
<style scoped>
.basic-options { display: grid; grid-template-columns: minmax(100px, 1fr) minmax(180px, 2fr); gap: 16px; }
:deep(.el-date-editor) { width: 100%; max-width: 100%; min-width: 0; }
@media (max-width: 600px) { .basic-options { grid-template-columns: 1fr; gap: 0; } }
</style>
