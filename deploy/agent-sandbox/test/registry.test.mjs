import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRunArgs } from '../args.mjs';
import { mergeConfig } from '../config.mjs';
import { managedSettings, unitProperties } from '../policy.mjs';
import {
  applyRegistry,
  normalizePackageRegistry,
  registryEnvironment,
  sandboxDomains,
} from '../registry.mjs';

const REGISTRY = 'http://172.31.250.10:4873/';
const ids = { agent: { uid: 999, gid: 987 }, owner: { uid: 995, gid: 986 }, codeGid: 990 };

const runArgs = (...extra) =>
  parseRunArgs([
    'run',
    '--run-id',
    'a'.repeat(24),
    '--project',
    'b'.repeat(24),
    '--issue',
    'CVX-3',
    '--status-tag',
    'c'.repeat(32),
    ...extra,
    '--',
    '-p',
    '--strict-mcp-config',
    '--permission-mode',
    'dontAsk',
    '--setting-sources',
    'user',
  ]);

describe('normalizePackageRegistry', () => {
  it('normalises http(s) URLs with an IPv4 address or a host name', () => {
    assert.equal(normalizePackageRegistry('http://172.31.250.10:4873'), REGISTRY);
    assert.equal(
      normalizePackageRegistry('https://Npm.Example.com/repo/npm'),
      'https://npm.example.com/repo/npm/',
    );
  });

  for (const bad of [
    'ftp://172.31.250.10/',
    'http://user:pw@172.31.250.10:4873/',
    'http://172.31.250.10:4873/?a=b',
    'http://172.31.250.10:4873/#x',
    'http://[fd00::1]:4873/',
    'http://*.example.com/',
    'http://localhost:4873/',
    'http://172.31.250.10:4873/a%20b/',
    'http://172.31.250.10:4873/$HOME/',
    'not a url',
  ]) {
    it(`refuses ${bad}`, () => assert.equal(normalizePackageRegistry(bad), null));
  }
});

describe('registry options and configuration', () => {
  it('parses --package-registry and --registry-fallback, registry-only by default', () => {
    const options = runArgs('--package-registry', REGISTRY);
    assert.equal(options.packageRegistry, REGISTRY);
    assert.equal(options.registryFallback, false);
    assert.equal(
      runArgs('--package-registry', REGISTRY, '--registry-fallback', 'yes').registryFallback,
      true,
    );
  });

  it('refuses a registry URL that is not in normalised form, and odd fallback values', () => {
    assert.throws(() => runArgs('--package-registry', 'http://172.31.250.10:4873'), /invalid/);
    assert.throws(() => runArgs('--registry-fallback', 'maybe'), /invalid/);
  });

  it('accepts only normalised registry URLs in packageRegistries', () => {
    assert.deepEqual(mergeConfig({ packageRegistries: [REGISTRY] }).packageRegistries, [REGISTRY]);
    assert.deepEqual(mergeConfig({}).packageRegistries, []);
    for (const value of [['http://172.31.250.10:4873'], ['http://*.example.com/'], REGISTRY]) {
      assert.throws(() => mergeConfig({ packageRegistries: value }), /packageRegistries/);
    }
  });

  it('refuses a run registry the configuration does not list', () => {
    const options = runArgs('--package-registry', REGISTRY);
    assert.throws(() => applyRegistry(options, mergeConfig({})), /not listed/);
    assert.throws(
      () =>
        applyRegistry(options, mergeConfig({ packageRegistries: ['http://172.31.250.11:4873/'] })),
      /not listed/,
    );
  });

  it('opens exactly the registry address for the unit', () => {
    const options = runArgs('--package-registry', REGISTRY);
    options.allowAddresses = [];
    applyRegistry(options, mergeConfig({ packageRegistries: [REGISTRY] }));
    assert.deepEqual(options.allowAddresses, ['172.31.250.10']);
    const named = runArgs('--package-registry', 'https://npm.example.com/');
    named.allowAddresses = [];
    applyRegistry(named, mergeConfig({ packageRegistries: ['https://npm.example.com/'] }));
    assert.deepEqual(named.allowAddresses, []);
  });
});

describe('registry in the unit and the managed settings', () => {
  const config = mergeConfig({ packageRegistries: [REGISTRY] });

  it('changes nothing without a registry', () => {
    const options = runArgs();
    assert.deepEqual(sandboxDomains(config, options), [
      'files.pythonhosted.org',
      'pypi.org',
      'registry.npmjs.org',
    ]);
    assert.deepEqual(registryEnvironment(options.packageRegistry), []);
    const properties = unitProperties(config, options, ids);
    assert.equal(
      properties.some((p) => p.startsWith('IPAddressAllow=')),
      false,
    );
    assert.equal(
      properties.some((p) => p.startsWith('Environment=')),
      false,
    );
  });

  it('replaces the public npm registry with the run registry unless it falls back', () => {
    const only = runArgs('--package-registry', REGISTRY, '--allow-domain', 'registry.yarnpkg.com');
    assert.deepEqual(managedSettings(config, only).sandbox.network.allowedDomains, [
      '172.31.250.10',
      'files.pythonhosted.org',
      'pypi.org',
      'registry.yarnpkg.com',
    ]);
    const fallback = runArgs('--package-registry', REGISTRY, '--registry-fallback', 'yes');
    assert.deepEqual(sandboxDomains(config, fallback), [
      '172.31.250.10',
      'files.pythonhosted.org',
      'pypi.org',
      'registry.npmjs.org',
    ]);
  });

  it('points npm, pnpm and yarn at the registry through Environment= properties', () => {
    const options = runArgs('--package-registry', REGISTRY);
    options.allowAddresses = [];
    applyRegistry(options, config);
    const properties = unitProperties(config, options, ids);
    for (const entry of [
      `Environment=npm_config_registry=${REGISTRY}`,
      `Environment=YARN_REGISTRY=${REGISTRY}`,
      `Environment=YARN_NPM_REGISTRY_SERVER=${REGISTRY}`,
      'Environment=YARN_UNSAFE_HTTP_WHITELIST=172.31.250.10',
      'IPAddressAllow=172.31.250.10',
    ]) {
      assert.ok(properties.includes(entry), entry);
    }
    assert.equal(
      registryEnvironment('https://npm.example.com/').some((p) => p.includes('UNSAFE')),
      false,
    );
  });
});
