import 'vuetify/styles';
import 'vuetiwatch/styles.css';
import { createVuetify } from 'vuetify';
import { aliases } from 'vuetify/iconsets/mdi-svg';
import { vuetiwatchThemes } from 'vuetiwatch';
import { initialThemeName } from '../stores/theme';
import { mdiSvgNamed } from './icons';

export const vuetify = createVuetify({
  icons: { defaultSet: 'mdi', aliases, sets: { mdi: mdiSvgNamed } },
  theme: {
    defaultTheme: initialThemeName(),
    themes: vuetiwatchThemes,
  },
  defaults: {
    VChip: { size: 'small' },
  },
});
