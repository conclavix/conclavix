# Agents per project

Each project decides which agents may work in it. Typical use: a pull-request review agent that
is off by default and switched on only in the projects that should get reviews.

## Effective state

An agent is enabled in a project when

1. it is the organisation's lead: the lead is always enabled everywhere and cannot be disabled;
2. otherwise, the project has an override for it: the override decides (`source: 'project'`);
3. otherwise, the agent's `projectDefault` decides (`source: 'default'`).

`projectDefault` is `'enabled'` or `'disabled'` and is set when creating or editing an agent
("Active in projects by default" in the web app). Agents stored before the field existed have no
value and count as `'enabled'`, so upgrading changes nothing.

Every issue belongs to a project (`projectId` is required), so there are no project-less issues.
Should an issue's project be missing, the agent's default applies.

## API

| Route                                       | Capability | Purpose                                             |
| ------------------------------------------- | ---------- | --------------------------------------------------- |
| `GET /api/projects/:id/agents`              | `read`     | Every agent with its effective state in the project |
| `PUT /api/projects/:id/agents/:agentId`     | `agents`   | `{ "enabled": true \| false \| null }`              |
| `POST /api/agents`, `PATCH /api/agents/:id` | `agents`   | `projectDefault: 'enabled' \| 'disabled'`           |

Each `GET` item carries `enabled`, `source` (`default` or `project`), `override` (the stored value
or `null`), `projectDefault`, `isLead` and `openIssues` (open issues assigned to the agent in this
project). `enabled: null` removes the override, so the agent default applies again. Disabling the
lead returns `409 lead_always_enabled`; `PUT` stores no override for the lead, and an agent that becomes the lead loses its project overrides. A `PUT` that changes nothing writes nothing. Owners and admins may change access; members and viewers
only read it. Override changes are audited as `project.agent_access_changed`, project default
changes as `agent.project_default_changed`.

## Enforcement

The server enforces access; the web app only mirrors it.

- **Assigning.** Creating an issue for, or assigning an issue to, an agent not enabled in the
  issue's project fails with `422 agent_disabled_in_project`. This covers `POST /api/issues`,
  `PATCH /api/issues/:ref` and the agent MCP tools `create_issue` and `create_subissue`. Keeping
  an existing assignee and unassigning always work. A manual wake
  (`POST /api/agents/:id/wake`) fails the same way.
- **Delegating.** `list_team` lists linked agents that are not enabled in the run's project under
  `notInThisProject` instead of `canDelegateTo`, `get_project_board` names them in
  `agentsNotEnabled`, and the run prompt tells the agent not to assign them work there.
- **Scheduling.** The scheduler skips a wake for an agent not enabled in the issue's project and
  records `skipReason: 'agent_disabled_in_project'` on the wake (plus a scheduler log line). The
  heartbeat sweep does not create wakes for such issues at all.
- **Existing work.** Open issues already assigned to an agent when it gets disabled stay
  assigned but are not worked on. The project board marks them "not enabled here", the issue
  page warns, and the Agents tab shows the count before disabling. Enabling the agent again (or
  reassigning) resumes the work with the next heartbeat or wake.
- **Runs already queued.** A run the scheduler queued before the change still runs, as it does
  when an agent is paused; access is checked when a wake becomes a run.

Access changes and issue assignment both take the org-chart lock, so an assignment cannot slip
past a concurrent change.

## Web app

The project page has an **Agents** tab: each agent with avatar, title, open issues, a switch, a
chip for where the state comes from and a reset button for project overrides. The lead's switch
is locked. Disabling an agent with open issues asks first. Assignee pickers on the board and the
issue page show agents not enabled in the project as disabled entries with a tooltip.
