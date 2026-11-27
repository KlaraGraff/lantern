# Offline dictionary (ECDICT download + MDict import)

Answers GitHub issue #75: single-click lookup only reached Youdao, so it failed
offline, and readers with their own `.mdx` dictionaries could not use them.

## Behaviour

| Case | What happens |
| --- | --- |
| Default order (`dictionary_source` unset / `online`) | Youdao first; on any failure, imported MDict files (import order), then ECDICT |
| `dictionary_source = local` | Local dictionaries first; Youdao only for words they lack |
| No network, nothing local had the word, ECDICT not installed or queued | Backend returns `DICTIONARY_OFFLINE_MISSING`; the card offers 「连上 Wi-Fi 时下载」/「不用了」 |
| Reader declines | `offline_dictionary_prompt_dismissed = true`; card just says it is offline |
| Reader accepts, or presses 下载 in settings | `offline_dictionary_pending = true`; a worker downloads, retrying every minute while offline, and resumes after restart |

All three settings keys and both dictionary stores are device-local (not on the
sync whitelist; files under `local_data_dir()/offline-dictionary/`).

## ECDICT

- Source pinned to commit `39cfb96` of `skywind3000/ECDICT` (MIT); size
  66,009,548 bytes and SHA-256 are checked while streaming.
- Converted once into `ecdict.sqlite` (≈62 MB, 770k rows, under 1 s) with a
  `COLLATE NOCASE` index; the CSV is discarded.
- Only a dropped connection is retried; a length or hash mismatch stops the
  queue and shows 下载失败.
- Wi-Fi vs cellular is not detectable on desktop without native code, so
  "when on Wi-Fi" is implemented as "when the network is reachable".

## MDict

- Read with `mdictlib` (MIT, `forbid(unsafe_code)`, `lzo` feature on). Import
  probes the file first, then copies it into `mdx/<uuid>.mdx` with a
  `<uuid>.json` metadata sidecar.
- Lookup includes case variants and follows `@@@LINK=` up to three hops.
- Entry HTML is reduced to text, one line per block element, each line run
  through the same part-of-speech split as Youdao entries. Images, audio
  (`.mdd`) and dictionary CSS are not shown.
- Encrypted v1 files and registration-code-locked files are refused with
  「无法读取这个词典文件」.

## Figma prompts

- **Settings → 划词与卡片 → 交互方式, under 单击查词:** an 离线词典 row with a
  secondary button whose label follows state (下载 / 取消 / 删除 / 重试) and a
  status line beneath (size, progress bar while downloading, space used). A
  我的词典 row with 导入词典, followed by a list of imported dictionaries as
  soft cards (title, entry count · size, 删除). A 查词顺序 select appears only
  once a local dictionary exists.
- **Dictionary card, offline:** in place of the senses, one sentence saying the
  word could not be looked up offline and what downloading gives, then two
  inline text actions — accent 「连上 Wi-Fi 时下载」 and muted 「不用了」. After
  accepting, the same space confirms it will download once online.
- **Dictionary card header:** when a local dictionary answered, its name sits
  after the phonetic in the smallest muted type.
