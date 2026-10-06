import { createPinia } from 'pinia';
import { createApp } from 'vue';
import { createVuetiwatch } from 'vuetiwatch';
import App from './App.vue';
import { vuetify } from './plugins/vuetify';
import { router } from './router';
import { TEMPLATES } from './theme/resolve';

createApp(App)
  .use(createPinia())
  .use(router)
  .use(vuetify)
  .use(createVuetiwatch(vuetify, { themes: TEMPLATES }))
  .mount('#app');
