import { writeFile } from "node:fs/promises";

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

const args = process.argv.slice(2);
if (args[0] !== "exec") {
  process.stderr.write("expected exec subcommand\n");
  process.exitCode = 2;
} else if (!args.includes("--output-schema") || !args.includes("--sandbox")) {
  process.stderr.write("missing structured-output or sandbox arguments\n");
  process.exitCode = 3;
} else if (!input.includes("Shared task objective:")) {
  process.stderr.write("missing collaboration prompt\n");
  process.exitCode = 4;
} else {
  const outputIndex = args.indexOf("--output-last-message");
  const outputPath = args[outputIndex + 1];
  await writeFile(outputPath, JSON.stringify({
    summary: "Codex adapter supplied schema, sandbox, and shared prompt.",
    status: "done",
    messages: [{ to: "claude", body: "Please verify the adapter handoff." }],
    artifacts: [],
    needsUser: false
  }));
}
