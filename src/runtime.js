import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { CapabilityRegistry } from "./capabilities.js";
import { Orchestrator } from "./orchestrator.js";
import { loadTurnSchema } from "./protocol.js";
import { TaskStore } from "./store.js";
import { WorkflowOrchestrator } from "./workflow-orchestrator.js";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_SCHEMA_PATH = path.join(PACKAGE_ROOT, "schemas", "turn.schema.json");

export async function createRuntime(configPath, options = {}) {
  const config = await loadConfig(configPath);
  const store = new TaskStore(config.stateDir, {
    maxEventFileBytes: config.retention.maxEventFileBytes,
    maxRunFiles: config.retention.maxRunFiles
  });
  if (options.initializeState !== false) await store.init();
  const schema = await loadTurnSchema(DEFAULT_SCHEMA_PATH);
  const capabilityRegistry = options.capabilityRegistry ?? new CapabilityRegistry({ config });
  const orchestrator = new Orchestrator({
    config,
    store,
    schema,
    schemaPath: DEFAULT_SCHEMA_PATH,
    capabilityRegistry,
    adapterOverrides: options.adapterOverrides
  });
  const workflowOrchestrator = new WorkflowOrchestrator({
    config,
    store,
    schema,
    schemaPath: DEFAULT_SCHEMA_PATH,
    adapterOverrides: options.adapterOverrides,
    runtimeOverrides: options.runtimeOverrides
  });
  orchestrator.setWorkflowOrchestrator(workflowOrchestrator);
  return { config, store, schema, orchestrator, workflowOrchestrator, capabilityRegistry };
}
