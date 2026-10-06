<script setup lang="ts">
import { mdiFitToScreenOutline, mdiRefresh, mdiSitemapOutline } from '@mdi/js';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AgentPanel from '../components/org/AgentPanel.vue';
import OrgCanvas from '../components/org/OrgCanvas.vue';
import { useLiveStore } from '../stores/live';
import { useOrgGraphStore } from '../stores/orgGraph';

const org = useOrgGraphStore();
const live = useLiveStore();
const canvas = ref<InstanceType<typeof OrgCanvas> | null>(null);
const selected = ref<string | null>(null);
const confirmArrange = ref(false);
const loadError = ref('');
let unsubscribe: (() => void) | null = null;

const snackbar = computed({
  /** Show the snackbar while the organization store has a notice. */
  get: () => org.notice !== null,
  /** Clear the notice when the snackbar is dismissed. */
  set: (open) => {
    if (!open) org.notice = null;
  },
});

/** Reload the graph and expose load failures in the view alert. */
async function load(): Promise<void> {
  loadError.value = '';
  try {
    await org.load();
  } catch (cause) {
    loadError.value = cause instanceof Error ? cause.message : String(cause);
  }
}

/** Dismiss confirmation, arrange the graph, and fit the resulting positions into view. */
async function arrange(): Promise<void> {
  confirmArrange.value = false;
  await org.arrangeAll();
  await canvas.value?.fit();
}

onMounted(() => {
  unsubscribe = live.subscribe((type, data) => {
    org.applyEvent(type, data);
  });
  void load();
});

onBeforeUnmount(() => {
  unsubscribe?.();
  void org.flushLayout();
});
</script>

<template>
  <div class="org-view d-flex flex-column">
    <div class="d-flex align-center flex-wrap ga-2 pa-2 flex-0-0">
      <div class="text-h6 mr-2">Org chart</div>
      <v-btn :prepend-icon="mdiSitemapOutline" variant="tonal" @click="confirmArrange = true">
        Auto-arrange
      </v-btn>
      <v-btn :prepend-icon="mdiFitToScreenOutline" variant="text" @click="canvas?.fit()">
        Fit view
      </v-btn>
      <v-btn :prepend-icon="mdiRefresh" variant="text" @click="load">Reload</v-btn>
    </div>
    <v-alert
      v-if="loadError"
      type="error"
      variant="tonal"
      density="compact"
      class="mx-2 mb-2 flex-0-0"
    >
      {{ loadError }}
    </v-alert>
    <v-alert
      v-if="org.loaded && !org.editable"
      type="info"
      variant="tonal"
      density="compact"
      class="mx-2 mb-2 flex-0-0"
    >
      Graph editing needs server support. Showing the current reporting lines read-only.
    </v-alert>
    <v-alert
      v-if="org.loaded && !org.leadAgentId && org.agentList.length > 0"
      type="warning"
      variant="tonal"
      density="compact"
      class="mx-2 mb-2 flex-0-0"
    >
      No lead agent yet.
      <template v-if="org.leadSupported && org.leadCandidates.length > 0">
        Pick one:
        <v-chip
          v-for="candidate in org.leadCandidates"
          :key="candidate.id"
          class="ml-1"
          color="primary"
          @click="org.makeLead(candidate.id)"
        >
          {{ candidate.name }}
        </v-chip>
      </template>
      <template v-else>Open an agent and pick "Make lead".</template>
    </v-alert>
    <div class="org-body d-flex flex-grow-1 ga-2 px-2 pb-2">
      <div class="org-surface flex-grow-1">
        <OrgCanvas ref="canvas" @open="(id) => (selected = id)" />
        <div v-if="org.loaded && org.agentList.length === 0" class="org-empty text-medium-emphasis">
          No agents yet.
        </div>
      </div>
      <AgentPanel v-if="selected" :agent-id="selected" @close="selected = null" />
    </div>
    <v-dialog v-model="confirmArrange" max-width="420">
      <v-card title="Auto-arrange the chart?">
        <v-card-text>
          Every agent moves to the computed layout. Manual positions are replaced for everyone.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmArrange = false">Cancel</v-btn>
          <v-btn color="primary" variant="tonal" @click="arrange">Arrange</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
    <v-snackbar v-model="snackbar" :color="org.notice?.color" timeout="5000">
      {{ org.notice?.text }}
    </v-snackbar>
  </div>
</template>

<style scoped>
.org-view {
  height: calc(100vh - var(--v-layout-top, 48px));
}
.org-body {
  min-height: 0;
}
.org-surface {
  position: relative;
  min-width: 0;
  border-radius: 12px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgb(var(--v-theme-background));
  overflow: hidden;
}
.org-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
</style>
