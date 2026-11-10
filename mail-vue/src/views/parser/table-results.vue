<template>
  <section v-for="(rows, key) in tables" :key="key" class="table-result">
    <h4>{{ key }} · {{ rows.length }}</h4>
    <el-table :data="rows" max-height="300" border style="width: 100%">
      <el-table-column v-for="column in Object.keys(rows[0] || {})" :key="column" :label="column" min-width="120">
        <template #default="{ row }">{{ row[column] }}</template>
      </el-table-column>
    </el-table>
  </section>
</template>
<script setup>
import { computed } from 'vue';
const props = defineProps({ data: { type: Object, default: null } });
const tables = computed(() => Object.fromEntries(Object.entries(props.data || {}).filter(([, value]) => Array.isArray(value))));
</script>
<style scoped>
.table-result { margin: 16px 0; min-width: 0; }
h4 { font-size: 14px; margin-bottom: 8px; }
</style>
