import { mdiClose } from '@mdi/js';
import { vuetiwatchDefaults } from 'vuetiwatch';
import { describe, expect, it } from 'vitest';
import { THEME_ICONS, toSvgIcon } from '../src/plugins/icons';

function iconNames(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string' && value.startsWith('mdi-')) found.add(value);
  else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) iconNames(child, found);
  }
  return found;
}

describe('theme icons', () => {
  it('maps every font icon name the vuetiwatch themes use to an SVG path', () => {
    const missing = [...iconNames(vuetiwatchDefaults)].filter((name) => !THEME_ICONS[name]);
    expect(missing).toEqual([]);
  });

  it('passes paths and other values through unchanged', () => {
    expect(toSvgIcon('mdi-close')).toBe(mdiClose);
    expect(toSvgIcon(mdiClose)).toBe(mdiClose);
    expect(toSvgIcon(undefined)).toBeUndefined();
  });
});
