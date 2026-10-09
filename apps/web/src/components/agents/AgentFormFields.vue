<script setup lang="ts">
import { computed } from 'vue';
import { ADAPTER_TYPES, managerCandidates, rules, type AgentForm } from '../../agents/form';
import type { Agent } from '../../api/types';

const form = defineModel<AgentForm>({ required: true });
const props = defineProps<{
  agents: Agent[];
  models: string[];
  selfId?: string | null;
  showInstructions?: boolean;
}>();

const managers = computed(() =>
  managerCandidates(props.agents, props.selfId ?? null).map((agent) => ({
    value: agent.id,
    title: agent.title ? `${agent.name} (${agent.title})` : agent.name,
  })),
);
const needsModel = computed(() => form.value.adapterType === 'openai_http');
const secretLabel = computed(() =>
  form.value.adapterType === 'openai_http'
    ? 'API key secret name (optional)'
    : 'Gateway key secret name (optional)',
);
const modelRules = computed(() =>
  needsModel.value ? [rules.required, rules.maxLength(120)] : [rules.maxLength(120)],
);
</script>

<template>
  <v-row dense>
    <v-col cols="12" sm="6">
      <v-text-field
        v-model="form.name"
        label="Name"
        :rules="[rules.required, rules.maxLength(80)]"
      />
    </v-col>
    <v-col cols="12" sm="6">
      <v-text-field
        v-model="form.role"
        label="Role"
        hint="Short role id, e.g. cto or engineer"
        :rules="[rules.required, rules.maxLength(80)]"
      />
    </v-col>
    <v-col cols="12" sm="6">
      <v-text-field v-model="form.title" label="Title" :rules="[rules.maxLength(120)]" />
    </v-col>
    <v-col cols="12" sm="6">
      <v-select
        v-model="form.reportsTo"
        :items="managers"
        label="Reports to"
        placeholder="Nobody (top of the org chart)"
        persistent-placeholder
        clearable
      />
    </v-col>
    <v-col cols="12" sm="6">
      <v-select v-model="form.adapterType" :items="ADAPTER_TYPES" label="Adapter" />
    </v-col>
    <v-col cols="12" sm="6">
      <v-combobox
        :model-value="form.model"
        :items="models"
        :label="needsModel ? 'Model' : 'Model (optional)'"
        hint="Pick a suggestion or type any model name"
        :rules="modelRules"
        @update:model-value="(value: string | null) => (form.model = value ?? '')"
      />
    </v-col>
    <v-col v-if="form.adapterType === 'openai_http'" cols="12">
      <v-text-field
        v-model="form.baseUrl"
        label="Base URL"
        placeholder="https://llm.example.com/v1"
        :rules="[rules.url]"
      />
    </v-col>
    <v-col v-if="form.adapterType !== 'codex_cli'" cols="12">
      <v-text-field
        v-model="form.secret"
        :label="secretLabel"
        hint="The NAME of a CVX_SECRET_* variable on the runner, never the key itself"
        persistent-hint
        :rules="[rules.secretName]"
      />
    </v-col>
    <v-col cols="12" sm="4">
      <v-text-field
        v-model.number="form.limits.maxIdleRunsPerIssue"
        type="number"
        label="Idle runs before backoff"
        hint="Runs in a row on one issue without progress (no status change, document revision, sub-issue or synced commit). Then the agent waits a few minutes; one more idle run pauses it. Productive runs never count."
        persistent-hint
        data-test="idle-runs-field"
        :rules="[rules.range(1, 60, true)]"
      />
    </v-col>
    <v-col cols="12" sm="4">
      <v-text-field
        v-model.number="form.limits.maxCostPerRunUsd"
        type="number"
        step="0.5"
        prefix="$"
        label="Max cost per run"
        :rules="[rules.range(0.01, 100)]"
      />
    </v-col>
    <v-col cols="12" sm="4">
      <v-text-field
        v-model.number="form.limits.maxCostPerDayUsd"
        type="number"
        prefix="$"
        label="Max cost per day"
        :rules="[rules.range(0.01, 1000)]"
      />
    </v-col>
    <v-col cols="12">
      <v-switch
        :model-value="form.projectDefault === 'enabled'"
        color="success"
        label="Active in projects by default"
        hint="On: the agent may work in every project unless a project disables it. Off: only in projects that enable it on their Agents tab (e.g. a review agent you switch on per project)."
        persistent-hint
        inset
        data-test="project-default-switch"
        @update:model-value="
          (on: boolean | null) => (form.projectDefault = on ? 'enabled' : 'disabled')
        "
      />
    </v-col>
    <v-col cols="12">
      <v-switch
        :model-value="form.codeAccess === 'write'"
        color="warning"
        label="May write and run code"
        :disabled="form.adapterType !== 'claude_cli' && form.codeAccess !== 'write'"
        hint="Claude CLI only. Off: the agent reads its run directory and talks to the board. On: it works in the issue's git workspace with Edit, Write and Bash."
        persistent-hint
        inset
        data-test="code-access-switch"
        @update:model-value="(on: boolean | null) => (form.codeAccess = on ? 'write' : 'none')"
      />
      <v-alert
        v-if="form.codeAccess === 'write'"
        type="warning"
        variant="tonal"
        density="compact"
        class="mt-2"
        data-test="code-access-warning"
      >
        The agent runs shell commands (installs, tests, builds) on the server. Every run is
        sandboxed: a separate system unit that sees only this issue's clone, with memory, CPU,
        process, time and disk limits, and shell commands that reach package registries only. It
        never sees the runner's tokens, the database or other projects. Its changes are committed to
        the issue branch after the run. Only admins and owners can change this, and every change is
        in the audit log.
      </v-alert>
    </v-col>
    <v-col cols="12">
      <v-switch
        v-model="form.gitIntegration"
        color="warning"
        label="May merge branches and update main"
        hint="Off by default. On: the agent can merge branches of its project into an issue branch and fast-forward main to a reviewed branch, on the server (merge_branches, fast_forward_main). Pushing to external remotes is not part of this."
        persistent-hint
        inset
        data-test="git-integration-switch"
      />
      <v-alert
        v-if="form.gitIntegration"
        type="warning"
        variant="tonal"
        density="compact"
        class="mt-2"
        data-test="git-integration-warning"
      >
        The agent can change main in every project it is enabled in. Merges are refused on conflicts
        and main only moves by fast-forward, but whether a branch was reviewed is up to the agent's
        instructions. Merges and promotions are in the audit log.
      </v-alert>
    </v-col>
    <v-col v-if="showInstructions" cols="12">
      <v-textarea
        v-model="form.instructions"
        label="Instructions (Markdown)"
        hint="Given to the agent in every run; editable later in the Rules tab"
        persistent-hint
        rows="5"
        auto-grow
        :rules="[rules.maxLength(20000)]"
      />
    </v-col>
  </v-row>
</template>
