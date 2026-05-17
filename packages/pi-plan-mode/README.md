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
- `/plan approve` or `/plan execute` - Approve the pending plan and execute it.
- `/plan reject` - Reject the pending plan and stay in plan mode.
- `/plan status` - Show mode, approval state, active tools, and tracked steps.
- `/plan clear` - Clear tracked steps and approval state.
- `/todos` - Show current plan progress.

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

After approval:

- Previous tools are restored.
- The assistant executes only the approved plan.
- Progress is tracked with `[DONE:n]` markers.

## License

MIT
