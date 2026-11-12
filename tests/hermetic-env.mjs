// Loaded before every test file (npm test): a run from inside a live Paseo agent session must match CI, so the
// session's Follow-up and Paseo variables (FOLLOW_UP_CLI, PASEO_AGENT_ID, PASEO_HOME…) never leak into tests or
// the hooks and bridges they spawn. Tests that need one set it themselves.
for (const key of Object.keys(process.env)) if (/^(FOLLOW_UP_|FOLLOW_UP_|PASEO_)/.test(key)) delete process.env[key];
// Every Store write is also validated whole and compared with the per-workspace validation it uses in the worker.
process.env.FOLLOW_UP_STORE_FULL_VALIDATION = "1";
