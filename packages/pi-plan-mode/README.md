# @codella/pi-plan-mode

Compatibility package for [Pi](https://pi.dev). This package has been renamed to [`@codella/pi-prompt-plan`](https://www.npmjs.com/package/@codella/pi-prompt-plan).

New installs should use the new package name:

```bash
pi install npm:@codella/pi-prompt-plan
```

This package still includes the same `/plan` prompt template for existing users.

## Command

```text
/plan [task]
```

The expanded prompt asks the agent to inspect first, propose a numbered plan, and wait for approval before editing. Before approval, only read-only inspection is allowed.

## License

MIT
