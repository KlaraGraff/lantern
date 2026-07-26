import assert from "node:assert/strict";
import test from "node:test";

import { previousAssistantBeforeLatestUser } from "../src/hooks/aiChatRouting.ts";

test("uses the assistant adjacent to the latest user turn", () => {
  const older = { role: "assistant" as const, route: "current_section" };
  const latest = { role: "assistant" as const };
  const result = previousAssistantBeforeLatestUser([
    { role: "user" as const },
    older,
    { role: "user" as const },
    latest,
    { role: "user" as const },
  ]);

  assert.equal(result, latest);
  assert.equal(result?.route, undefined);
});

test("returns the adjacent assistant only when a latest user turn exists", () => {
  assert.deepEqual(
    previousAssistantBeforeLatestUser([
      { role: "user" as const },
      { role: "assistant" as const, route: "current_section" },
      { role: "user" as const },
    ]),
    { role: "assistant", route: "current_section" },
  );
  assert.equal(
    previousAssistantBeforeLatestUser([{ role: "user" as const }]),
    undefined,
  );
});

test("does not use an assistant before an intervening user turn", () => {
  assert.equal(
    previousAssistantBeforeLatestUser([
      { role: "assistant" as const, route: "current_section" },
      { role: "user" as const },
      { role: "user" as const },
    ]),
    undefined,
  );
});
