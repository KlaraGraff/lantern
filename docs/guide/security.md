# Security Notes

## Local Credentials

Lantern stores API keys and OAuth tokens in the local-only `secrets.db`. Routine saves, model discovery, connection tests, reading lookups, and AI chats read that database directly and do not access the operating-system credential store. Credential values are filtered from settings APIs, never returned to the webview, never written to logs, and never included in library sync, snapshots, or the MCP surface.

The database uses SQLite `secure_delete=ON` with `journal_mode=DELETE`, avoiding a long-lived WAL history of replaced credentials. On Unix platforms, `secrets.db` and its transient SQLite journal are restricted to the current user (`0600`). `secure_delete` applies to SQLite-managed pages; it cannot erase Time Machine copies, filesystem snapshots, storage-device history, or data already copied by another process. This is intentionally local plaintext storage: another process already running as the same operating-system user may be able to read it. The tradeoff avoids repeated Keychain authorization prompts, similar to common local developer credential files. Disk encryption and a protected user account remain important.

### The Retired v1.4 Vault

Lantern no longer talks to the operating-system credential store at all — not at startup, not
during AI use, and not through any user-visible action. Two inherited import paths were removed
in v2.5.0: the v1.4 AES-GCM vault, whose master key lived in the Keychain under the pre-fork
service id `com.ryoyamada.quill`, and a still older layout that kept one Keychain item per
credential. With them went the `aes-gcm`, `zeroize`, `keyring`, and `security-framework`
dependencies.

Opening `secrets.db` now drops the three tables those paths used (`encrypted_secrets`,
`legacy_secret_candidates`, `secret_migration_tombstones`) rather than leaving rows behind that
nothing can read. Nothing is deleted from the Keychain: a credential that only ever lived there
is still there, and Lantern simply stops looking. If a very old install still had an unimported
credential, the fix is to re-enter the API key in AI settings, the same as setting one up for
the first time.

Credential sync is not implemented. In particular, credentials are not placed in the iCloud event log or snapshot. Encrypted credential sync requires a stable signed application identity and a formally provisioned iCloud Keychain access group; the current ad-hoc distribution cannot safely provide that identity.

## MCP Data Access

Lantern's local MCP subprocess can read library metadata, collections, book full-text indexes and existing summaries, highlights, bookmarks, notes, vocabulary review state, lookup history, word marks, the user's CEFR language profile, and chat history. Full-text search and summaries apply the same global and per-book spoiler-guard settings as in-app book chat. MCP has no bypass parameter.

MCP full-text search is lexical FTS only. It does not read embedding vectors, request embeddings, generate summaries, or make any other model call. Lookup-history responses omit raw AI result JSON and provider-profile identifiers; device identity and sync infrastructure are also excluded. Language assessments are read-only through MCP: creating, editing, deleting, and estimating assessments remain in the app.

Mutating tools, including batch book/collection operations and on-demand local index construction, require the explicit **Allow write access** setting. The setting is checked again for every write so revoking it takes effect during an existing MCP session.

## Content Security Policy

The application deliberately keeps `style-src 'unsafe-inline'` in its Tauri CSP. The React reader and vendored Foliate engine apply reader-theme and pagination styles at runtime, including style attributes and injected style blocks. Script execution remains restricted to `script-src 'self'`; no raw AI or book HTML is executed. Removing inline styles requires a Foliate-compatible nonce or stylesheet-API migration and must be verified against EPUB, PDF, and text reader flows before changing the policy.
