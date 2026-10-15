import { afterEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { postgresConnectionConfig } from '../server/db.js';

afterEach(() => { vi.unstubAllEnvs(); });

describe('selected PostgreSQL environment', () => {
  it.each(['literal#fragment', 'literal/slash', 'literal?query', 'literal%percent', 'literal@at'])('keeps selected passwords literal (%s)', password => {
    vi.stubEnv('PGPASSWORD', 'inherited');
    const client = new pg.Client(postgresConnectionConfig('postgresql://operator@localhost/recovery', { PGPASSWORD: password }));
    expect(client.password).toBe(password);
    expect(process.env.PGPASSWORD).toBe('inherited');
  });

  it('keeps URL credentials ahead of PG defaults, including the URL user as the default database', () => {
    const client = new pg.Client(postgresConnectionConfig('postgresql://url-user:url%23password@url-host:5440', {
      PGUSER: 'env-user', PGHOST: 'env-host', PGPORT: '5441', PGPASSWORD: 'env-password',
    }));
    expect(client).toMatchObject({ user: 'url-user', password: 'url#password', host: 'url-host', port: 5440, database: 'url-user' });
  });

  it('uses selected connection defaults when URL fields are absent', () => {
    const client = new pg.Client(postgresConnectionConfig('postgresql:///', {
      PGUSER: 'selected-user', PGHOST: 'selected-host', PGPORT: '5441', PGDATABASE: 'selected-database', PGPASSWORD: 'selected-password',
    }));
    expect(client).toMatchObject({ user: 'selected-user', password: 'selected-password', host: 'selected-host', port: 5441, database: 'selected-database' });
  });

  it.each([{}, { PGPASSWORD: '' }])('does not revive an inherited password when the selected password is missing/cleared (%j)', env => {
    vi.stubEnv('PGPASSWORD', 'inherited');
    const config = postgresConnectionConfig('postgresql://operator@localhost/recovery', env);
    const client = new pg.Client(config);
    expect(client.password).toBe(config.password);
    expect(typeof config.password).toBe('function');
    expect((config.password as () => string)()).toBe('');
  });

  it('resolves missing defaults without rereading ambient connection options', () => {
    vi.stubEnv('PGOPTIONS', '-c search_path=unexpected');
    vi.stubEnv('PGCLIENT_ENCODING', 'latin1');
    vi.stubEnv('PGUSER', 'unexpected-user');
    vi.stubEnv('PGDATABASE', 'unexpected-database');
    vi.stubEnv('PGSSLNEGOTIATION', 'direct');
    vi.stubEnv('PGSSLMODE', 'no-verify');
    const config = postgresConnectionConfig('postgresql:///recovery', {});
    const client = new pg.Client(config);
    expect(client.user).not.toBe('unexpected-user');
    expect(client.database).toBe('recovery');
    expect(client.ssl).toBe(false);
    expect(config).toMatchObject({ options: ' ', client_encoding: 'utf8', sslnegotiation: 'postgres' });
  });

  it.each([
    ['disable', false], ['prefer', true], ['require', true], ['verify-ca', true], ['verify-full', true], ['no-verify', { rejectUnauthorized: false }],
  ])('preserves pg TLS semantics for selected PGSSLMODE=%s', (mode, ssl) => {
    vi.stubEnv('PGSSLMODE', 'no-verify');
    const client = new pg.Client(postgresConnectionConfig('postgresql://operator@localhost/recovery', { PGSSLMODE: mode as string }));
    expect(client.ssl).toEqual(ssl);
  });

  it('keeps URL TLS options ahead of selected environment TLS defaults', () => {
    const disabled = new pg.Client(postgresConnectionConfig('postgresql://operator@localhost/recovery?sslmode=disable', { PGSSLMODE: 'verify-full' }));
    expect(disabled.ssl).toBe(false);
    const verified = new pg.Client(postgresConnectionConfig('postgresql://operator@localhost/recovery?sslmode=verify-full', { PGSSLMODE: 'no-verify' }));
    expect(verified.ssl).toEqual({});
    const unverified = new pg.Client(postgresConnectionConfig('postgresql://operator@localhost/recovery?ssl=no-verify', { PGSSLMODE: 'verify-full' }));
    expect(unverified.ssl).toEqual({ rejectUnauthorized: false });
    expect(postgresConnectionConfig('postgresql://operator@localhost/recovery?sslnegotiation=direct', { PGSSLNEGOTIATION: 'postgres' })).toMatchObject({ ssl: true, sslnegotiation: 'direct' });
  });

  it('does not turn unknown URL query parameters into pool options', () => {
    const config = postgresConnectionConfig('postgresql://operator@localhost/recovery?max=1&connectionString=other', {});
    expect(config).not.toHaveProperty('max');
    expect(config).not.toHaveProperty('connectionString');
  });

  it('retains pg validation for invalid or unencrypted direct TLS negotiation', () => {
    expect(() => new pg.Client(postgresConnectionConfig('postgresql://operator@localhost/recovery', { PGSSLNEGOTIATION: 'invalid' }))).toThrow('Invalid sslnegotiation');
    expect(() => new pg.Client(postgresConnectionConfig('postgresql://operator@localhost/recovery', { PGSSLMODE: 'disable', PGSSLNEGOTIATION: 'direct' }))).toThrow('requires SSL');
  });
});
