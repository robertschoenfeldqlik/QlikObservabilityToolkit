# Usage examples

Common Talend Cloud workflows you can drive from Claude via this server. Each
example shows the prompt you'd ask Claude, the tool Claude picks, and the JSON
arguments it would send.

All examples assume you've completed [setup-wizard.md](./setup-wizard.md).

## Inventory

### List workspaces

> "Show me all the workspaces in my Talend tenant."

| Tool | `orchestration__getAvailableWorkspaces` |
| --- | --- |
| HTTP | `GET /orchestration/workspaces` |
| Args | `{}` |

### List environments

> "What environments do we have?"

| Tool | `orchestration__getAvailableEnvironments` |
| --- | --- |
| HTTP | `GET /orchestration/environments` |
| Args | `{}` |

### List tasks in a workspace

> "List tasks in workspace `abc-123`."

| Tool | `orchestration__getAvailableTasks` |
| --- | --- |
| HTTP | `GET /orchestration/executables/tasks` |
| Args | `{ "workspaceId": "abc-123" }` |

Optional filters: `environmentId`, `name`, `limit`, `offset`, `types`.

## Running tasks

### Run a task once

Talend's "run task" lives on the run-config endpoints — you `PUT` a run-config
to schedule (immediate or cron), then `GET` the events to see what's queued.

> "Run task `task-456` immediately."

| Tool | `orchestration__configureTaskExecution` |
| --- | --- |
| HTTP | `PUT /orchestration/executables/tasks/{taskId}/run-config` |
| Args | `{ "taskId": "task-456", "body": { "runType": "ON_DEMAND" } }` |

(The exact body shape depends on the task type; see
[api-reference/orchestration.md](./api-reference/orchestration.md) for the
schema.)

### Pause / resume a task

> "Pause task `task-456`."

| Tool | `orchestration__pauseTaskExecution` |
| --- | --- |
| HTTP | `PUT /orchestration/executables/tasks/{taskId}/pause` |
| Args | `{ "taskId": "task-456", "body": { "pause": true } }` |

## Plans

### Create a plan

> "Create a new plan called 'nightly-ingest' in workspace `abc-123`."

| Tool | `orchestration__createPlan` |
| --- | --- |
| HTTP | `POST /orchestration/executables/plans` |
| Args | `{ "body": { "name": "nightly-ingest", "workspaceId": "abc-123", "steps": [...] } }` |

### List plans

| Tool | `orchestration__getAvailablePlans` |
| --- | --- |
| HTTP | `GET /orchestration/executables/plans` |

## Schedules

### Create a schedule and attach to a task

```text
1. orchestration__createSchedule
   body: { "name": "weekday-7am", "triggers": [{ "type": "CRON", "cron": "0 7 * * MON-FRI" }] }

2. orchestration__addScheduleToTask
   taskId: "task-456"
   body:   { "scheduleId": "<id from step 1>" }
```

### See the next 5 scheduled events for a task

| Tool | `orchestration__getTaskScheduledEvents` |
| --- | --- |
| HTTP | `GET /orchestration/executables/tasks/{taskId}/run-config/events` |
| Args | `{ "taskId": "task-456", "limit": 5 }` |

## Monitoring

### Last 50 execution logs for a task

| Tool | (varies — check) `execution_logs__*` |
| --- | --- |
| API | `execution-logs` |

See [api-reference/execution-logs.md](./api-reference/execution-logs.md).

### Task execution metrics

| Tool | `observability_metrics__*` |
| --- | --- |
| API | `observability-metrics` |

See [api-reference/observability-metrics.md](./api-reference/observability-metrics.md).

### Cross-task execution search

| Tool | `orchestration__searchScheduledEvents` |
| --- | --- |
| HTTP | `GET /orchestration/executables/events/search` |

## Connections & datasets

### List connections

| Tool | `orchestration__getAvailableConnections` |
| --- | --- |
| HTTP | `GET /orchestration/connections` |

### List datasets

| Tool | (varies) — see [api-reference/dataset.md](./api-reference/dataset.md) |

## Promotions (CI/CD between environments)

### List promotions

| Tool | `orchestration__getAvailablePromotions` |
| --- | --- |
| HTTP | `GET /orchestration/executables/promotions` |

### Perform a promotion analysis

| Tool | `orchestration__post_orchestration_executables_promotions_promotionId` |
| --- | --- |
| HTTP | `POST /orchestration/executables/promotions/{promotionId}` |
| Args | `{ "promotionId": "promo-789", "body": { "action": "analyze" } }` |

(Operation has no `operationId` in the spec, hence the verbose generated name.
Future spec revisions usually fix these.)

## Identities & access

### List users

| Tool | `identities_management__listUsers` |
| --- | --- |
| API | `identities-management` |

See [api-reference/identities-management.md](./api-reference/identities-management.md) for the full surface (groups, roles, etc.).

### SCIM user management

| API | [api-reference/scim-v2.md](./api-reference/scim-v2.md) |

If you're integrating with a SCIM provisioning system, the `scim_v2__*` tools
mirror the SCIM 2.0 spec one-to-one.

## Tips for prompting

- **Be specific about IDs.** Claude can't guess workspace or task IDs — ask it
  to list first, then act.
- **Limit the API surface.** If you're only going to ask about tasks and runs,
  set `TMC_APIS="orchestration,observability-metrics,execution-logs"` so
  Claude isn't choosing between 315 tools.
- **Watch for pagination.** Listing endpoints take `limit`/`offset`; ask
  Claude to fetch more pages if results look truncated.
- **Check the response shape** in the corresponding `api-reference/<api>.md` —
  the server returns the raw API JSON, which Claude usually summarizes well.

## What to do when a tool name looks ugly

A few Talend operations don't have an `operationId` in their OpenAPI spec, so
their generated names look like
`orchestration__post_orchestration_executables_promotions_promoti_2`. Those
still work fine — the description includes the original `METHOD /path`, so
you can identify them. Talend periodically fixes these in spec updates; run
`npm run fetch-specs` to pick up new names.
