<script setup lang="ts">
import { mdiClose, mdiCrown, mdiOpenInNew, mdiPause, mdiPlay } from '@mdi/js';
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import type { AgentLink } from '../../api/org-graph';
import { initials } from '../../org/handles';
import { useLiveStore } from '../../stores/live';
import { useOrgGraphStore } from '../../stores/orgGraph';
import StatusChip from '../StatusChip.vue';

const props = defineProps<{ agentId: string }>();
const emit = defineEmits<{ close: [] }>();
const org = useOrgGraphStore();
const live = useLiveStore();
const router = useRouter();

const agent = computed(() => org.agents[props.agentId]);
const status = computed(() => live.state.agents[props.agentId]?.status ?? agent.value?.status);
const model = computed(
  () => agent.value?.model ?? live.state.agents[props.agentId]?.adapter?.model ?? '',
);
const running = computed(() => live.activeRuns.some((run) => run.agentId === props.agentId));
const isLead = computed(() => org.leadAgentId === props.agentId);
const hasDelegators = computed(() =>
  org.links.some((link) => link.type === 'delegates' && link.to === props.agentId),
);
const leadHint = computed(() => {
  if (!org.leadSupported) return 'needs server support for leads';
  return 'remove the delegation into this agent first';
});
const detailPath = computed(() => `/agents/${props.agentId}`);
const hasDetailRoute = computed(() => router.resolve(detailPath.value).matched.length > 0);
/** Resolve a relationship endpoint label even when its agent is absent from the graph. */
const nameOf = (id: string): string => org.agents[id]?.name ?? 'unknown agent';

interface Group {
  title: string;
  items: { link: AgentLink; other: string }[];
}

const groups = computed<Group[]>(() => {
  const id = props.agentId;
  /** Select relationships by direction and type, retaining the opposite endpoint for display. */
  const pick = (type: AgentLink['type'], outgoing: boolean): Group['items'] =>
    org.links
      .filter((link) => link.type === type && (outgoing ? link.from : link.to) === id)
      .map((link) => ({ link, other: outgoing ? link.to : link.from }));
  return [
    { title: 'Delegates to', items: pick('delegates', true) },
    { title: 'Receives delegation from', items: pick('delegates', false) },
    { title: 'Reports to', items: pick('reports', true) },
    { title: 'Receives reports from', items: pick('reports', false) },
  ];
});

/** Toggle the selected agent status through the store, which reports mutation failures. */
const toggleStatus = (): void => {
  void org.setStatus(props.agentId, status.value === 'active' ? 'paused' : 'active');
};
</script>

<template>
  <v-card v-if="agent" class="agent-panel" border flat>
    <v-card-item>
      <template #prepend>
        <v-avatar :color="isLead ? 'primary' : 'secondary'" variant="tonal">
          {{ initials(agent.name) }}
        </v-avatar>
      </template>
      <v-card-title>{{ agent.name }}</v-card-title>
      <v-card-subtitle>{{ agent.title || agent.role }}</v-card-subtitle>
      <template #append>
        <v-btn
          :icon="mdiClose"
          variant="text"
          size="small"
          aria-label="Close"
          @click="emit('close')"
        />
      </template>
    </v-card-item>
    <v-card-text class="d-flex flex-column ga-3">
      <div class="d-flex flex-wrap ga-1">
        <v-chip v-if="isLead" color="primary" :prepend-icon="mdiCrown">Lead</v-chip>
        <StatusChip v-if="status" :status="status" />
        <v-chip v-if="running" color="primary">running</v-chip>
        <v-chip v-if="!org.reachable.has(agent.id)" color="warning">not connected</v-chip>
      </div>
      <div v-if="agent.role" class="text-body-2"><strong>Role:</strong> {{ agent.role }}</div>
      <div v-if="model" class="text-body-2"><strong>Model:</strong> {{ model }}</div>
      <div v-for="group in groups" :key="group.title">
        <div class="text-caption text-medium-emphasis">{{ group.title }}</div>
        <div v-if="group.items.length === 0" class="text-body-2 text-disabled">none</div>
        <v-chip
          v-for="item in group.items"
          :key="item.link.id"
          class="mr-1 mt-1"
          :closable="org.editable && !item.link.id.startsWith('pending-')"
          :close-label="`Remove link to ${nameOf(item.other)}`"
          @click:close="void org.removeLink(item.link.id)"
        >
          {{ nameOf(item.other) }}
        </v-chip>
      </div>
    </v-card-text>
    <v-card-actions class="flex-wrap ga-1">
      <v-btn
        :prepend-icon="status === 'active' ? mdiPause : mdiPlay"
        variant="tonal"
        @click="toggleStatus"
      >
        {{ status === 'active' ? 'Pause' : 'Activate' }}
      </v-btn>
      <v-btn
        :prepend-icon="mdiCrown"
        variant="tonal"
        color="primary"
        :disabled="isLead || !org.leadSupported || hasDelegators"
        @click="void org.makeLead(agent.id)"
      >
        Make lead
      </v-btn>
      <v-btn v-if="hasDetailRoute" :to="detailPath" :append-icon="mdiOpenInNew" variant="text">
        Open
      </v-btn>
    </v-card-actions>
    <div v-if="!isLead && (hasDelegators || !org.leadSupported)" class="text-caption px-4 pb-3">
      Make lead: {{ leadHint }}
    </div>
  </v-card>
</template>

<style scoped>
.agent-panel {
  width: 320px;
  max-height: 100%;
  overflow-y: auto;
}
</style>
