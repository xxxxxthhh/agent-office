import { ConfigError } from "../errors.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { CommandAdapter } from "./command.js";
import { MockAdapter } from "./mock.js";

const BUILT_INS = {
  claude: ClaudeAdapter,
  codex: CodexAdapter,
  command: CommandAdapter,
  mock: MockAdapter
};

export function createAdapters(config, context, overrides = {}) {
  return new Map(
    config.agents.map((agent) => {
      if (overrides[agent.id]) return [agent.id, overrides[agent.id]];
      const Adapter = BUILT_INS[agent.adapter];
      if (!Adapter) {
        throw new ConfigError(
          `Unknown adapter "${agent.adapter}" for agent "${agent.id}". Supported: ${Object.keys(BUILT_INS).join(", ")}`
        );
      }
      return [agent.id, new Adapter(agent, context)];
    })
  );
}
