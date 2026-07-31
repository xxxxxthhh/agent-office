# Security

## Supported versions

Agent Office is currently pre-1.0. Security fixes are applied to the latest version on the default branch.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting from the repository's **Security** tab. Do not include credentials, private source code, model transcripts, or exploit details in a public issue.

Include:

- the affected version or commit;
- the relevant adapter, CLI, dashboard, or state-store surface;
- reproduction steps with sensitive values removed;
- expected and observed behavior;
- the potential impact.

## Operational boundary

Agent Office launches locally installed coding agents that may read and modify the configured workspace. Review `agent-office.json`, the selected workspace, agent permissions, model assignments, and any custom command adapter before starting a real task.

The dashboard binds only to loopback addresses and is not a remotely authenticated control plane. Runtime state and raw model outputs under `.agent-office/` may contain private project context and should not be committed.
