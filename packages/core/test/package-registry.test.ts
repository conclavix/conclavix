import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { normalizePackageRegistry } from '../src/domain/package-registry.js';

const TOKEN = { BOARD_TOKEN: 'x'.repeat(32) };

describe('CODE_PACKAGE_REGISTRY', () => {
  it('is unset by default, registry-only, without scopes', () => {
    const config = loadConfig(TOKEN);
    expect(config.CODE_PACKAGE_REGISTRY).toBeUndefined();
    expect(config.CODE_PACKAGE_REGISTRY_FALLBACK).toBe(false);
    expect(config.CODE_PACKAGE_REGISTRY_SCOPES).toEqual([]);
    expect(
      loadConfig({ ...TOKEN, CODE_PACKAGE_REGISTRY: ' ' }).CODE_PACKAGE_REGISTRY,
    ).toBeUndefined();
  });

  it('normalises the URL the way the helper expects it', () => {
    const config = loadConfig({
      ...TOKEN,
      CODE_PACKAGE_REGISTRY: 'http://172.31.250.10:4873',
      CODE_PACKAGE_REGISTRY_FALLBACK: 'true',
      CODE_PACKAGE_REGISTRY_SCOPES: '@Acme, @acme-tools',
    });
    expect(config.CODE_PACKAGE_REGISTRY).toBe('http://172.31.250.10:4873/');
    expect(config.CODE_PACKAGE_REGISTRY_FALLBACK).toBe(true);
    expect(config.CODE_PACKAGE_REGISTRY_SCOPES).toEqual(['@acme', '@acme-tools']);
    expect(normalizePackageRegistry('https://NPM.example.com/a/b')).toBe(
      'https://npm.example.com/a/b/',
    );
  });

  it.each([
    'ftp://172.31.250.10/',
    'http://user:secret@172.31.250.10:4873/',
    'http://172.31.250.10:4873/?x=1',
    'http://[fd00::1]:4873/',
    'http://localhost:4873/',
    'http://*.example.com/',
    'http://172.31.250.10:4873/%7Bx%7D/',
    'registry',
  ])('refuses %s', (value) => {
    expect(() => loadConfig({ ...TOKEN, CODE_PACKAGE_REGISTRY: value })).toThrow(
      /CODE_PACKAGE_REGISTRY/,
    );
  });

  it('refuses scopes that are not npm scopes', () => {
    expect(() => loadConfig({ ...TOKEN, CODE_PACKAGE_REGISTRY_SCOPES: 'acme' })).toThrow(
      /CODE_PACKAGE_REGISTRY_SCOPES/,
    );
  });
});

describe('CODE_CLONE_RETENTION_DAYS', () => {
  it('defaults to 3 days, takes 0 for keep forever', () => {
    expect(loadConfig(TOKEN).CODE_CLONE_RETENTION_DAYS).toBe(3);
    expect(loadConfig({ ...TOKEN, CODE_CLONE_RETENTION_DAYS: '' }).CODE_CLONE_RETENTION_DAYS).toBe(
      3,
    );
    expect(loadConfig({ ...TOKEN, CODE_CLONE_RETENTION_DAYS: '0' }).CODE_CLONE_RETENTION_DAYS).toBe(
      0,
    );
    expect(
      loadConfig({ ...TOKEN, CODE_CLONE_RETENTION_DAYS: '14' }).CODE_CLONE_RETENTION_DAYS,
    ).toBe(14);
  });

  it.each(['-1', '1.5', 'three', '4000'])('refuses %s', (value) => {
    expect(() => loadConfig({ ...TOKEN, CODE_CLONE_RETENTION_DAYS: value })).toThrow(
      /CODE_CLONE_RETENTION_DAYS/,
    );
  });
});
