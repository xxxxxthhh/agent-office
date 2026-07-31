import { parseTurnEnvelope } from "../protocol.js";

export class MockAdapter {
  constructor(agent) {
    this.agent = agent;
    this.index = 0;
  }

  async runTurn({ prompt }) {
    const replies = this.agent.replies ?? [
      {
        summary: `${this.agent.id} received the task and completed its mock turn.`,
        status: "done",
        messages: [],
        artifacts: [],
        needsUser: false
      }
    ];
    const reply = replies[Math.min(this.index, replies.length - 1)];
    this.index += 1;
    return {
      response: parseTurnEnvelope(reply),
      tracePath: null,
      stderr: "",
      prompt
    };
  }

  describe() {
    return {
      command: null,
      kind: "Deterministic mock",
      safety: "does not execute external tools"
    };
  }
}
