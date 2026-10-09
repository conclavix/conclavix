<script setup lang="ts">
import { mdiLockOutline } from '@mdi/js';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import AdminConfirmDialog from '../../components/admin/AdminConfirmDialog.vue';
import SmtpTestPanel from '../../components/admin/SmtpTestPanel.vue';
import {
  adminApi,
  SETTING_GROUPS,
  type SettingGroup,
  type SettingsResponse,
} from '../../admin/api';
import { canEditGroup, errorText } from '../../admin/gating';
import {
  groupPatch,
  isDirty,
  resetPatch,
  revertGroup,
  toDraft,
  validateGroup,
  type SettingsDraft,
} from '../../admin/settings-form';
import { useAuthStore } from '../../stores/auth';

const SECTIONS: { group: SettingGroup; title: string; subtitle: string }[] = [
  { group: 'instanceName', title: 'General', subtitle: 'How this instance names itself.' },
  {
    group: 'mfaPolicy',
    title: 'Security',
    subtitle: 'Who has to use two-factor authentication. Enforced on every request.',
  },
  {
    group: 'smtp',
    title: 'Mail (SMTP)',
    subtitle: 'Used for password-reset and invitation e-mails.',
  },
  {
    group: 'models',
    title: 'Models',
    subtitle: 'The model names offered when configuring an agent.',
  },
];
const OWNER_ONLY_REASON: Partial<Record<SettingGroup, string>> = {
  mfaPolicy: 'Only an owner can change the MFA policy.',
  smtp: 'Only an owner can change SMTP: whoever controls it receives every password-reset link, including the owners’.',
};
const MFA_POLICIES = [
  { title: 'Optional: everybody decides', value: 'optional' },
  { title: 'Required for owners and admins', value: 'required_for_admins' },
  { title: 'Required for everybody', value: 'required' },
];
const READ_ONLY_LABELS: Record<string, string> = {
  sessionTtlHours: 'Session lifetime (hours)',
  boardUrl: 'Board URL',
};

const auth = useAuthStore();
const data = ref<SettingsResponse | null>(null);
const draft = ref<SettingsDraft | null>(null);
const loadError = ref<string | null>(null);
const saving = ref<SettingGroup | null>(null);
const sectionError = ref<Partial<Record<SettingGroup, string>>>({});
const notice = ref<string | null>(null);
const resetGroup = ref<SettingGroup | null>(null);
const resetOpen = ref(false);
const resetError = ref<string | null>(null);

const role = computed(() => auth.me?.role ?? null);
const editable = (group: SettingGroup): boolean =>
  data.value !== null && canEditGroup(role.value, group, data.value.ownerOnly);
const dirty = (group: SettingGroup): boolean =>
  data.value !== null && draft.value !== null && isDirty(group, draft.value, data.value.values);
const anyDirty = computed(() => SETTING_GROUPS.some((group) => dirty(group)));
const errors = (group: SettingGroup): Record<string, string> =>
  data.value && draft.value ? validateGroup(group, draft.value, data.value.values) : {};
const fieldError = (group: SettingGroup, field: string): string | null =>
  errors(group)[field] ?? null;
const readOnlyEntries = computed(() => Object.entries(data.value?.readOnly ?? {}));

async function load(): Promise<void> {
  loadError.value = null;
  try {
    const result = await adminApi.settings();
    data.value = result;
    draft.value = toDraft(result.values);
  } catch (error) {
    loadError.value = errorText(error);
  }
}
onMounted(load);

/** Take the server's answer while keeping unsaved edits of the other sections. */
function accept(result: SettingsResponse, group: SettingGroup): void {
  data.value = result;
  if (draft.value) draft.value = revertGroup(group, draft.value, result.values);
}

async function save(group: SettingGroup): Promise<void> {
  // One settings request at a time: each answer replaces the whole view.
  if (!data.value || !draft.value || saving.value !== null) return;
  if (Object.keys(errors(group)).length > 0) return;
  const patch = groupPatch(group, draft.value, data.value.values);
  if (!patch) return;
  saving.value = group;
  sectionError.value = { ...sectionError.value, [group]: undefined };
  try {
    accept(await adminApi.updateSettings(patch), group);
    notice.value = 'Saved.';
  } catch (error) {
    sectionError.value = { ...sectionError.value, [group]: errorText(error) };
  } finally {
    saving.value = null;
  }
}

function discard(group: SettingGroup): void {
  if (data.value && draft.value) draft.value = revertGroup(group, draft.value, data.value.values);
}

function askReset(group: SettingGroup): void {
  resetGroup.value = group;
  resetError.value = null;
  resetOpen.value = true;
}

async function confirmReset(): Promise<void> {
  const group = resetGroup.value;
  if (!group || saving.value !== null) return;
  saving.value = group;
  try {
    accept(await adminApi.updateSettings(resetPatch(group)), group);
    resetOpen.value = false;
    notice.value = 'Reset to the environment default.';
  } catch (error) {
    resetError.value = errorText(error);
  } finally {
    saving.value = null;
  }
}

const resetTitle = computed(
  () => SECTIONS.find((section) => section.group === resetGroup.value)?.title ?? '',
);

const leaveMessage = 'You have unsaved settings changes. Leave and discard them?';
onBeforeRouteLeave(() => !anyDirty.value || window.confirm(leaveMessage));
const beforeUnload = (event: BeforeUnloadEvent): void => {
  if (!anyDirty.value) return;
  event.preventDefault();
};
onMounted(() => window.addEventListener('beforeunload', beforeUnload));
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload));

const display = (value: unknown): string =>
  value === null || value === undefined || value === '' ? 'not set' : String(value);
</script>

<template>
  <v-container fluid class="pa-3 admin-settings">
    <v-alert v-if="loadError" type="error" variant="tonal" class="mb-3">{{ loadError }}</v-alert>
    <v-progress-linear v-if="!data && !loadError" indeterminate />
    <template v-if="data && draft">
      <v-card v-for="section in SECTIONS" :key="section.group" class="mb-3">
        <v-card-item>
          <v-card-title class="d-flex align-center flex-wrap ga-2">
            {{ section.title }}
            <v-chip
              :color="data.sources[section.group] === 'db' ? 'primary' : undefined"
              variant="tonal"
              :title="
                data.sources[section.group] === 'db'
                  ? 'Stored in the database; overrides the environment'
                  : 'Comes from the environment (no stored override)'
              "
            >
              {{ data.sources[section.group] === 'db' ? 'database' : 'environment default' }}
            </v-chip>
            <v-chip v-if="dirty(section.group)" color="warning" variant="tonal">unsaved</v-chip>
          </v-card-title>
          <v-card-subtitle class="text-wrap">{{ section.subtitle }}</v-card-subtitle>
        </v-card-item>
        <v-card-text>
          <v-alert
            v-if="!editable(section.group)"
            :icon="mdiLockOutline"
            type="info"
            variant="tonal"
            density="compact"
            class="mb-3"
          >
            {{ OWNER_ONLY_REASON[section.group] ?? 'You cannot change this setting.' }}
          </v-alert>

          <v-text-field
            v-if="section.group === 'instanceName'"
            v-model="draft.instanceName"
            label="Instance name"
            :disabled="!editable('instanceName')"
            :error-messages="fieldError('instanceName', 'instanceName')"
            counter="80"
          />

          <v-select
            v-else-if="section.group === 'mfaPolicy'"
            v-model="draft.mfaPolicy"
            label="MFA policy"
            :items="MFA_POLICIES"
            :disabled="!editable('mfaPolicy')"
            hint="Users who need 2FA and have none are held at the enrolment step."
            persistent-hint
          />

          <template v-else-if="section.group === 'smtp'">
            <v-row dense>
              <v-col cols="12" md="8">
                <v-text-field
                  v-model="draft.smtp.host"
                  label="Host"
                  :disabled="!editable('smtp')"
                  :error-messages="fieldError('smtp', 'host')"
                />
              </v-col>
              <v-col cols="6" md="2">
                <v-text-field
                  v-model="draft.smtp.port"
                  label="Port"
                  type="number"
                  :disabled="!editable('smtp')"
                  :error-messages="fieldError('smtp', 'port')"
                />
              </v-col>
              <v-col cols="6" md="2">
                <v-switch
                  v-model="draft.smtp.secure"
                  label="TLS"
                  color="primary"
                  :disabled="!editable('smtp')"
                  hide-details
                />
              </v-col>
              <v-col cols="12" md="6">
                <v-text-field
                  v-model="draft.smtp.user"
                  label="User"
                  autocomplete="off"
                  :disabled="!editable('smtp')"
                  :error-messages="fieldError('smtp', 'user')"
                />
              </v-col>
              <v-col cols="12" md="6">
                <v-text-field
                  v-model="draft.smtp.from"
                  label="Sender (From)"
                  :disabled="!editable('smtp')"
                  :error-messages="fieldError('smtp', 'from')"
                />
              </v-col>
              <v-col cols="12" md="6">
                <v-text-field
                  v-model="draft.smtp.pass"
                  label="Password"
                  type="password"
                  autocomplete="new-password"
                  :disabled="!editable('smtp') || draft.smtp.clearPass"
                  :error-messages="fieldError('smtp', 'pass')"
                  :hint="
                    draft.smtp.clearPass
                      ? 'The stored password is removed when you save.'
                      : data.values.smtp.passSet
                        ? 'A password is set. Leave empty to keep it.'
                        : 'No password is set.'
                  "
                  persistent-hint
                >
                  <template #prepend-inner>
                    <v-chip
                      :color="data.values.smtp.passSet ? 'success' : undefined"
                      variant="tonal"
                      class="mr-1"
                    >
                      {{ data.values.smtp.passSet ? 'set' : 'not set' }}
                    </v-chip>
                  </template>
                </v-text-field>
              </v-col>
              <v-col cols="12" md="6" class="d-flex align-center">
                <v-btn
                  v-if="!draft.smtp.clearPass"
                  variant="text"
                  color="error"
                  :disabled="!editable('smtp') || !data.values.smtp.passSet"
                  @click="
                    draft.smtp.clearPass = true;
                    draft.smtp.pass = '';
                  "
                >
                  Clear password
                </v-btn>
                <v-btn
                  v-else
                  variant="text"
                  :disabled="!editable('smtp')"
                  @click="draft.smtp.clearPass = false"
                >
                  Keep password
                </v-btn>
              </v-col>
            </v-row>
            <SmtpTestPanel v-if="editable('smtp')" :draft="draft.smtp" :values="data.values.smtp" />
          </template>

          <v-combobox
            v-else-if="section.group === 'models'"
            v-model="draft.models"
            label="Model suggestions"
            multiple
            chips
            closable-chips
            clearable
            :disabled="!editable('models')"
            :error-messages="fieldError('models', 'models')"
            hint="Type a model name and press Enter to add it."
            persistent-hint
          />

          <v-alert
            v-if="sectionError[section.group]"
            type="error"
            variant="tonal"
            density="compact"
            class="mt-3"
          >
            {{ sectionError[section.group] }}
          </v-alert>
        </v-card-text>
        <v-card-actions v-if="editable(section.group)">
          <v-btn
            variant="text"
            :disabled="data.sources[section.group] !== 'db' || saving !== null"
            :title="
              data.sources[section.group] !== 'db'
                ? 'Already the environment default'
                : 'Remove the stored value'
            "
            @click="askReset(section.group)"
          >
            Reset to default
          </v-btn>
          <v-spacer />
          <v-btn
            variant="text"
            :disabled="!dirty(section.group) || saving !== null"
            @click="discard(section.group)"
          >
            Discard
          </v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :disabled="
              !dirty(section.group) ||
              Object.keys(errors(section.group)).length > 0 ||
              (saving !== null && saving !== section.group)
            "
            :loading="saving === section.group"
            @click="save(section.group)"
          >
            Save
          </v-btn>
        </v-card-actions>
      </v-card>

      <v-card v-if="readOnlyEntries.length" class="mb-3">
        <v-card-item>
          <v-card-title>Sessions and environment</v-card-title>
          <v-card-subtitle class="text-wrap">
            Set by the environment at startup; change them in the deployment and restart.
          </v-card-subtitle>
        </v-card-item>
        <v-table density="compact">
          <tbody>
            <tr v-for="[key, value] in readOnlyEntries" :key="key">
              <th scope="row" class="font-weight-regular">{{ READ_ONLY_LABELS[key] ?? key }}</th>
              <td>{{ display(value) }}</td>
              <td class="text-end">
                <v-chip variant="tonal">environment (read-only)</v-chip>
              </td>
            </tr>
          </tbody>
        </v-table>
      </v-card>
    </template>

    <AdminConfirmDialog
      v-model="resetOpen"
      :title="`Reset ${resetTitle} to the default?`"
      confirm-text="Reset to default"
      color="warning"
      :loading="saving !== null"
      :error="resetError"
      :consequences="[
        'The stored value is removed and the environment value applies again.',
        ...(resetGroup === 'smtp' ? ['This resets every SMTP field, including the password.'] : []),
        'Unsaved edits in this section are discarded.',
      ]"
      @confirm="confirmReset"
    />

    <v-snackbar
      :model-value="notice !== null"
      color="success"
      :timeout="3000"
      @update:model-value="notice = null"
    >
      {{ notice }}
    </v-snackbar>
  </v-container>
</template>

<style scoped>
.admin-settings {
  max-width: 1100px;
}
</style>
