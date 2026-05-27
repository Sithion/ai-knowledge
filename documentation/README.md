# Documentation

Technical documentation for CogniStore.

## Contents

| Document | Description |
|----------|-------------|
| [Architecture](./architecture.md) | System overview, data flow, package graph, directory structure, system knowledge, instruction compilation, OpenCode plugins, design decisions |
| [Tauri Sidecar](./tauri-sidecar.md) | Desktop app internals: startup sequence, Node.js discovery, port allocation, auto-update, security |
| [Database](./database.md) | SQLite schema, sqlite-vec virtual table, system type, vector search algorithm, embedding strategy |
| [MCP Server](./mcp-server.md) | Tool definitions (14 tools), parameters, batch tools, tool annotations, MCP resources, plan status guards, system entry guards, bundling strategy |
| [Config Injection](./config-injection.md) | Marker-based injection, instruction compilation, hook catalog, OpenCode skills/plugins, supported clients |
| [Setup & Uninstall](./setup-uninstall.md) | Setup wizard steps (incl. instruction compilation, plugin deployment, system knowledge seeding), uninstall teardown, symmetry rule |
| [Frontend](./frontend.md) | React pages, ConfirmModal, plan archive, Redux state, i18n, routing, loading strategy |
| [API Reference](./api-reference.md) | Fastify sidecar REST endpoints: health, CRUD, stats, setup, upgrade, uninstall, providers, federated search, system guards |
| [CI/CD](./ci-cd.md) | GitHub Actions workflows, instruction compilation, publish pipeline, agent test battery, version management |
| **External Knowledge Providers (MCP)** | [Plug in MCP](./providers/plug-mcp.md) · [Config Reference](./providers/providers-config.md) · [Security Model](./providers/security.md) |

## Quick Navigation

**Building the app?** Start with [Architecture](./architecture.md) then [CI/CD](./ci-cd.md).

**Adding a feature?** Check [Frontend](./frontend.md) for UI patterns and [API Reference](./api-reference.md) for backend endpoints.

**Debugging MCP?** See [MCP Server](./mcp-server.md) for tool details and [Database](./database.md) for search behavior.

**Modifying setup?** Read [Setup & Uninstall](./setup-uninstall.md) — remember the symmetry rule.

**Adding a new AI client?** Follow [Config Injection](./config-injection.md) patterns.

**Connecting external knowledge?** See [Plug in MCP](./providers/plug-mcp.md) (connect an MCP server — stdio or remote with OAuth); read the [Security Model](./providers/security.md) first.

**Running agent tests?** See [CI/CD](./ci-cd.md) for the agent test battery (`scripts/test-agents.sh`).
