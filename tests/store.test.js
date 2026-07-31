import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { TaskStore } from "../src/store.js";

test("persists tasks, messages, and append-only events", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-office-store-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new TaskStore(directory);

  const task = await store.createTask("Coordinate a focused change.", [
    { id: "builder" },
    { id: "reviewer" }
  ]);
  const message = await store.addMessage(task.id, {
    from: "user",
    to: "builder",
    body: "Start with the failing test."
  });
  const loaded = await store.loadTask(task.id);

  assert.equal(loaded.objective, "Coordinate a focused change.");
  assert.equal(loaded.messages.length, 2);
  assert.equal(message.sequence, 2);
  assert.equal(loaded.participants.builder.status, "idle");

  const events = (await readFile(path.join(directory, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), ["task.created", "message.sent"]);
});

test("serializes concurrent message writes without losing sequence numbers", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-office-lock-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new TaskStore(directory);
  const task = await store.createTask("Preserve every concurrent update.", [{ id: "worker" }]);

  await Promise.all(
    Array.from({ length: 12 }, (_, index) => store.addMessage(task.id, {
      from: "user",
      to: "team",
      body: `message-${index}`
    }))
  );

  const loaded = await store.loadTask(task.id);
  assert.equal(loaded.messages.length, 13);
  assert.deepEqual(
    loaded.messages.map((message) => message.sequence),
    Array.from({ length: 13 }, (_, index) => index + 1)
  );
});

test("recovers an abandoned, empty state lock after the stale threshold", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-office-stale-lock-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new TaskStore(directory, { lockTimeoutMs: 1000, staleLockMs: 0 });
  await store.init();
  await mkdir(path.join(directory, ".write-lock"));

  const task = await store.createTask("Recover after an interrupted writer.", [{ id: "worker" }]);

  assert.match(task.id, /^task-/);
});
