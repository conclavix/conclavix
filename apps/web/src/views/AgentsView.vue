<script setup lang="ts">
import { mdiPlus } from '@mdi/js';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { errorText, loadAgents, loadModels } from '../agents/api';
import { adapterLabel } from '../agents/form';
import type { Agent, AgentDetail } from '../api/types';
import AgentCreateDialog from '../components/agents/AgentCreateDialog.vue';
import { STATUS_COLORS } from '../format';
import { useLiveStore } from '../stores/live';

const router = useRouter();
const live = useLiveStore();
const agents = ref<Agent[]>([]);
const models = ref<string[]>([]);
const error = ref('');
const loading = ref(true);
const creating = ref(false);

const byId = computed(() => new Map(agents.value.map((agent) => [agent.id, agent])));
const statusOf = (agent: Agent) => live.state.agents[agent.id]?.status ?? agent.status;

async function load(): Promise<void> {
  error.value = '';
  try {
    [agents.value, models.value] = await Promise.all([loadAgents(), loadModels()]);
  } catch (cause) {
    error.value = errorText(cause);
  } finally {
    loading.value = false;
  }
}

function created(agent: AgentDetail): void {
  void router.push({ name: 'agent', params: { agentId: agent.id } });
}

onMounted(load);
</script>

<template>
  <v-container fluid class="pa-3">
    <div class="d-flex align-center mb-2">
      <span class="text-h6">Agents</span>
      <v-spacer />
      <v-btn color="primary" :prepend-icon="mdiPlus" @click="creating = true">New agent</v-btn>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-2">{{ error }}</v-alert>
    <v-card>
      <v-progress-linear v-if="loading" indeterminate />
      <v-table density="comfortable" hover>
        <thead>
          <tr>
            <th>Name</th>
            <th>Role</th>
            <th>Title</th>
            <th>Adapter</th>
            <th>Status</th>
            <th>Reports to</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="agent in agents"
            :key="agent.id"
            class="agent-row"
            @click="router.push({ name: 'agent', params: { agentId: agent.id } })"
          >
            <td>
              <router-link :to="{ name: 'agent', params: { agentId: agent.id } }" @click.stop>
                {{ agent.name }}
              </router-link>
            </td>
            <td>{{ agent.role }}</td>
            <td>{{ agent.title }}</td>
            <td>{{ adapterLabel(agent.adapter) }}</td>
            <td>
              <v-chip :color="STATUS_COLORS[statusOf(agent)]">{{ statusOf(agent) }}</v-chip>
            </td>
            <td>{{ agent.reportsTo ? (byId.get(agent.reportsTo)?.name ?? '?') : '' }}</td>
          </tr>
          <tr v-if="!loading && agents.length === 0">
            <td colspan="6" class="text-medium-emphasis">No agents yet.</td>
          </tr>
        </tbody>
      </v-table>
    </v-card>
    <AgentCreateDialog v-model="creating" :agents="agents" :models="models" @created="created" />
  </v-container>
</template>

<style scoped>
.agent-row {
  cursor: pointer;
}
</style>
