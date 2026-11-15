import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIntent, parseIntentEx } from "../lib/commands/intent_parser";

test("CREATE_REPO: 'name' lafz repo ka naam nahi banta (original bug)", () => {
  assert.deepEqual(parseIntent('Create a repo name "practice"'), ["CREATE_REPO", { repo: "practice" }]);
  assert.deepEqual(parseIntent("create repo named practice"), ["CREATE_REPO", { repo: "practice" }]);
  assert.equal(parseIntent("create a repo name")[0], null);
});

test("CREATE_REPO: Hinglish roop", () => {
  for (const m of ['Bhai ek repo bna de "practice" naam se', "practice naam se repo bana do", "naya repo banao practice", "repo practice bana do"]) {
    assert.deepEqual(parseIntent(m), ["CREATE_REPO", { repo: "practice" }], m);
  }
});

test("file path ka casing bacha rehta hai", () => {
  assert.deepEqual(parseIntent("create file README.md in practice"), ["CREATE_FILE", { repo: "practice", path: "README.md" }]);
  assert.deepEqual(parseIntent("delete file Dockerfile from practice"), ["DELETE_FILE", { repo: "practice", path: "Dockerfile" }]);
});

test("leftoverWords: simple commands 0, lamba extra text zyada", () => {
  assert.equal(parseIntentEx("list repos please yaar")?.leftoverWords, 0);
  assert.ok((parseIntentEx("show me my repos and tell me which one is the biggest and oldest one please")?.leftoverWords ?? 0) >= 6);
});

test("purane commands jaise ke taise", () => {
  assert.deepEqual(parseIntent("deploy my-app to vercel"), ["VERCEL_DEPLOY", { project_name: "my-app" }]);
  assert.deepEqual(parseIntent("delete repo old-stuff"), ["DELETE_REPO", { repo: "old-stuff" }]);
  assert.equal(parseIntent("list repos")[0], "LIST_REPOS");
  assert.equal(parseIntent("kaise ho")[0], null);
});
