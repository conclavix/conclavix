<script setup lang="ts">
import { mdiCheck, mdiMinus } from '@mdi/js';
import { onMounted, ref } from 'vue';
import { adminApi, type RolesOverview } from '../../admin/api';
import { errorText } from '../../admin/gating';

const overview = ref<RolesOverview | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);

onMounted(async () => {
  try {
    overview.value = await adminApi.roles();
  } catch (cause) {
    error.value = errorText(cause);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <v-container fluid class="pa-3">
    <v-card>
      <v-card-title>Roles</v-card-title>
      <v-card-subtitle class="text-wrap">
        Conclavix has four fixed roles. A user's role is changed on the
        <router-link :to="{ name: 'admin-users' }">Users</router-link> page.
      </v-card-subtitle>
      <v-progress-linear v-if="loading" indeterminate />
      <v-alert v-if="error" type="error" variant="tonal" class="ma-4">{{ error }}</v-alert>
      <template v-if="overview">
        <v-card-text>
          <v-row dense>
            <v-col v-for="role in overview.roles" :key="role.role" cols="12" sm="6" lg="3">
              <v-card variant="tonal" class="h-100">
                <v-card-title class="d-flex align-center">
                  {{ role.role }}
                  <v-spacer />
                  <v-btn
                    variant="text"
                    size="small"
                    :to="{ name: 'admin-users', query: { role: role.role } }"
                  >
                    {{ role.users }} {{ role.users === 1 ? 'user' : 'users' }}
                  </v-btn>
                </v-card-title>
                <v-card-text>
                  <p>{{ role.description }}</p>
                  <p v-if="role.users !== role.activeUsers" class="text-caption mt-2">
                    {{ role.users - role.activeUsers }} banned
                  </p>
                </v-card-text>
              </v-card>
            </v-col>
          </v-row>
        </v-card-text>
        <v-table density="compact" class="roles-matrix">
          <thead>
            <tr>
              <th scope="col">Capability</th>
              <th v-for="role in overview.roles" :key="role.role" scope="col" class="text-center">
                {{ role.role }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="capability in overview.capabilities" :key="capability.key">
              <th scope="row" class="font-weight-regular">
                <div class="font-weight-medium">{{ capability.key }}</div>
                <div class="text-caption text-medium-emphasis">{{ capability.description }}</div>
              </th>
              <td v-for="role in overview.roles" :key="role.role" class="text-center">
                <v-icon
                  v-if="role.capabilities.includes(capability.key)"
                  :icon="mdiCheck"
                  color="success"
                  :aria-label="`${role.role} may ${capability.key}`"
                />
                <v-icon
                  v-else
                  :icon="mdiMinus"
                  class="text-disabled"
                  :aria-label="`${role.role} may not ${capability.key}`"
                />
              </td>
            </tr>
          </tbody>
        </v-table>
        <v-card-text class="text-caption text-medium-emphasis">
          Owners and admins share every capability; only owners grant or change the owner role, the
          MFA policy and SMTP. At least one active owner always remains.
        </v-card-text>
      </template>
    </v-card>
  </v-container>
</template>

<style scoped>
.roles-matrix th[scope='row'] {
  max-width: 420px;
}
</style>
