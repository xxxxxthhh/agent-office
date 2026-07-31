let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

process.stdout.write(JSON.stringify({
  summary: input.includes("Shared task objective:")
    ? "Received the complete collaboration prompt."
    : "Prompt was incomplete.",
  status: "done",
  messages: [],
  artifacts: [],
  needsUser: false
}));
