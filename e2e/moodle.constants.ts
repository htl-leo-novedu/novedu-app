// Single source of truth for the fake Moodle platform's address (docs/testing.md,
// "Moodle"). playwright.config.ts points the app's three Moodle connection
// variables at it, and e2e/moodle-roundtrip.live.spec.ts starts the fake on this
// port inside the spec. Its address is the configured issuer, so it is never a
// real Moodle's. Change the port HERE only.

export const FAKE_MOODLE_PORT = 34569;
export const FAKE_MOODLE_ISSUER = `http://127.0.0.1:${FAKE_MOODLE_PORT}`;
export const FAKE_MOODLE_CLIENT_ID = "novedu-e2e-client";
export const FAKE_MOODLE_DEPLOYMENT_ID = "1";
