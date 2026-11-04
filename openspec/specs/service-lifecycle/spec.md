# service-lifecycle Specification

## Purpose
Keeps the local supermemory processes (memory server, LLM proxy, Zed adapter) running without manual intervention, and gives one command to start, stop and health-check them.

## Requirements

### Requirement: Start at login
The memory server, LLM proxy and Zed adapter SHALL each run as a user LaunchAgent that starts when the user logs in.

#### Scenario: After reboot
- **WHEN** the user logs in after a reboot without running any command
- **THEN** the memory API answers on its configured port and the LLM proxy and Zed adapter answer on theirs

### Requirement: Restart on exit
Each of the three processes SHALL be restarted automatically when it exits, independently of the other two.

#### Scenario: Proxy crashes
- **WHEN** the LLM proxy process is killed
- **THEN** it answers on its port again within 30 seconds and the memory server keeps its original process ID

### Requirement: Portable service definitions
The service definitions SHALL be derived from the repository location and the user's home directory when installed, and the repository MUST NOT contain absolute user-specific paths for them.

#### Scenario: Repository scan
- **WHEN** the repository is searched for `/Users/`
- **THEN** no service definition or controller file matches

### Requirement: Single controller
One command SHALL start, stop, restart, report status of, and show logs for all three processes.

#### Scenario: Stop
- **WHEN** the user runs the stop command
- **THEN** the three LaunchAgents are unloaded and none of the three ports is listening when the command returns

#### Scenario: Restart
- **WHEN** the user runs the restart command twice in a row
- **THEN** after each run all three components answer on their configured ports

### Requirement: Single runtime guard
Start MUST refuse to load the LaunchAgents while another process already listens on one of the three ports, and MUST name the port and the process holding it.

#### Scenario: Legacy daemon still running
- **WHEN** a memory server started outside launchd holds the memory API port and the user runs start
- **THEN** start exits non-zero naming that port and process, and loads no LaunchAgent

### Requirement: Upstream router check
Start and status SHALL report whether the 9router gateway answers, and start SHALL proceed even when it does not.

#### Scenario: Router down
- **WHEN** 9router is not answering and the user runs start
- **THEN** start loads the three LaunchAgents and prints a warning naming 9router and how to start it

### Requirement: Health exit status
Status SHALL exit with code 0 only when the memory API and the LLM proxy both answer, and non-zero otherwise.

#### Scenario: Memory API down
- **WHEN** the memory server is not answering and status runs
- **THEN** status reports the memory API as down and exits non-zero

### Requirement: Foreground debugging
Each process SHALL be runnable in the foreground from the repository with the same configuration the LaunchAgent uses.

#### Scenario: Manual server run
- **WHEN** the LaunchAgents are stopped and the user runs the foreground command for the memory server
- **THEN** the server runs attached to the terminal on the configured port and the active embedding store
