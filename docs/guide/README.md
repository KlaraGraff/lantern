# Implementation Guide

This directory contains implementation guides for the Lantern ebook reader. Completed guides are moved to [`archive/`](archive/). Every file here should appear below — three of them were missing from this list for weeks, which is how the QA they were asking for got forgotten.

## Waiting on a human pass

- [Format normalization pipeline — acceptance brief](format-normalization-acceptance-brief.md) —
  read this one first: what is being tested and why automated tests can't cover it, what the
  tester needs to prepare, a message that can be sent to them as-is, and the judgement calls
  we want their opinion on.
- [Format normalization pipeline — handoff test plan](format-normalization-testing.md) —
  the tick-box checklist behind that brief. The code is done and green (`cargo test` /
  clippy / tsc / lint); **the runtime and GUI acceptance has never been run**, because the
  session that wrote it had no display.
- [macOS 12 reader compatibility — on-device QA](macos-12-reader-qa.md) — status still reads
  "v2.0.3 fix candidate awaiting re-verification" while the app is at 2.6.1. Held open: a
  user on macOS 12 has not yet reported specifics.

## Reference

- [单人 + AI 协作的工作流卫生指南](workflow-hygiene.md) — 分支与并行、半途而废的改动、垃圾分支、
  需求反复、长对话黑箱、「对话到底干完没有」这六个问题的诊断与推理过程。文中定下的纪律已经收进
  规则文件（全局 `CLAUDE.md` / 本仓库 `AGENTS.md`），本文保留的是**为什么**。
- [macOS distribution and signing](macos-distribution.md)
- [Security notes — local credentials](security.md)
- [Product screenshots — shot list and brief](screenshots.md)
