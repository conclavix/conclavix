<script setup lang="ts">
import { computed, ref } from 'vue';
import { api } from '../../api/client';
import type { Overview } from '../../api/overview';
import { ago, usd } from '../../format';
import { useLiveStore } from '../../stores/live';

const props = defineProps<{ attention: Overview['attention']; now: number }>();
const emit = defineEmits<{ changed: [] }>();
const live = useLiveStore();
const resuming = ref<string | null>(null);
const resumeError = ref<string | null>(null);

const paused = computed(() =>
  props.attention.pausedAgents.filter(
    (agent) => (live.state.agents[agent.agentId]?.status ?? 'paused') === 'paused',
  ),
);
const empty = computed(
  () =>
    paused.value.length +
      props.attention.budgetHeld.length +
      props.attention.failedRuns.length +
      props.attention.blockedIssues.length +
      props.attention.inReview.length ===
    0,
);
const issueLink = (key: string | null) =>
  key ? { name: 'issue', params: { issueKey: key } } : undefined;
const reasonText = (reason: 'loop' | 'manual'): string =>
  reason === 'loop' ? 'loop detection: runs made no progress' : 'paused by the board';

async function resume(agentId: string): Promise<void> {
  if (resuming.value !== null) return;
  resuming.value = agentId;
  resumeError.value = null;
  try {
    const agent = await api<Record<string, unknown>>(`/agents/${agentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'active' }),
    });
    live.state.agents[agentId] = { ...live.state.agents[agentId], ...agent, id: agentId };
    emit('changed');
  } catch (cause) {
    resumeError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    resuming.value = null;
  }
}
</script>

<template>
  <v-card id="attention">
    <v-card-title>Needs attention</v-card-title>
    <v-card-text v-if="empty" class="text-medium-emphasis">Nothing needs attention.</v-card-text>
    <v-alert v-if="resumeError" type="error" variant="tonal" density="compact" class="mx-4">
      {{ resumeError }}
    </v-alert>
    <v-list v-if="!empty" density="compact" lines="two">
      <template v-if="paused.length">
        <v-list-subheader>Paused agents</v-list-subheader>
        <v-list-item v-for="agent in paused" :key="agent.agentId" data-test="paused-agent">
          <v-list-item-title>
            {{ agent.name }} <v-chip color="warning" class="ml-1">paused</v-chip>
          </v-list-item-title>
          <v-list-item-subtitle>
            {{ reasonText(agent.reason) }}
            <router-link v-if="agent.issueKey" :to="issueLink(agent.issueKey)!">
              {{ agent.issueKey }}</router-link
            >
            &middot; {{ ago(agent.since, now) }} ago
          </v-list-item-subtitle>
          <template #append>
            <v-btn
              variant="tonal"
              size="small"
              :loading="resuming === agent.agentId"
              :disabled="resuming !== null"
              @click="resume(agent.agentId)"
            >
              Resume
            </v-btn>
          </template>
        </v-list-item>
      </template>
      <template v-if="attention.budgetHeld.length">
        <v-list-subheader>Daily budget reached</v-list-subheader>
        <v-list-item
          v-for="agent in attention.budgetHeld"
          :key="agent.agentId"
          :title="agent.name"
          :subtitle="`${usd(agent.costTodayUsd)} of ${usd(agent.limitUsd)} today, waits for UTC midnight`"
        />
      </template>
      <template v-if="attention.failedRuns.length">
        <v-list-subheader>Failed in the last 24 h ({{ attention.failedRuns24h }})</v-list-subheader>
        <v-list-item
          v-for="run in attention.failedRuns"
          :key="run.runId"
          :to="issueLink(run.issueKey)"
        >
          <v-list-item-title>
            {{ run.agentName }} on {{ run.issueKey ?? (run.chatId ? 'CEO chat' : 'issue') }}
            <v-chip color="error" class="ml-1">{{ run.status.replace('_', ' ') }}</v-chip>
          </v-list-item-title>
          <v-list-item-subtitle>
            {{ ago(run.finishedAt, now) }} ago<template v-if="run.error">
              &middot; {{ run.error }}</template
            >
          </v-list-item-subtitle>
        </v-list-item>
      </template>
      <template v-if="attention.blockedIssues.length">
        <v-list-subheader>Blocked issues</v-list-subheader>
        <v-list-item
          v-for="issue in attention.blockedIssues"
          :key="issue.issueId"
          :to="issueLink(issue.key)"
          :title="`${issue.key} ${issue.title}`"
          :subtitle="`waits for ${issue.blockers.map((b) => `${b.key} (${b.status.replace('_', ' ')})`).join(', ')}`"
        />
      </template>
      <template v-if="attention.inReview.length">
        <v-list-subheader>Waiting in review</v-list-subheader>
        <v-list-item
          v-for="issue in attention.inReview"
          :key="issue.issueId"
          :to="issueLink(issue.key)"
          :title="`${issue.key} ${issue.title}`"
          :subtitle="`since ${ago(issue.updatedAt, now)}`"
        />
      </template>
    </v-list>
  </v-card>
</template>
