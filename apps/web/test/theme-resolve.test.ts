import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATE,
  TEMPLATES,
  hasModeVariants,
  resolveTheme,
  sanitizeLayer,
  siblingsOf,
  variantFor,
} from '../src/theme/resolve';

describe('theme resolution', () => {
  it('defaults to the atlas family following the OS', () => {
    expect(DEFAULT_TEMPLATE).toBe('atlas');
    expect(resolveTheme({ systemDark: false })).toMatchObject({
      template: 'atlas',
      mode: 'system',
      name: 'atlas',
      dark: false,
      modeAvailable: true,
    });
    expect(resolveTheme({ systemDark: true }).name).toBe('atlasDark');
  });

  it('layers instance default < user < local per field', () => {
    const sources = {
      instanceDefault: { template: 'paper', mode: 'light' },
      user: { template: 'neon' },
      local: { mode: 'dark' },
      systemDark: false,
    } as const;
    expect(resolveTheme(sources)).toMatchObject({ template: 'neon', mode: 'dark' });
    expect(resolveTheme({ ...sources, local: {} })).toMatchObject({ mode: 'light' });
    expect(resolveTheme({ ...sources, user: {} }).template).toBe('paper');
    expect(resolveTheme({ ...sources, local: { template: 'slate' } }).template).toBe('slate');
  });

  it('ignores invalid values in any layer', () => {
    const resolved = resolveTheme({
      instanceDefault: { template: 'nope' as never },
      user: { mode: 'dim' as never },
      local: { template: 'calm' },
      systemDark: false,
    });
    expect(resolved).toMatchObject({ template: 'calm', mode: 'system' });
    expect(sanitizeLayer(null)).toEqual({});
    expect(sanitizeLayer('atlas')).toEqual({});
    expect(sanitizeLayer({ template: 'lux', mode: 'x', extra: 1 })).toEqual({ template: 'lux' });
  });

  it('jumps to the family sibling for light and dark', () => {
    expect(
      resolveTheme({ local: { template: 'atlas', mode: 'dark' }, systemDark: false }).name,
    ).toBe('atlasDark');
    expect(
      resolveTheme({ local: { template: 'atlasDark', mode: 'light' }, systemDark: true }).name,
    ).toBe('atlas');
    expect(
      resolveTheme({ local: { template: 'atlasSepia', mode: 'light' }, systemDark: true }).name,
    ).toBe('atlasSepia');
    expect(
      resolveTheme({ local: { template: 'atlasSepia', mode: 'dark' }, systemDark: false }).name,
    ).toBe('atlasDark');
  });

  it('follows the OS in system mode', () => {
    const local = { template: 'atlasSepia', mode: 'system' } as const;
    expect(resolveTheme({ local, systemDark: true }).name).toBe('atlasDark');
    expect(resolveTheme({ local, systemDark: false }).name).toBe('atlasSepia');
  });

  it('keeps a template without siblings and marks the mode unavailable', () => {
    for (const template of ['neon', 'paper', 'brutalist', 'graphite'] as const) {
      for (const systemDark of [true, false]) {
        const resolved = resolveTheme({ local: { template, mode: 'system' }, systemDark });
        expect(resolved.name).toBe(template);
        expect(resolved.modeAvailable).toBe(false);
      }
    }
    expect(
      resolveTheme({ local: { template: 'neon', mode: 'light' }, systemDark: false }).dark,
    ).toBe(true);
  });

  it('derives siblings from the vuetiwatch family metadata', () => {
    expect(TEMPLATES).toHaveLength(19);
    expect(siblingsOf('atlasDark').map((t) => t.name)).toEqual([
      'atlas',
      'atlasDark',
      'atlasSepia',
    ]);
    expect(siblingsOf('neon')).toEqual([]);
    expect(hasModeVariants('atlas')).toBe(true);
    expect(hasModeVariants('aurora')).toBe(false);
    expect(variantFor('atlas', true)).toBe('atlasDark');
    expect(variantFor('candy', true)).toBe('candy');
  });
});
