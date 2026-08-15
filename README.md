# Instagram GitHub Actions Engine

A minimal Playwright worker for manual GitHub Actions runs.

## Inputs / GitHub Secrets

Create these repository secrets:

- `INSTAGRAM_POST_URLS` — one post/reel URL per line, or comma-separated.
- `INSTAGRAM_KEYWORDS` — one keyword per line, or comma-separated.
- `INSTAGRAM_COMMENT_REPLY` — exact reply text.
- `INSTAGRAM_DM_REPLY` — exact DM text.
- `INSTAGRAM_SESSION_B64` — recommended: Base64 of a Playwright authenticated storage-state JSON.
- `INSTAGRAM_USERNAME` — optional fallback.
- `INSTAGRAM_PASSWORD` — optional fallback.

The first four are the workflow inputs. The session secret is the preferred authentication method for an account protected by 2FA.

## 2FA / session setup

Run locally once:

```bash
npm install
npx playwright install chromium
npm run auth
```

The script opens Chromium. Log in to Instagram and complete 2FA. Press Enter in the terminal after the account is fully logged in.

Put the resulting Base64 string into the `INSTAGRAM_SESSION_B64` repository secret. Do not commit `playwright/.auth/instagram.json`.

## Run

GitHub → Actions → **Instagram automation** → **Run workflow**.

The engine processes URLs in order, scans comments in page order, matches keywords using normalized contains matching plus a small typo tolerance, replies to matched comments, opens the commenter profile, opens Message directly or via the profile menu, handles common message categories, sends the DM, and continues.

On errors it creates screenshots and JSON run artifacts under `artifacts/`. GitHub Actions uploads them to the run automatically.

## Important

Instagram's web UI is dynamic and can change. The code intentionally uses semantic/fallback locators rather than hard-coded pixel coordinates, but no browser automation against a third-party UI can guarantee permanence.

Use an account and automation pattern permitted by Instagram's applicable terms and policies. GitHub Actions secrets are used for credentials; never hard-code them in the repository.
