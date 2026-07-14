# Privacy Policy

Last updated: July 12, 2026

## Overview

Quill Personal is a local-first ebook reader. Your library and learning data stay on your Mac unless you choose to use an external AI provider or enable folder-based sync.

## Local Storage

Books, reading progress, highlights, bookmarks, lookup history, vocabulary, and chats are stored locally. The operating system credential store contains one random vault master key (`com.ryoyamada.quill` / `vault-master-key-v1`). API keys and OAuth tokens are encrypted with that key and stored only in the local secrets database; they are not stored as separate Password entries. The app does not expose secret values to its webview or sync them to iCloud.

When an existing installation needs to import a credential saved by an older version, Quill first shows an in-app explanation. It requests access from the operating system only after the user explicitly confirms the import. Cancelling or denying the request stops that operation and does not start an automatic prompt loop.

## iCloud Drive Folder Sync

Sync is optional. When enabled, you explicitly select a folder in your iCloud Drive. Quill Personal stores sync logs, book files, covers, and synchronized library records in that folder so another Mac can use the same library after selecting the same folder. Lookup history and its "looked up" markers remain local to each Mac. This edition does not use or access the original Quill private iCloud container.

## AI Features

Word lookup, translation, passage explanation, and chat send the selected text or message directly to the AI provider you configure. That provider's privacy policy and terms apply to those requests. Quill Personal does not relay the requests through a service it operates.

## Analytics

Quill Personal does not include analytics, telemetry, or third-party tracking SDKs.

## Data Deletion

You can delete imported books, highlights, bookmarks, vocabulary, chats, and local app data. Disabling sync copies available synced books back to the Mac and keeps the selected folder authorization for a later re-enable; deleting the shared folder itself is your responsibility.

## Contact

For this edition, open an issue at [KlaraGraff/quill](https://github.com/KlaraGraff/quill/issues). The original Quill maintainers do not provide support for Quill Personal.
