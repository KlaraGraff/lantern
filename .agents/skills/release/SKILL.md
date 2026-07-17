---
name: release
description: Tag a new release, push, and publish on GitHub
---

# Release

Create a new versioned release for Quill.

## Steps

1. Ask the user for the version number (e.g. `0.3.0`) if not provided as an argument.
   - **Version-reuse guard:** the version must be brand new. If the tag `v{version}` already exists (`git tag -l`), or that version was ever published on GitHub Releases (even if since deleted), refuse it and propose the next patch version instead. Never reissue a published version number — identically named artifacts with different contents have caused full debugging rounds (see `AGENTS.md` → Release Conventions).

2. Bump version in all three files. **IMPORTANT: Do NOT use `sed` for version bumps.** Instead:
   - Confirm you're on `main` and the working tree is clean (`git status`). If not, stop and report.
   - Read each file first with the Read tool to confirm the current version string.
   - Use the Edit tool to replace the version in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.
   - After editing, verify all three files show the correct new version.
   - Run `cargo check` in `src-tauri/` to update `Cargo.lock`.
   - Check if `public/foliate-js` submodule has changes. If so, commit and push the submodule, then stage the updated reference.
   - Stage everything and commit with message `chore: bump version to v{version}`.

3. Push the version bump commit directly to main: `git push`

4. Tag: `git tag -a v{version} -m "v{version}"`

5. Push the tag: `git push origin v{version}`

6. Wait for the release workflow to complete: `gh run list --workflow=release.yml --limit 1 --json status,conclusion,databaseId`

7. Once the workflow succeeds, draft a release message by reviewing commits since the last tag: `git log $(git describe --tags --abbrev=0 HEAD^)..HEAD --oneline`

8. Categorize changes into sections: **What's New**, **Improvements**, **Bug Fixes** (omit empty sections).

9. Publish the release: `gh release edit v{version} --draft=false --notes "..."`. Include a **Download** section at the bottom with the `.dmg` filenames for Apple Silicon and Intel.
   - While signing secrets are not configured (ad-hoc builds), the notes MUST include the macOS install instructions for Gatekeeper's "damaged" rejection (`xattr -d com.apple.quarantine <dmg>`); see `docs/impls/macos-distribution-gatekeeper-fix.md`.

10. **Verify the released artifact** (not just CI status): `gh release download v{version} --pattern '*aarch64.dmg'`, mount it, and confirm the app's `Info.plist` version and binary provenance match the tag (compare `shasum` against a rebuilt or expected binary when in doubt). Record the Settings → About commit when doing any on-device check.

If any step fails, stop and report the error — do not continue.

## Notarization Commands

- **Check notarization history**:
  ```
  xcrun notarytool history --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID"
  ```

- **Check a specific submission**:
  ```
  xcrun notarytool info <submission-id> --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID"
  ```

- **Verify stapling on a DMG or .app**:
  ```
  stapler validate <file>
  ```

- **Check code signing**:
  ```
  codesign -dvv <path-to-app>
  ```

Note: Apple credentials are in `~/.zshrc`. The shell may not have them loaded — use literal values if env vars are empty.
