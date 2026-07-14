# Security Notes

## Credential Vault

Quill Personal stores a single random vault key in the operating-system credential store under the intentionally selected `com.ryoyamada.quill` service namespace. API keys and OAuth tokens are encrypted with that key in the local-only `secrets.db`; values are never synced.

During upgrades from versions that stored a credential in plaintext, the value is staged locally until the user explicitly chooses **Encrypt now** from AI settings. The migration notice exposes only a count, never the values. Quill does not delete staged credentials automatically because deleting an API key without the user's confirmation would make the configured service unrecoverable.

## Content Security Policy

The application deliberately keeps `style-src 'unsafe-inline'` in its Tauri CSP. The React reader and vendored Foliate engine apply reader-theme and pagination styles at runtime, including style attributes and injected style blocks. Script execution remains restricted to `script-src 'self'`; no raw AI or book HTML is executed. Removing inline styles requires a Foliate-compatible nonce or stylesheet-API migration and must be verified against EPUB, PDF, and text reader flows before changing the policy.
