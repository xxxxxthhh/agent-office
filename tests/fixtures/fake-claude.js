let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

const args = process.argv.slice(2);
const schemaArgument = args[args.indexOf("--json-schema") + 1];
if (!args.includes("-p") || !args.includes("--json-schema")) {
  process.stderr.write("missing print or schema arguments\n");
  process.exitCode = 2;
} else if (schemaArgument && JSON.parse(schemaArgument).$schema !== undefined) {
  // Mirrors the real CLI, which refuses a `$schema` it cannot resolve by URL:
  // 'not a valid JSON Schema: no schema with key or ref "https://..."'.
  process.stderr.write("--json-schema is not a valid JSON Schema\n");
  process.exitCode = 5;
} else if (!args.includes("--permission-mode")) {
  process.stderr.write("missing permission mode\n");
  process.exitCode = 3;
} else if (!input.includes("Codex adapter supplied schema")) {
  process.stderr.write("missing colleague message\n");
  process.exitCode = 4;
} else {
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    structured_output: {
      summary: "Claude adapter received and verified the Codex handoff.",
      status: "done",
      messages: [],
      artifacts: [],
      needsUser: false
    }
  }));
}
