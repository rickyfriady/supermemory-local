# memory-mcp-server Specification

## Purpose
Exposes the shared per-project memory to any MCP client (directly or through the mcpm gateway), so agents can search and add memories on demand instead of only through lifecycle hooks.

## Requirements

### Requirement: Stdio MCP server
The project SHALL provide an MCP server over stdio that answers `initialize`, `tools/list` and `tools/call`, and writes nothing but protocol messages to stdout.

#### Scenario: Tool listing
- **WHEN** an MCP client initializes the server and lists tools
- **THEN** the list contains exactly `search`, `add` and `profile`, each with an input schema

### Requirement: Project addressed by path
Every tool SHALL take an absolute `project_path` and address the same project memory the agent hooks use for that path.

#### Scenario: Same memory as hooks
- **WHEN** a hook stored a memory while working in a repository and `search` is called with any directory inside that repository as `project_path`
- **THEN** the search covers that memory

#### Scenario: Relative path
- **WHEN** a tool is called with a relative or non-existent `project_path`
- **THEN** the call returns a tool error naming `project_path` and stores or searches nothing

### Requirement: Search memories
`search` SHALL return the project's memories and document excerpts most relevant to a `query`, at most `limit` results (default 6), with their dates.

#### Scenario: Matching memory
- **WHEN** a project has a memory about the gateway port and `search` is called with query "gateway port"
- **THEN** the result includes that memory's text

#### Scenario: Non-English query
- **WHEN** the query is not English and a translation model is configured
- **THEN** the query is translated to English before searching, and the untranslated query is used if translation fails

### Requirement: Add memory
`add` SHALL store `content` in the project's memory, tagged as coming from the MCP server, and return the new document's ID.

#### Scenario: Stored and findable
- **WHEN** `add` is called with content for a project
- **THEN** the call returns a document ID and that document appears in the project's document list

### Requirement: Project profile
`profile` SHALL return the long-lived and recent facts the memory server extracted for the project.

#### Scenario: Profile requested
- **WHEN** `profile` is called for a project with extracted facts
- **THEN** the result lists them in two groups, long-lived and recent

### Requirement: Memory API unavailable
When the memory API does not answer, tools SHALL return a tool error saying the memory server is down, and the MCP server MUST keep running.

#### Scenario: Server stopped
- **WHEN** the memory server is stopped and `search` is called
- **THEN** the call returns an error mentioning the memory server, and a later call succeeds once the memory server is back
