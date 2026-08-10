---
name: release
description: Tag a new release, push, and publish on GitHub
---

# Release

Create a new versioned release for Lantern.

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

9. Publish the release: `gh release edit v{version} --draft=false --notes "..."`. Release notes MUST include complete Simplified Chinese and English sections, with a `[简体中文](#chinese) · [English](#english)` link row at the top and matching `<a id="chinese"></a>` / `<a id="english"></a>` anchors. Keep both sections semantically equivalent. Include a **Download** section at the bottom of each language section naming `Lantern_{version}_aarch64.dmg` (Apple Silicon only — there is no Intel build) and `Lantern_{version}_x64-setup.exe`, with the OS requirements. Easiest way to get this right is to copy the previous release's Download section and change the version.
   - Builds are signed with a Developer ID certificate and notarized by Apple, as of `v2.11.2`. Both language sections say the installer opens directly. **Never put the `xattr -d com.apple.quarantine` workaround in public release notes** — it has been unnecessary since notarization landed, and printing it teaches downloaders to bypass Gatekeeper for no reason. It survives only as history in §3 of `docs/impls/archive/macos-distribution-gatekeeper-fix.md`.
   - **Never state a monetary cost** ("about a few cents a book"). Those numbers cannot be estimated accurately, and an inaccurate one should not be published.

10. **Push the published notes into `latest.json`** — this step is what makes the in-app update prompt say what changed:

    ```bash
    node scripts/update-notes.mjs v{version}
    ```

    The updater reads its changelog from the `notes` field of the `latest.json` asset, not from the release body. `tauri-action` wrote that asset during the build and filled `notes` with the workflow's placeholder text, so everything step 9 published lives only on the release page. Through v2.15.2 the in-app prompt therefore said nothing but "the installers are ready". The script reads the body back as it now stands, drops the Download section (dmg/exe filenames mean nothing to someone updating in place), and re-uploads `latest.json` with `notes` replaced and every `signature` and `url` untouched — a mangled signature would break updating for every client on every platform.

    Run it **after** step 9, never before: it copies whatever the body says at the moment it runs. Re-running it is safe. Confirm with `gh release view v{version} --json assets` that `latest.json`'s timestamp moved, or check the field directly:

    ```bash
    gh release download v{version} --pattern latest.json --output - | head -c 400
    ```

11. **Confirm the artifacts without downloading them**: `gh release view v{version} --json assets --jq '.assets[]|"\(.name)\t\(.size)"'`. Six assets are expected: `Lantern_{version}_aarch64.dmg`, `Lantern_{version}_x64-setup.exe` and its `.sig`, plus `Lantern_aarch64.app.tar.gz` and its `.sig` and `latest.json` — the last three are the updater's, and the `.app.tar.gz` carries no version in its name by design, so do not read that as a failed bump. Every versioned name must carry `{version}`, and no size may be implausibly small for its kind. That is the whole check — the filename is written from the same `tauri.conf.json` the tag was cut from, so a name reading `{version}` is the bundle's version.

    **Do not download the release to verify it.** It costs the user disk and bandwidth on a connection that is often poor, and it buys nothing the list above does not: the version-reuse guard in step 1 is what prevents the 2026-07-17 same-name-different-contents incident, and the workflow is tag-triggered so it cannot build from another commit. `spctl -a -vv` is the one thing lost. Do an on-device check only when the user asks for one, or when something about signing actually changed.

    **A green run does not by itself mean the build was notarized.** The workflow falls back to an ad-hoc build — silently, still green — when the Apple secrets are absent, when the certificate fails to import (that step is `continue-on-error` on purpose), or when the tag is a pre-release. Since the notes claim "signed with a Developer ID certificate and notarized", confirm the signed path actually ran before publishing them:

    ```bash
    gh run view <run-id> --log | grep -iE "Notarizing Finished|Stapling|skipping Developer ID"
    ```

    Expect `Notarizing Finished with status Accepted` followed by `Stapling app...`. If instead the log says signing was skipped, the build is ad-hoc: say so to the user and let them decide whether to re-cut the release or reword that line — do not publish a notarization claim the build cannot support.

**The goal is a successful publish.** If a step fails, fix it and release again under a fresh version number (never reuse one — step 1). Report what broke and what you did about it.

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
