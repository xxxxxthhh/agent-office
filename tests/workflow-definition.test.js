import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { normalizeConfig } from "../src/config.js";
import { ConfigError } from "../src/errors.js";
import { normalizeWorkflowDefinition } from "../src/workflow-definition.js";

function config() {
  return normalizeConfig({
    version: 1,
    workspace: os.tmpdir(),
    agents: [
      { id: "builder", adapter: "mock", role: "Build." },
      { id: "reviewer", adapter: "mock", role: "Review." }
    ]
  }, path.parse(os.tmpdir()).root);
}

test("normalizes a parallel workflow with a worktree handoff and persists env names only", () => {
  const key = "AO_WORKFLOW_DEFINITION_SECRET";
  const previous = process.env[key];
  process.env[key] = "definition-secret-must-not-persist";
  try {
    const definition = normalizeWorkflowDefinition({
    version: 1,
    runtime: "process",
    maxConcurrency: 3,
    nodes: [
      { id: "plan", owner: "reviewer", prompt: "Plan." },
      {
        id: "build",
        owner: "builder",
        dependsOn: ["plan"],
        access: "write",
        workspace: "worktree",
        writeScopes: ["src/**"],
        env: [key]
      },
      {
        id: "review",
        owner: "reviewer",
        dependsOn: ["build"],
        workspaceFrom: "build"
      },
      {
        id: "gate",
        type: "approval",
        dependsOn: ["review"],
        prompt: "Approve publication."
      },
      {
        id: "publish",
        type: "integration",
        source: "build",
        dependsOn: ["build", "gate"]
      }
    ]
    }, config());

    assert.equal(definition.nodes[1].workspace, "worktree");
    assert.deepEqual(definition.nodes[1].envKeys, [key]);
    assert.equal("env" in definition.nodes[1], false);
    assert.equal(JSON.stringify(definition).includes(process.env[key]), false);
    assert.equal(definition.nodes[2].workspaceFrom, "build");
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("rejects cycles, unknown runtimes, unknown owners, and unscoped writers", () => {
  const cases = [
    {
      version: 1,
      runtime: "magic",
      nodes: [{ id: "a", owner: "builder" }]
    },
    {
      version: 1,
      nodes: [{ id: "a", owner: "missing" }]
    },
    {
      version: 1,
      nodes: [{ id: "a", owner: "builder", access: "write", workspace: "worktree" }]
    },
    {
      version: 1,
      nodes: [
        { id: "a", owner: "builder", dependsOn: ["b"] },
        { id: "b", owner: "reviewer", dependsOn: ["a"] }
      ]
    }
  ];
  for (const definition of cases) {
    assert.throws(() => normalizeWorkflowDefinition(definition, config()), ConfigError);
  }
});

test("requires exactly one writer and an approval that follows its completed change", () => {
  assert.throws(() => normalizeWorkflowDefinition({
    version: 1,
    nodes: [
      { id: "gate", type: "approval", prompt: "Approve before work." },
      {
        id: "build",
        owner: "builder",
        dependsOn: ["gate"],
        access: "write",
        workspace: "worktree",
        writeScopes: ["src/**"]
      },
      { id: "publish", type: "integration", source: "build", dependsOn: ["gate", "build"] }
    ]
  }, config()), /requires an approval after source/);

  assert.throws(() => normalizeWorkflowDefinition({
    version: 1,
    nodes: [
      {
        id: "left",
        owner: "builder",
        access: "write",
        workspace: "worktree",
        writeScopes: ["src/left/**"]
      },
      {
        id: "right",
        owner: "reviewer",
        access: "write",
        workspace: "worktree",
        writeScopes: ["src/right/**"]
      },
      { id: "gate", type: "approval", dependsOn: ["left", "right"], prompt: "Approve." },
      { id: "publish", type: "integration", source: "left", dependsOn: ["left", "gate"] }
    ]
  }, config()), /exactly one writing node/);
});
