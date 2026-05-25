# @codella/pi-plan-mode

Plan-mode prompt template for [Pi](https://pi.dev).

This package adds a `/plan` prompt command. It does not gate tools or modify Pi runtime behavior; it expands to a planning prompt that asks the agent to inspect first, propose a numbered plan, and wait for approval before editing.

## Install

```bash
pi install npm:@codella/pi-plan-mode
```

## Command

```text
/plan [task]
```

Example:

```text
/plan refactor auth handling and update tests
```

The expanded prompt tells the agent to:

1. Summarize the goal.
2. Inspect relevant files and project guidance.
3. Propose a short numbered plan.
4. List expected files to edit and validation commands to run.
5. Stop and ask `Proceed?` before editing, installing dependencies, committing, or pushing.

After approval, the agent should execute only the approved plan, ask before expanding scope, run validation, and summarize what changed.

## Why prompt-only?

A prompt template keeps plan mode lightweight and explicit. Use it when you want planning discipline without an extension that blocks tools or manages approval state.

## License

MIT
