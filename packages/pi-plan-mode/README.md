# @codella/pi-plan-mode

Approval-gated plan mode extension for [Pi](https://pi.dev).

Plan mode keeps Pi read-only while it explores and writes a numbered plan. The agent cannot execute mutating tools or commands until you explicitly approve the plan.

## Install

```bash
pi install npm:@codella/pi-plan-mode
```

## Commands

- `/plan` - Toggle plan mode.
- `/plan on` - Enable read-only plan mode.
- `/plan off` - Disable plan mode and restore previous tools.

## Shortcut

- `ctrl+alt+p` - Toggle plan mode.

## CLI flag

Start Pi in plan mode:

```bash
pi --plan
```

## How it works

Before approval:

- Active tools are restricted to read-only tools.
- Bash commands are allowlisted to inspection commands.
- Mutating tools such as `edit` and `write` are blocked.
- The assistant is instructed to produce a numbered `Plan:`.
- Approval summaries flatten nested bullets and indented continuation lines into their parent numbered steps, avoiding dangling headings such as `Implement the UI:`.
- Approval summaries and the progress widget preserve the extracted plan wording and wrap long numbered items in the TUI instead of shortening them with ellipses.

After approval:

- Previous tools are restored.
- The assistant executes only the approved plan.
- A framed progress widget shows approval state, completion percentage, the active next step, and completed steps.
- A temporary `plan_progress` tool silently updates the task list after each completed step without posting progress telemetry into the chat.
- The progress widget is cleared as soon as the approved plan is complete.
- `[DONE:n]` markers are still recognized as a fallback.

## License

MIT
