<script setup lang="ts">
import { mdiAlarm, mdiArrowLeft } from '@mdi/js';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';
import { errorText, loadAgents, loadModels } from '../agents/api';
import { canEditAgents, canWriteMemories, sameSkills } from '../agents/skills';
import { adapterLabel } from '../agents/form';
import { api } from '../api/client';
import type { Agent, AgentDetail, Issue } from '../api/types';
import AgentRulesTab from '../components/agents/AgentRulesTab.vue';
import AgentRunsTab from '../components/agents/AgentRunsTab.vue';
import AgentSettingsTab from '../components/agents/AgentSettingsTab.vue';
import AgentSkillsTab from '../components/agents/AgentSkillsTab.vue';
import AgentTasksTab from '../components/agents/AgentTasksTab.vue';
import AgentWakeDialog from '../components/agents/AgentWakeDialog.vue';
import MemoryPanel from '../components/memory/MemoryPanel.vue';
import StatusChip from '../components/StatusChip.vue';
import { useAuthStore } from '../stores/auth';

const props = defineProps<{ agentId: string }>();
const route = useRoute();
const router = useRouter();

const TABS = ['settings', 'rules', 'skills', 'knowledge', 'tasks', 'runs'] as const;
const auth = useAuthStore();
const agent = ref<AgentDetail | null>(null);
const agents = ref<Agent[]>([]);
const models = ref<string[]>([]);
const rulesDraft = ref('');
const skillsDraft = ref<string[]>([]);
const error = ref('');
const waking = ref(false);
const wakeIssueId = ref<string | null>(null);

const tab = computed({
  get: () => {
    const value = String(route.query['tab'] ?? 'settings');
    return (TABS as readonly string[]).includes(value) ? value : 'settings';
  },
  set: (value: string) => void router.replace({ query: { ...route.query, tab: value } }),
});
const rulesDirty = computed(() => !!agent.value && rulesDraft.value !== agent.value.instructions);
const skillsDirty = computed(
  () => !!agent.value && !sameSkills(agent.value.skillIds ?? [], skillsDraft.value),
);
const dirty = computed(() => rulesDirty.value || skillsDirty.value);
const readOnly = computed(() => !canEditAgents(auth.me?.role));
const canWriteKnowledge = computed(() => canWriteMemories(auth.me?.role));
const manager = computed(() => agents.value.find((a) => a.id === agent.value?.reportsTo));

async function load(): Promise<void> {
  error.value = '';
  try {
    const [detail, all, suggested] = await Promise.all([
      api<AgentDetail>(`/agents/${props.agentId}`),
      loadAgents(),
      loadModels(),
    ]);
    agent.value = detail;
    agents.value = all;
    models.value = suggested;
    rulesDraft.value = detail.instructions;
    skillsDraft.value = [...(detail.skillIds ?? [])];
  } catch (cause) {
    agent.value = null;
    error.value = errorText(cause);
  }
}
watch(() => props.agentId, load, { immediate: true });

function updated(next: AgentDetail): void {
  // A save that finishes after the user moved on to another agent must not replace that agent.
  if (next.id !== props.agentId || next.id !== agent.value?.id) return;
  const keepRules = rulesDirty.value;
  const keepSkills = skillsDirty.value;
  agent.value = next;
  if (!keepRules) rulesDraft.value = next.instructions;
  if (!keepSkills) skillsDraft.value = [...(next.skillIds ?? [])];
  agents.value = agents.value.map((item) => (item.id === next.id ? next : item));
}

function openWake(issue?: Issue): void {
  wakeIssueId.value = issue?.id ?? null;
  waking.value = true;
}

const confirmLeave = (): boolean =>
  !dirty.value || window.confirm('This agent has unsaved changes. Leave anyway?');
onBeforeRouteLeave(confirmLeave);
onBeforeRouteUpdate(
  (to, from) => to.params['agentId'] === from.params['agentId'] || confirmLeave(),
);

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (dirty.value) event.preventDefault();
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload));
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload));

function deleted(): void {
  rulesDraft.value = agent.value?.instructions ?? '';
  skillsDraft.value = [...(agent.value?.skillIds ?? [])];
  void router.push({ name: 'agents' });
}
</script>

<template>
  <v-container class="pa-3" style="max-width: 1100px">
    <v-btn :prepend-icon="mdiArrowLeft" variant="text" :to="{ name: 'agents' }" class="mb-2">
      Agents
    </v-btn>
    <v-alert v-if="error" type="error" variant="tonal">{{ error }}</v-alert>
    <template v-if="agent">
      <div class="d-flex align-center flex-wrap ga-2 mb-1">
        <span class="text-h5" data-test="agent-name">{{ agent.name }}</span>
        <StatusChip :status="agent.status" />
        <v-spacer />
        <v-btn color="primary" variant="tonal" :prepend-icon="mdiAlarm" @click="openWake()">
          Wake
        </v-btn>
      </div>
      <div class="text-body-2 text-medium-emphasis mb-3">
        {{ agent.title || agent.role }} · {{ adapterLabel(agent.adapter) }}
        <template v-if="manager">
          · reports to
          <router-link :to="{ name: 'agent', params: { agentId: manager.id } }">
            {{ manager.name }}
          </router-link>
        </template>
      </div>
      <v-tabs v-model="tab" class="mb-3">
        <v-tab value="settings">Settings</v-tab>
        <v-tab value="rules">Rules<span v-if="rulesDirty" class="text-warning ml-1">*</span></v-tab>
        <v-tab value="skills" data-test="tab-skills">
          Skills<span v-if="skillsDirty" class="text-warning ml-1">*</span>
        </v-tab>
        <v-tab value="knowledge" data-test="tab-knowledge">Knowledge</v-tab>
        <v-tab value="tasks">Tasks</v-tab>
        <v-tab value="runs">Runs</v-tab>
      </v-tabs>
      <v-tabs-window v-model="tab">
        <v-tabs-window-item value="settings">
          <AgentSettingsTab
            :agent="agent"
            :agents="agents"
            :models="models"
            @updated="updated"
            @deleted="deleted"
          />
        </v-tabs-window-item>
        <v-tabs-window-item value="rules">
          <AgentRulesTab :key="agent.id" v-model="rulesDraft" :agent="agent" @updated="updated" />
        </v-tabs-window-item>
        <v-tabs-window-item value="skills">
          <AgentSkillsTab
            :key="agent.id"
            v-model="skillsDraft"
            :agent="agent"
            :read-only="readOnly"
            @updated="updated"
          />
        </v-tabs-window-item>
        <v-tabs-window-item value="knowledge">
          <p class="text-body-2 text-medium-emphasis mb-2">
            Agent memories: what this agent has learned and keeps across runs.
          </p>
          <MemoryPanel
            :key="agent.id"
            scope="agent"
            :agent-id="agent.id"
            :read-only="!canWriteKnowledge"
          />
        </v-tabs-window-item>
        <v-tabs-window-item value="tasks">
          <AgentTasksTab :agent-id="agent.id" @wake="openWake" />
        </v-tabs-window-item>
        <v-tabs-window-item value="runs">
          <AgentRunsTab :agent-id="agent.id" />
        </v-tabs-window-item>
      </v-tabs-window>
      <AgentWakeDialog v-model="waking" :agent="agent" :issue-id="wakeIssueId" />
    </template>
  </v-container>
</template>
