# Spec Delta

## Purpose

Gives a read-only, per-project overview of every Claude Code session stored on this Mac, with enough context to tell sessions apart, and links each session to the shared memories it produced.

## ADDED Requirements

### Requirement: List sessions grouped by project
The system SHALL list every Claude Code session found under `~/.claude/projects`, grouped by the project working directory the session ran in, newest activity first.

#### Scenario: Sessions from several projects
- **WHEN** the catalog is requested and sessions exist for two different working directories
- **THEN** each working directory appears as its own group containing only its sessions, ordered by most recent activity

#### Scenario: Project folder with no sessions
- **WHEN** a project folder under `~/.claude/projects` contains no session files
- **THEN** that project does not appear in the catalog

### Requirement: Session metadata
For each session the system SHALL show its id, title, git branch, Claude Code version, start and last-activity times, file size, first and last user prompt, linked pull request, and recorded cost when these exist in the transcript.

#### Scenario: Session with a title
- **WHEN** the transcript contains one or more title entries
- **THEN** the most recent title is shown

#### Scenario: Session without optional data
- **WHEN** a transcript has no title, pull request or cost entry
- **THEN** the session is still listed, the missing fields are blank, and the first prompt is used as its display title

#### Scenario: Unreadable or malformed transcript
- **WHEN** a transcript line cannot be parsed or a file cannot be read
- **THEN** the session is still listed with the data that could be read, and the failure does not stop the rest of the catalog from loading

### Requirement: Files touched
The system SHALL list the distinct files a session created or edited, taken from its file-writing tool calls, and SHALL allow finding sessions by a file path.

#### Scenario: Session edited files
- **WHEN** a session contains Edit and Write tool calls on two files
- **THEN** the session shows exactly those two paths

#### Scenario: Search by file
- **WHEN** the user searches for a path or part of one
- **THEN** only sessions that touched a matching file are shown

### Requirement: Live session indicator
The system SHALL mark a session as live when a running Claude Code process is registered for it.

#### Scenario: Running session
- **WHEN** a session's process record in `~/.claude/sessions` points to a process that is still alive
- **THEN** the session is marked live

#### Scenario: Stale process record
- **WHEN** the recorded process no longer exists
- **THEN** the session is not marked live

### Requirement: Linked memories
The system SHALL show the supermemory notes whose recorded session matches a session, read-only, and SHALL still show the catalog when the memory server is unreachable.

#### Scenario: Session wrote memories
- **WHEN** the memory server holds documents whose session metadata equals the session id
- **THEN** their type, time and a short excerpt are shown with that session

#### Scenario: Memory server down
- **WHEN** the memory server does not respond
- **THEN** the catalog loads without linked memories and states that they are unavailable

### Requirement: Transcript text stays local
The system SHALL NOT send transcript contents to any network service. Only session ids are used to query the local memory server.

#### Scenario: Catalog load
- **WHEN** the catalog is built
- **THEN** no request containing prompt or reply text leaves the machine, and the only outgoing request is to the local memory server
