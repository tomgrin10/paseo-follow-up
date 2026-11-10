// Loaded before every test file (npm test): a run from inside a live Paseo agent session must match CI, so the
// session's Follow-up and Paseo variables (FOLLOW_THROUGH_CLI, PASEO_AGENT_ID, PASEO_HOME…) never leak into tests or
// the hooks and bridges they spawn. Tests that need one set it themselves.
for (const key of Object.keys(process.env)) if (/^(FOLLOW_THROUGH_|FOLLOW_UP_|PASEO_)/.test(key)) delete process.env[key];
