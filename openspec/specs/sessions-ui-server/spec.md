# sessions-ui-server Specification

## Purpose

Serves the sessions page from the user's own machine only, on demand, and protects it so that other web pages or processes cannot use it to read or change sessions.

## Requirements

### Requirement: Started on demand in the foreground
The server SHALL be started by `bun run sessions` and SHALL run in the foreground of that terminal until stopped. It SHALL NOT be started by the stack start script.

#### Scenario: Start
- **WHEN** the user runs the command
- **THEN** the terminal prints the local URL and stays attached to the server

#### Scenario: Port already in use
- **WHEN** the configured port is taken
- **THEN** the server exits with a message naming the port and how to change it

### Requirement: Local access only
The server SHALL accept connections only from the same machine, on a configurable port that defaults to 20131.

#### Scenario: Another device on the network
- **WHEN** another machine tries to reach the server's port
- **THEN** the connection is not accepted

### Requirement: Cross-origin and rebinding protection
The server SHALL reject any request whose `Host` is not the local address and port, and any state-changing request whose `Origin` is not the server's own origin.

#### Scenario: Foreign page posts to the server
- **WHEN** a page on another website sends a state-changing request to the local port
- **THEN** the request is rejected and no pending action is created

#### Scenario: DNS rebinding
- **WHEN** a request arrives with a `Host` header for a different name
- **THEN** it is rejected

### Requirement: Per-run access token
The server SHALL generate a new random token at each start, hand it only to the page it serves, and require it on every API request.

#### Scenario: Missing or wrong token
- **WHEN** an API request lacks the token or carries a different one
- **THEN** it is rejected and nothing is read or changed

#### Scenario: Restart
- **WHEN** the server is restarted
- **THEN** pages loaded before the restart are rejected until reloaded

### Requirement: Page works without external resources
The page SHALL load without fetching scripts, styles, fonts or images from other hosts.

#### Scenario: Offline
- **WHEN** the machine has no internet connection
- **THEN** the page loads and works fully

### Requirement: Browsing with search and filters
The page SHALL let the user search sessions by title, prompt text, file path and tag, filter by project and by live or deleted state, and sort by recency or size.

#### Scenario: Filter by project and search
- **WHEN** the user picks a project and types a search term
- **THEN** only that project's sessions matching the term are listed

### Requirement: Existing stack unaffected
Running or stopping the sessions server SHALL NOT change the behavior of the memory hooks, the memory server, the LLM proxy or the Zed adapter.

#### Scenario: Memory hooks while the UI runs
- **WHEN** the sessions server is running and an agent session starts
- **THEN** the hooks behave exactly as when it is not running

### Requirement: Per-agent tabs behind the same guards
The server SHALL expose OpenCode and Antigravity sessions through a read-only token-protected route, merge OpenCode backups into the trash listing marked with their agent, and apply the same Host, Origin, token and approval rules to actions on every agent.

#### Scenario: Other-agent list without a token
- **WHEN** the OpenCode and Antigravity list is requested without the per-run token
- **THEN** the request is rejected and no database is opened
