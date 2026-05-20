## MODIFIED Requirements

### Requirement: SDD factory is the documented template, not a runnable singleton

The shipped `examples/sdd.yaml` SHALL NOT be a hand-edited template.
Users SHALL invoke the SDD factory by:

1. authoring a brief at `inputs/<change-name>.md` (per the
   `brief-schema` capability) whose `factory:` field resolves to the
   shipped `examples/sdd.yaml`;
2. invoking `minifac run <change-name>` (per the `run-cli`
   capability's lookup precedence).

The documentation SHALL state explicitly that the prior "copy
`examples/sdd.yaml` to `sdd-<change>.yaml` and find-and-replace
`<CHANGE_NAME>`" workflow is removed. The two pre-this-change required
edits (change name embedded in prompts; per-node `cwd`) are now
expressed: change name as `{{ brief.change }}` resolved at runtime
from the brief; per-node `cwd` as `{{ run.cwd }}` resolved at
runtime from the worktree the CLI creates (per the
`worktree-management` capability). The shipped factory SHALL run
end-to-end via `minifac run <change>` against any OpenSpec-equipped
target repo without any hand edit to the shipped YAML.

#### Scenario: README and sdd.md point users to the brief workflow

- **WHEN** a user reads `README.md`'s "Run the example" section or
  `examples/sdd.md`
- **THEN** the section instructs the user to author a brief at
  `inputs/<change>.md` and invoke `minifac run <change>`, and does
  not instruct the user to copy or edit `examples/sdd.yaml`

#### Scenario: Shipped `examples/sdd.yaml` is runnable as authored

- **WHEN** a user authors a valid brief at `inputs/<change>.md` whose
  `factory:` field resolves to the shipped `examples/sdd.yaml`, and
  invokes `minifac run <change>`
- **THEN** the CLI creates a worktree, loads the brief and the
  unchanged shipped `examples/sdd.yaml`, and runs the factory
  end-to-end inside the worktree without any hand edit to the
  shipped YAML

## ADDED Requirements

### Requirement: SDD factory nodes use `{{ run.cwd }}` as their cwd

Every node in the shipped `examples/sdd.yaml` SHALL declare its
`cwd` as the literal template string `"{{ run.cwd }}"`. No node
SHALL declare a hand-edited absolute path as its `cwd`. The
substitution semantics defined in the `graph-runner` capability's
"Brief token substitution" and "Run-level cwd resolution"
requirements bind: at runtime each node's `cwd` resolves to the
worktree path the CLI created (or to `process.cwd()` under
`--in-place` mode).

No shipped SDD prompt SHALL contain the literal placeholder
`/path/to/target/repo`. The pre-this-change "edit each node's
`cwd` per change" step is replaced by run-time substitution.

#### Scenario: Every node declares `cwd: "{{ run.cwd }}"`

- **WHEN** the shipped `examples/sdd.yaml` is loaded
- **THEN** for each of `propose`, `apply`, `verify`, and `archive`,
  `factory.nodes.<node>.cwd === "{{ run.cwd }}"`

#### Scenario: No node carries the old cwd placeholder

- **WHEN** the shipped `examples/sdd.yaml` is loaded
- **THEN** no node's `cwd` contains the substring
  `/path/to/target/repo`
