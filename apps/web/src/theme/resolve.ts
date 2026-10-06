import { themeList, type VuetiwatchTheme, type VuetiwatchThemeName } from 'vuetiwatch';

export const THEME_MODES = ['light', 'dark', 'system'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];
export type TemplateName = VuetiwatchThemeName;

export interface ThemePreference {
  template: TemplateName;
  mode: ThemeMode;
}

export type ThemeLayer = Partial<ThemePreference>;

export interface ThemeSources {
  instanceDefault?: ThemeLayer;
  user?: ThemeLayer;
  local?: ThemeLayer;
  systemDark: boolean;
}

export interface ResolvedTheme extends ThemePreference {
  name: TemplateName;
  dark: boolean;
  modeAvailable: boolean;
}

export const DEFAULT_TEMPLATE: TemplateName = 'atlas';
export const DEFAULT_MODE: ThemeMode = 'system';

export const TEMPLATES: readonly VuetiwatchTheme<TemplateName>[] = themeList;

const BY_NAME = new Map<string, VuetiwatchTheme<TemplateName>>(TEMPLATES.map((t) => [t.name, t]));

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);
}

export function isTemplateName(value: unknown): value is TemplateName {
  return typeof value === 'string' && BY_NAME.has(value);
}

export function templateOf(name: TemplateName): VuetiwatchTheme<TemplateName> {
  const template = BY_NAME.get(name);
  if (!template) throw new Error(`Unknown theme template: ${name}`);
  return template;
}

export function siblingsOf(name: TemplateName): readonly VuetiwatchTheme<TemplateName>[] {
  const family = templateOf(name).meta.family;
  return family ? TEMPLATES.filter((t) => t.meta.family === family) : [];
}

export function hasModeVariants(name: TemplateName): boolean {
  const siblings = siblingsOf(name);
  return siblings.some((t) => t.meta.dark) && siblings.some((t) => !t.meta.dark);
}

export function variantFor(name: TemplateName, dark: boolean): TemplateName {
  if (templateOf(name).meta.dark === dark) return name;
  return siblingsOf(name).find((t) => t.meta.dark === dark)?.name ?? name;
}

export function sanitizeLayer(layer: unknown): ThemeLayer {
  if (!layer || typeof layer !== 'object') return {};
  const { template, mode } = layer as Record<string, unknown>;
  return {
    ...(isTemplateName(template) ? { template } : {}),
    ...(isThemeMode(mode) ? { mode } : {}),
  };
}

export function resolveTheme(sources: ThemeSources): ResolvedTheme {
  const merged: ThemePreference = {
    template: DEFAULT_TEMPLATE,
    mode: DEFAULT_MODE,
    ...sanitizeLayer(sources.instanceDefault),
    ...sanitizeLayer(sources.user),
    ...sanitizeLayer(sources.local),
  };
  const modeAvailable = hasModeVariants(merged.template);
  const wantDark = merged.mode === 'system' ? sources.systemDark : merged.mode === 'dark';
  const name = modeAvailable ? variantFor(merged.template, wantDark) : merged.template;
  return { ...merged, name, dark: templateOf(name).meta.dark, modeAvailable };
}
