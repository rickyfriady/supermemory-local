# Spec Delta

## Purpose

Lets the user change or remove sessions from the browser while guaranteeing that nothing is modified until the user personally approves it in the terminal, and that deletions can be undone.

## ADDED Requirements

### Requirement: Two-step approval for every change
Any action that modifies data (delete, restore, purge, rename, tags) SHALL first be recorded as a pending action and SHALL run only after the user approves it in the terminal that runs the server. A request from the browser or any other HTTP client SHALL NOT be able to approve an action.

#### Scenario: Request creates only a pending action
- **WHEN** the browser requests a delete
- **THEN** the server records a pending action, changes no files, and shows the action in the terminal awaiting approval

#### Scenario: Approval in the terminal
- **WHEN** the user confirms the pending action in the terminal
- **THEN** the action runs once and the browser shows its result

#### Scenario: Rejection or no answer
- **WHEN** the user rejects the action or leaves it unanswered until it expires
- **THEN** nothing is modified and the browser shows the action as rejected or expired

#### Scenario: Approval attempted over HTTP
- **WHEN** any HTTP request tries to approve or execute a pending action
- **THEN** the request is refused and the action stays pending

### Requirement: Typed confirmation in the browser
Before a destructive request is sent, the browser SHALL ask the user to type the short id of the session.

#### Scenario: Wrong confirmation
- **WHEN** the typed id does not match the session
- **THEN** no request is sent

### Requirement: Soft delete with restore and purge
Deleting a session SHALL move its transcript, its sibling folder and its file-history folder into a trash area inside this repo's data directory instead of removing them, and the user SHALL be able to restore them to the original locations or permanently purge them, each with the same approval.

#### Scenario: Delete moves, not removes
- **WHEN** a delete is approved
- **THEN** the session no longer appears in Claude Code's own session list, all its files exist in the trash, and the listing shows it under deleted sessions

#### Scenario: Restore
- **WHEN** a restore is approved for a trashed session
- **THEN** its files are back in their original locations and the session appears in the catalog again

#### Scenario: Restore would overwrite
- **WHEN** a file already exists at an original location
- **THEN** the restore is refused and nothing is overwritten

#### Scenario: Purge
- **WHEN** a purge is approved for a trashed session
- **THEN** its files are permanently removed from the trash

### Requirement: Live sessions cannot be deleted
The system SHALL refuse to delete a session that is marked live.

#### Scenario: Delete a running session
- **WHEN** a delete is requested for a live session
- **THEN** it is refused without creating a pending action

#### Scenario: Session starts running after request
- **WHEN** a session becomes live between the request and the approval
- **THEN** the action fails at execution time and nothing is moved

### Requirement: Optional deletion of linked memories
A delete request MAY include a separate option to also delete the supermemory notes written by that session. The option SHALL be off by default and the result SHALL report each note that could not be deleted.

#### Scenario: Option off
- **WHEN** a delete is approved without the option
- **THEN** the session's memories are untouched

#### Scenario: Note still processing
- **WHEN** the option is on and the memory server refuses to delete a note because it is still processing
- **THEN** the session files are still moved to the trash and the result lists that note as not deleted

### Requirement: Rename and tags without touching transcripts
The user SHALL be able to give a session a custom name and tags. They SHALL be stored separately from Claude Code's files, shown in the catalog, and searchable, and no transcript file SHALL be modified.

#### Scenario: Rename
- **WHEN** a rename is approved
- **THEN** the catalog shows the custom name, and the session's transcript file is byte-for-byte unchanged

#### Scenario: Deleted and restored session
- **WHEN** a session with a custom name and tags is deleted and then restored
- **THEN** the name and tags are still present

### Requirement: Resume and new-session commands
The system SHALL give, for any listed session, a ready-to-run command that resumes it in its original working directory, and for any project a command that starts a new session there. These commands are only displayed or copied; the server SHALL NOT run them.

#### Scenario: Copy resume command
- **WHEN** the user asks for a session's resume command
- **THEN** a command that changes to the session's working directory and resumes that session id is shown for copying

### Requirement: Audit trail
Every approved, rejected or expired action SHALL be recorded with time, kind, target and outcome in a local log.

#### Scenario: Approved delete
- **WHEN** a delete is approved and completes
- **THEN** one log entry records it with its outcome
