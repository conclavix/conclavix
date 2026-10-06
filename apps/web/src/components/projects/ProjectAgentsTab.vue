<script setup lang="ts">
import { mdiLock, mdiRestore } from '@mdi/js';
import { ref, watch } from 'vue';
import type { ProjectAgent } from '../../api/types';
import { describeError } from '../../issues';
import {
  loadProjectAgents,
  setProjectAgent,
  sourceLabel,
  toggleIntent,
} from '../../projects/agents';
import AvatarImage from '../AvatarImage.vue';

const props = defineProps<{ projectId: string; readOnly: boolean }>();
const emit = defineEmits<{ changed: [agents: ProjectAgent[]] }>();

const agents = ref<ProjectAgent[]>([]);
const loading = ref(false);
/** Agents with an access change in flight; each switch stays locked until its own request ends. */
const busy = ref<ReadonlySet<string>>(new Set());
const error = ref('');
const pending = ref<{ agent: ProjectAgent; override: boolean | null; message: string } | null>(
  null,
);

async function load(): Promise<void> {
  // The view reuses this tab across projects; a late answer for a project left behind is dropped.
  const projectId = props.projectId;
  loading.value = true;
  error.value = '';
  pending.value = null;
  try {
    const items = await loadProjectAgents(projectId);
    if (props.projectId !== projectId) return;
    agents.value = items;
    emit('changed', agents.value);
  } catch (cause) {
    if (props.projectId === projectId) error.value = describeError(cause);
  } finally {
    if (props.projectId === projectId) loading.value = false;
  }
}
watch(() => props.projectId, load, { immediate: true });

async function apply(agent: ProjectAgent, override: boolean | null): Promise<void> {
  const projectId = props.projectId;
  busy.value = new Set([...busy.value, agent.id]);
  error.value = '';
  try {
    const updated = await setProjectAgent(projectId, agent.id, override);
    if (props.projectId !== projectId) return;
    agents.value = agents.value.map((item) => (item.id === updated.id ? updated : item));
    emit('changed', agents.value);
  } catch (cause) {
    if (props.projectId === projectId) error.value = describeError(cause);
  } finally {
    busy.value = new Set([...busy.value].filter((id) => id !== agent.id));
  }
}

function toggle(agent: ProjectAgent, value: boolean | null): void {
  if (props.readOnly || agent.isLead) return;
  const intent = toggleIntent(agent, value === true);
  if (intent.confirm) {
    pending.value = { agent, override: intent.override, message: intent.confirm };
    return;
  }
  void apply(agent, intent.override);
}

function confirmPending(): void {
  const next = pending.value;
  pending.value = null;
  if (next) void apply(next.agent, next.override);
}
</script>

<template>
  <div data-test="project-agents">
    <p class="text-body-2 text-medium-emphasis mb-2">
      Which agents may work in this project. An agent follows its own default ("Active in projects
      by default" on the agent) unless this project overrides it. Agents not enabled here cannot be
      assigned issues of this project and are not woken for them; the lead is always enabled.
    </p>
    <v-alert
      v-if="readOnly"
      type="info"
      variant="tonal"
      density="compact"
      class="mb-2"
      data-test="project-agents-read-only"
    >
      Read only: your role may not change which agents work in a project.
    </v-alert>
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-2">
      {{ error }}
    </v-alert>
    <v-progress-linear v-if="loading" indeterminate class="mb-2" />
    <v-list lines="two" class="py-0" border rounded>
      <v-list-item
        v-for="agent in agents"
        :key="agent.id"
        :data-test="`project-agent-${agent.name}`"
      >
        <template #prepend>
          <AvatarImage
            :name="agent.name"
            :src="agent.avatarUrl"
            :color-key="agent.id"
            :size="36"
            class="mr-3"
          />
        </template>
        <v-list-item-title>
          <router-link :to="{ name: 'agent', params: { agentId: agent.id } }">
            {{ agent.name }}
          </router-link>
        </v-list-item-title>
        <v-list-item-subtitle>
          {{ agent.title || agent.role }}
          <template v-if="agent.openIssues > 0">
            · {{ agent.openIssues }} open {{ agent.openIssues === 1 ? 'issue' : 'issues' }}
          </template>
          <span v-if="!agent.enabled && agent.openIssues > 0" class="text-warning">
            · not worked on while disabled
          </span>
        </v-list-item-subtitle>
        <template #append>
          <div class="d-flex align-center ga-2">
            <v-chip
              size="small"
              :color="agent.source === 'project' ? 'primary' : undefined"
              :prepend-icon="agent.isLead ? mdiLock : undefined"
              variant="tonal"
              data-test="agent-source"
            >
              {{ sourceLabel(agent) }}
            </v-chip>
            <v-btn
              v-if="agent.source === 'project' && !readOnly && !agent.isLead"
              :icon="mdiRestore"
              size="small"
              variant="text"
              :disabled="busy.has(agent.id)"
              :aria-label="`Reset ${agent.name} to its default`"
              data-test="agent-reset"
              @click="apply(agent, null)"
            />
            <v-tooltip
              :disabled="!agent.isLead && !readOnly"
              :text="agent.isLead ? 'The lead is always enabled in every project' : 'Read only'"
            >
              <template #activator="{ props: tip }">
                <div v-bind="tip">
                  <v-switch
                    :model-value="agent.enabled"
                    :disabled="readOnly || agent.isLead || busy.has(agent.id)"
                    :loading="busy.has(agent.id)"
                    color="success"
                    density="compact"
                    hide-details
                    inset
                    :aria-label="`${agent.name} enabled in this project`"
                    data-test="agent-switch"
                    @update:model-value="toggle(agent, $event)"
                  />
                </div>
              </template>
            </v-tooltip>
          </div>
        </template>
      </v-list-item>
      <v-list-item v-if="!loading && agents.length === 0" subtitle="No agents yet" />
    </v-list>
    <v-dialog :model-value="pending !== null" max-width="480" @update:model-value="pending = null">
      <v-card v-if="pending" :title="`Disable ${pending.agent.name} here?`">
        <v-card-text>
          <v-alert type="warning" variant="tonal" data-test="disable-warning">
            {{ pending.message }}
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="pending = null">Cancel</v-btn>
          <v-btn color="warning" variant="flat" data-test="confirm-disable" @click="confirmPending">
            Disable
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
