import path from "node:path";

// Shared between playwright.config.ts (webServer env), e2e/image-root.setup.ts
// (provisioning) and e2e/image-root.utils.ts (the mismatch assertion). Kept in
// its own module, free of `test()` calls, mirroring e2e/auth.constants.ts.
//
// A fixed, repo-relative directory — gitignored (`/e2e/.image-root/`), wiped
// and re-provisioned by `image-root.setup.ts` (the `setup` project) on every run, exactly
// like `e2e/.auth/` for session state. NEVER point IMAGE_STORAGE_ROOT at this
// path for anything other than the Playwright-driven dev server: the setup
// project deletes it wholesale before every run.
export const E2E_IMAGE_ROOT = path.resolve(process.cwd(), "e2e", ".image-root");
