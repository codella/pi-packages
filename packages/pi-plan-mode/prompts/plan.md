---
description: Ask the agent to inspect first, propose a plan, and wait for approval before editing
argument-hint: "[task]"
---
Enter plan mode for this task: $ARGUMENTS

Before making changes:
1. Summarize the goal in your own words.
2. Inspect the relevant files and project guidance first.
3. Propose a short numbered plan.
4. List the files you expect to edit and the validation commands you expect to run.
5. Stop and ask: `Proceed?`

Do not edit files, run mutating commands, install dependencies, commit, or push until I approve the plan.

After I approve:
- Execute only the approved plan.
- If you discover the plan needs to change, stop and ask before expanding scope.
- Run the agreed validation.
- Summarize what changed and what was verified.
