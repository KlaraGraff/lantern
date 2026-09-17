import assert from "node:assert/strict";
import test from "node:test";

import {
  passageRoute,
  previousAssistantBeforeLatestUser,
} from "../src/hooks/aiChatRouting.ts";

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

const defaults = {
  newPassageStartsNewChat: true,
  newPassageStartsNewChatWhileOpen: true,
};

test("a new book location starts a new chat even while the panel is open", () => {
  assert.equal(passageRoute(true, "current", undefined, defaults), "new");
  assert.equal(passageRoute(false, "current", undefined, defaults), "new");
});

test("the detailed open-panel preference can keep a new location in the current chat", () => {
  assert.equal(passageRoute(true, "current", undefined, {
    ...defaults,
    newPassageStartsNewChatWhileOpen: false,
  }), "current");
  assert.equal(passageRoute(false, "current", undefined, {
    ...defaults,
    newPassageStartsNewChatWhileOpen: false,
  }), "new");
});

test("turning off automatic new chats keeps unseen locations in the current chat", () => {
  assert.equal(passageRoute(true, "current", undefined, {
    ...defaults,
    newPassageStartsNewChat: false,
  }), "current");
});

test("an exact location match resumes another chat but does not reload the visible one", () => {
  assert.equal(passageRoute(true, "current", "older", defaults), "resume");
  assert.equal(passageRoute(true, "current", "current", defaults), "current");
});
