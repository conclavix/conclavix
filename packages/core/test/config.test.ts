import { describe, expect, it } from 'vitest';
import { ConfigError, credentialWarnings, loadConfig, requireAuthSecret } from '../src/config.js';

const TOKEN = { BOARD_TOKEN: 'x'.repeat(32) };

describe('loadConfig', () => {
  it('applies defaults for an empty environment', () => {
    const config = loadConfig(TOKEN);
    expect(config.PORT).toBe(3300);
    expect(config.NODE_ENV).toBe('development');
  });

  it('coerces and keeps explicit values', () => {
    const config = loadConfig({
      ...TOKEN,
      PORT: '4100',
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
    });
    expect(config.PORT).toBe(4100);
    expect(config.NODE_ENV).toBe('production');
    expect(config.LOG_LEVEL).toBe('warn');
  });

  it('rejects an invalid port with a readable message', () => {
    expect.assertions(3);
    expect(() => loadConfig({ ...TOKEN, PORT: '70000' })).toThrow(ConfigError);
    try {
      loadConfig({ ...TOKEN, PORT: 'abc' });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues[0]).toMatch(/^PORT:/);
    }
  });

  it('rejects a malformed database URI', () => {
    expect(() => loadConfig({ ...TOKEN, MONGO_URI: 'not a uri' })).toThrow(/MONGO_URI/);
  });

  it('accepts a plain agent user name and treats an empty one as unset', () => {
    expect(loadConfig({ ...TOKEN, AGENT_USER: 'cvx-agent' }).AGENT_USER).toBe('cvx-agent');
    expect(loadConfig({ ...TOKEN, AGENT_USER: '' }).AGENT_USER).toBeUndefined();
    expect(loadConfig(TOKEN).SUDO_BIN).toBe('/usr/bin/sudo');
    expect(() => loadConfig({ ...TOKEN, AGENT_USER: '-u root' })).toThrow(/AGENT_USER/);
  });

  it('warns about database URLs without credentials and never repeats a password', () => {
    expect(
      credentialWarnings({
        MONGO_URI: 'mongodb://127.0.0.1:27017/conclavix',
        REDIS_URL: 'redis://127.0.0.1:6379',
      }),
    ).toEqual([
      'MONGO_URI has no credentials; MongoDB should require authentication',
      'REDIS_URL has no password; Redis should require authentication',
    ]);
    const secured = {
      MONGO_URI: 'mongodb://conclavix:s3cret-mongo@mongo:27017/conclavix?replicaSet=rs0',
      REDIS_URL: 'redis://conclavix:s3cret-redis@redis:6379',
    };
    expect(credentialWarnings(secured)).toEqual([]);
    expect(credentialWarnings({ MONGO_URI: secured.MONGO_URI })).toEqual([]);
    expect(credentialWarnings({ ...secured, MONGO_URI: 'mongodb://conclavix@mongo/x' })).toEqual([
      'MONGO_URI has no credentials; MongoDB should require authentication',
    ]);
  });

  it('does not echo a password from an invalid database URL', () => {
    expect.assertions(1);
    try {
      loadConfig({ ...TOKEN, MONGO_URI: 'mongodb://u:s3cret-value@ bad host/x' });
    } catch (error) {
      expect(String(error)).not.toContain('s3cret-value');
    }
  });

  it('treats the board token as optional but rejects a short one', () => {
    expect(loadConfig({}).BOARD_TOKEN).toBeUndefined();
    expect(() => loadConfig({ BOARD_TOKEN: 'short' })).toThrow(/BOARD_TOKEN/);
  });

  it('requires an auth secret only where the API asks for it', () => {
    expect(() => requireAuthSecret(loadConfig({}))).toThrow(/AUTH_SECRET/);
    expect(() => loadConfig({ AUTH_SECRET: 'short' })).toThrow(/AUTH_SECRET/);
    expect(requireAuthSecret(loadConfig({ AUTH_SECRET: 's'.repeat(32) }))).toBe('s'.repeat(32));
  });

  it('parses auth, mail and model defaults', () => {
    const config = loadConfig({ CONCLAVIX_MODELS: ' opus, sonnet ,,', SMTP_SECURE: 'true' });
    expect(config.CONCLAVIX_MODELS).toEqual(['opus', 'sonnet']);
    expect(config.SMTP_SECURE).toBe(true);
    expect(config.MFA_POLICY).toBe('required_for_admins');
    expect(config.SESSION_TTL_HOURS).toBe(168);
    expect(() => loadConfig({ MFA_POLICY: 'never' })).toThrow(/MFA_POLICY/);
  });

  it('requires HINDSIGHT_URL when the hindsight memory backend is chosen', () => {
    expect(() => loadConfig({ ...TOKEN, MEMORY_BACKEND: 'hindsight' })).toThrow(/HINDSIGHT_URL/);
    expect(
      loadConfig({ ...TOKEN, MEMORY_BACKEND: 'hindsight', HINDSIGHT_URL: 'http://h:8888' })
        .MEMORY_BACKEND,
    ).toBe('hindsight');
    expect(loadConfig(TOKEN).MEMORY_BACKEND).toBe('builtin');
  });

  it('parses the model suggestion list and trims entries and drops blanks', () => {
    expect(loadConfig(TOKEN).CONCLAVIX_MODELS).toEqual(['opus', 'sonnet', 'haiku']);
    expect(
      loadConfig({ ...TOKEN, CONCLAVIX_MODELS: ' claude-opus-5-5, ,claude-haiku-4-5,' })
        .CONCLAVIX_MODELS,
    ).toEqual(['claude-opus-5-5', 'claude-haiku-4-5']);
  });

  it('rejects a model list entry that is not a model name', () => {
    expect(() => loadConfig({ ...TOKEN, CONCLAVIX_MODELS: 'opus,bad name' })).toThrow(
      /CONCLAVIX_MODELS/,
    );
  });

  it('bounds the startup wait for dependencies', () => {
    expect(loadConfig(TOKEN).STARTUP_WAIT_SECONDS).toBe(120);
    expect(loadConfig({ ...TOKEN, STARTUP_WAIT_SECONDS: '0' }).STARTUP_WAIT_SECONDS).toBe(0);
    expect(() => loadConfig({ ...TOKEN, STARTUP_WAIT_SECONDS: '3601' })).toThrow(
      /STARTUP_WAIT_SECONDS/,
    );
  });

  it.each(['', '   ', '\t\n'])('defaults an empty startup wait value %j', (value) => {
    expect(loadConfig({ ...TOKEN, STARTUP_WAIT_SECONDS: value }).STARTUP_WAIT_SECONDS).toBe(120);
  });

  it('rejects a non-numeric startup wait value', () => {
    expect(() => loadConfig({ ...TOKEN, STARTUP_WAIT_SECONDS: 'abc' })).toThrow(
      /STARTUP_WAIT_SECONDS/,
    );
  });
});
