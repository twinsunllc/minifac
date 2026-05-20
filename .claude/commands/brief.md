---
name: "Brief"
description: Co-author a minifac brief one question at a time
category: Workflow
tags: [workflow, brief, minifac]
---

Author a new minifac brief at `inputs/<name>.md` by walking through
the canonical question schema one prompt at a time.

The argument after `/brief` is the change name (kebab-case), OR a
description of what the user wants to build. If omitted, the skill
will ask.

Invoke the `brief-authoring` skill and follow its steps. The skill
reads the question schema from `src/brief/authoring.ts` and writes
the produced brief to `inputs/<change>.md`.

For the offline / scripted equivalent, use the CLI:
`minifac brief <name>` (interactive) or `minifac brief <name> --from
answers.yaml` (non-interactive).
