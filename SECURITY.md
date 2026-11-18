# Security

HomeCode is a local coding agent that can read and modify files, run shell commands, and connect to configured providers and MCP servers.

## Security model

HomeCode does not sandbox agent actions. Permission prompts help users review actions, but they do not provide security isolation. For untrusted repositories or instructions, run HomeCode inside a container or virtual machine with only the access you intend to grant.

When server mode is enabled, secure it before exposing it to a network. Configure `OPENCODE_SERVER_PASSWORD` to enable HTTP Basic Authentication; without it, the server is unauthenticated.

Data sent to an LLM provider is subject to that provider's policies. External MCP servers are separate services and have their own trust and data-handling boundaries.

## Report a vulnerability

Report vulnerabilities privately through the [GitHub Security Advisory form](https://github.com/AlexanderKyng/homecode/security/advisories/new). Do not disclose them in public issues.
