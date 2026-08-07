import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchContextLineProgress,
  resumeContextLines,
  type ContextLineProgress,
} from "../src/hooks/useContextLineProgress.ts";

test("returns null, not a throw, when the backend command is not registered yet", async () => {
  const rejecting = async () => {
    throw new Error("command context_line_progress not found");
  };
  await assert.doesNotReject(async () => {
    const result = await fetchContextLineProgress(rejecting);
    assert.equal(result, null);
  });
});

test("returns null when the backend has nothing running, rather than an empty object", async () => {
  const resolvesNull = async <T>() => null as T;
  assert.equal(await fetchContextLineProgress(resolvesNull), null);
});

test("passes a real progress payload straight through", async () => {
  const progress: ContextLineProgress = {
    book_id: "book-1",
    book_title: "Pride and Prejudice",
    done: 137,
    total: 500,
    failed: 0,
    running: true,
  };
  const resolvesProgress = async <T>() => progress as T;
  assert.deepEqual(await fetchContextLineProgress(resolvesProgress), progress);
});

test("resume is a no-op, not a throw, when the resume command is absent", async () => {
  const rejecting = async () => {
    throw new Error("command resume_context_lines not found");
  };
  await assert.doesNotReject(async () => resumeContextLines("book-1", rejecting));
});

test("resume forwards the book id to the invoke call", async () => {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const recording = async <T>(cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    return undefined as T;
  };
  await resumeContextLines("book-42", recording);
  assert.deepEqual(calls, [{ cmd: "resume_context_lines", args: { bookId: "book-42" } }]);
});
