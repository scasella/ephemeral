// Direct Vitest invocation must be isolated too. The npm runner additionally
// starts Node with an allowlisted environment and a disposable HOME.
for (const key of Object.keys(process.env)) {
  if (/^(?:E2B_|GITHUB_|OPENAI_|CODEX_|AWS_|EPHEMERAL_|PREVIEW_|SESSION_)/.test(key) ||
      ['PUBLIC_URL', 'HOST', 'PORT', 'DATABASE_URL', 'DATA_DIR', 'ENCRYPTION_KEY', 'ALLOWED_GITHUB_IDS'].includes(key)) delete process.env[key];
}
process.env.EPHEMERAL_SKIP_DOTENV = '1';
