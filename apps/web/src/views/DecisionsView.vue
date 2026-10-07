<script setup lang="ts">
import { mdiCheck, mdiClose, mdiSend } from '@mdi/js';
import { computed, onBeforeUnmount, onMounted, reactive } from 'vue';
import { canDecide, plainAnswer, type Decision } from '../api/decisions';
import { ago } from '../format';
import { useNow } from '../composables';
import { describeError } from '../issues';
import { useAuthStore } from '../stores/auth';
import { useDecisionsStore } from '../stores/decisions';

const decisions = useDecisionsStore();
const auth = useAuthStore();
const now = useNow();
const writable = computed(() => canDecide(auth.me?.role));

/** Per-decision draft, busy flag and error, kept by id so list reloads do not lose them. */
const drafts = reactive<Record<string, string>>({});
const busy = reactive<Record<string, boolean>>({});
const errors = reactive<Record<string, string>>({});

onMounted(() => void decisions.retain());
onBeforeUnmount(() => decisions.release());

const OUTCOMES: Record<string, { color: string; text: string }> = {
  answered: { color: 'success', text: 'answered' },
  dismissed: { color: 'warning', text: 'dismissed' },
  withdrawn: { color: 'default', text: 'withdrawn' },
};

const draft = (decision: Decision): string | undefined => drafts[decision.id]?.trim() || undefined;

async function act(decision: Decision, work: () => Promise<void>): Promise<void> {
  busy[decision.id] = true;
  errors[decision.id] = '';
  try {
    await work();
    drafts[decision.id] = '';
  } catch (cause) {
    errors[decision.id] = describeError(cause);
  } finally {
    busy[decision.id] = false;
  }
}

const choose = (decision: Decision, option: string) =>
  act(decision, () => {
    const body = draft(decision);
    return decisions.answer(decision.id, body ? { option, body } : { option });
  });

const reply = (decision: Decision) =>
  act(decision, () => decisions.answer(decision.id, { body: draft(decision) ?? '' }));

const dismiss = (decision: Decision) =>
  act(decision, () => decisions.dismiss(decision.id, draft(decision)));
</script>

<template>
  <v-container class="pa-3" style="max-width: 960px">
    <div class="d-flex align-baseline flex-wrap ga-2 mb-1">
      <h1 class="text-title-large">Decisions</h1>
      <span class="text-medium-emphasis text-body-2" data-test="decisions-count">
        {{ decisions.openCount }} open
      </span>
    </div>
    <p class="text-medium-emphasis text-body-2 mb-4">
      Questions agents asked the board, oldest first. An answer is posted as a comment on the issue
      and wakes the agent.
    </p>
    <v-alert v-if="decisions.error" type="error" variant="tonal" class="mb-3">
      {{ decisions.error }}
    </v-alert>
    <v-skeleton-loader v-if="!decisions.loaded" type="card" />
    <v-card
      v-else-if="decisions.open.length === 0"
      variant="outlined"
      class="pa-6 text-center text-medium-emphasis"
      data-test="decisions-empty"
    >
      No open decisions. Agents ask here when they need the board.
    </v-card>
    <div v-else class="d-flex flex-column ga-3">
      <v-card
        v-for="decision in decisions.open"
        :key="decision.id"
        variant="outlined"
        data-test="decision-card"
      >
        <v-card-item>
          <v-card-title class="text-body-1 font-weight-medium decision-title">
            <router-link :to="{ name: 'issue', params: { issueKey: decision.issue.key } }">
              {{ decision.issue.key }}
            </router-link>
            {{ decision.issue.title }}
          </v-card-title>
          <v-card-subtitle class="decision-meta">
            <span v-if="decision.project">{{ decision.project.name }} · </span>
            asked by {{ decision.askedBy.name ?? 'a deleted agent' }} · waiting
            {{ ago(decision.askedAt, now) }}
          </v-card-subtitle>
        </v-card-item>
        <v-card-text>
          <p class="decision-question mb-3" data-test="decision-question">
            {{ decision.question }}
          </p>
          <div v-if="decision.options.length > 0" class="d-flex flex-wrap ga-2 mb-3">
            <v-btn
              v-for="option in decision.options"
              :key="option"
              :prepend-icon="mdiCheck"
              :disabled="!writable || !!busy[decision.id]"
              color="primary"
              variant="tonal"
              class="text-none"
              data-test="decision-option"
              @click="choose(decision, option)"
            >
              {{ option }}
            </v-btn>
          </div>
          <v-textarea
            v-if="writable"
            v-model="drafts[decision.id]"
            :label="
              decision.options.length > 0 ? 'Answer or note (optional with an option)' : 'Answer'
            "
            rows="2"
            auto-grow
            hide-details
            density="comfortable"
            variant="outlined"
            data-test="decision-answer"
          />
          <v-alert
            v-if="errors[decision.id]"
            type="error"
            variant="tonal"
            density="compact"
            class="mt-2"
          >
            {{ errors[decision.id] }}
          </v-alert>
        </v-card-text>
        <v-card-actions v-if="writable">
          <v-btn
            :prepend-icon="mdiClose"
            :disabled="!!busy[decision.id]"
            variant="text"
            data-test="decision-dismiss"
            @click="dismiss(decision)"
          >
            Dismiss
          </v-btn>
          <v-spacer />
          <v-btn
            :prepend-icon="mdiSend"
            :disabled="!draft(decision)"
            :loading="!!busy[decision.id]"
            color="primary"
            variant="flat"
            data-test="decision-send"
            @click="reply(decision)"
          >
            Send answer
          </v-btn>
        </v-card-actions>
      </v-card>
    </div>

    <v-expansion-panels
      v-if="decisions.recent.length > 0"
      class="mt-6"
      variant="accordion"
      data-test="decisions-recent"
    >
      <v-expansion-panel>
        <v-expansion-panel-title>
          Recently decided ({{ decisions.recent.length }})
        </v-expansion-panel-title>
        <v-expansion-panel-text>
          <v-list density="compact" lines="two">
            <v-list-item
              v-for="decision in decisions.recent"
              :key="decision.id"
              :to="{ name: 'issue', params: { issueKey: decision.issue.key } }"
            >
              <v-list-item-title class="decision-recent-title">
                {{ decision.issue.key }} · {{ decision.question }}
              </v-list-item-title>
              <v-list-item-subtitle>{{ plainAnswer(decision.answer) }}</v-list-item-subtitle>
              <template #append>
                <div class="d-flex flex-column align-end ga-1">
                  <v-chip
                    :color="OUTCOMES[decision.status]?.color ?? 'default'"
                    size="small"
                    variant="tonal"
                  >
                    {{ OUTCOMES[decision.status]?.text ?? decision.status }}
                  </v-chip>
                  <span class="text-caption text-medium-emphasis">
                    {{ ago(decision.decidedAt, now) }} ago
                  </span>
                </div>
              </template>
            </v-list-item>
          </v-list>
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>
  </v-container>
</template>

<style scoped>
.decision-question {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.decision-title,
.decision-meta {
  white-space: normal;
  overflow-wrap: anywhere;
  hyphens: manual;
}
.decision-recent-title {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  white-space: normal;
  hyphens: manual;
}
</style>
