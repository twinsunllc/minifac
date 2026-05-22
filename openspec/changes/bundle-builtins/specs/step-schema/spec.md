## MODIFIED Requirements

### Requirement: Step reference syntax and lookup precedence

The reference grammar SHALL accept three forms. In all forms, `<name>` matches `[a-z][a-z0-9-]*` and `<version>`, when present, matches a non-empty string after `@`:

- `minifac:<name>` (built-in prefix) — SHALL be resolved against the
  installed-package directory first, then the source-tree fallback,
  using this two-step precedence:
    1. `<install-root>/examples/steps/<name>.yaml`, where
       `<install-root>` is the directory containing the runner's
       `package.json` (the package root of the running minifac).
    2. `<callerCwd>/examples/steps/<name>.yaml`.
  The first existing file wins. When running from the minifac source
  tree, the two paths collapse to the same file.
- `<scope>/<name>` or `<scope>/<name>@<version>` — namespaced reference. The `<scope>` SHALL match `[a-z][a-z0-9-]*`. The grammar SHALL parse the form, but resolution SHALL throw `StepLoadError` whose message identifies the reference, states that the scoped form is reserved for future remote resolution and not yet supported, and points the operator at `docs/concepts/Reference.md` for the planned semantics. The form SHALL NOT silently fall through to a bare-name lookup.
- `<name>` or `<name>@<version>` (bare) — SHALL try `<callerCwd>/.minifac/steps/<name>.yaml` first; if that path does not exist, fall back to `<callerCwd>/examples/steps/<name>.yaml`. Bare references are user-local; the resolver SHALL NOT consult the install root for bare names.

A reference whose value contains a path separator (other than the single `<scope>/<name>` separator), a file extension, or whitespace SHALL be rejected with a `StepLoadError` naming the offending value; only the three forms above are valid in v0.

Resolution SHALL be evaluated relative to the cwd the factory loader is given. The resolver SHALL return the absolute path of the resolved file; downstream code reads and parses that file.

On a missed `minifac:<name>` lookup (no candidate path exists), the resolver SHALL throw `StepLoadError` whose message names the reference and both candidate absolute paths in order (install-root path first, source-tree fallback second). On a missed bare-name lookup, the resolver SHALL throw `StepLoadError` naming both candidate paths it tried. The error message SHALL list every path tried, in evaluation order, so the operator can correct the typo or add the missing step.

The `minifac/<name>` shape (with a `/`) is a `<scope>/<name>` reference and SHALL be rejected at resolution per the rule above; the `minifac:<name>` shape (with a `:`) is the built-in-prefix form and uses the install-root-first lookup.

#### Scenario: `minifac:<name>` resolves to the installed package's examples/steps

- **WHEN** the resolver is asked to resolve `minifac:openspec-propose`, `<install-root>/examples/steps/openspec-propose.yaml` exists, and the resolver was given an arbitrary `<callerCwd>`
- **THEN** the resolver returns the absolute path to the file in `<install-root>/examples/steps/`; the source-tree fallback is not consulted

#### Scenario: `minifac:<name>` falls back to source-tree when install root is missing the file

- **WHEN** the resolver is asked to resolve `minifac:openspec-propose`, `<install-root>/examples/steps/openspec-propose.yaml` does not exist, and `<callerCwd>/examples/steps/openspec-propose.yaml` exists
- **THEN** the resolver returns the absolute path to the file under `<callerCwd>/examples/steps/`

#### Scenario: `minifac:<name>` skips local lookup even if local exists

- **WHEN** the resolver is asked to resolve `minifac:openspec-propose`, both `<callerCwd>/.minifac/steps/openspec-propose.yaml` and `<install-root>/examples/steps/openspec-propose.yaml` exist
- **THEN** the resolver returns the path to the install-root file; the local file is not consulted

#### Scenario: Bare `<name>` prefers local over source-tree built-in

- **WHEN** the resolver is asked to resolve `openspec-verify`, and both `<callerCwd>/.minifac/steps/openspec-verify.yaml` and `<callerCwd>/examples/steps/openspec-verify.yaml` exist
- **THEN** the resolver returns the path to the local file in `.minifac/steps/`

#### Scenario: Bare `<name>` falls back to source-tree built-in when local is missing

- **WHEN** the resolver is asked to resolve `openspec-verify`, only `<callerCwd>/examples/steps/openspec-verify.yaml` exists (no local file), and there is no install-root path consulted for bare references
- **THEN** the resolver returns the path to the source-tree built-in file

#### Scenario: Bare `<name>` does not consult the install root

- **WHEN** the resolver is asked to resolve `openspec-verify`, `<install-root>/examples/steps/openspec-verify.yaml` exists, and neither `<callerCwd>/.minifac/steps/openspec-verify.yaml` nor `<callerCwd>/examples/steps/openspec-verify.yaml` exists
- **THEN** the resolver throws `StepLoadError`; the install-root path is not consulted for bare references

#### Scenario: Missing bare reference is rejected with both paths tried

- **WHEN** the resolver is asked to resolve `nonexistent` and neither `<callerCwd>/.minifac/steps/nonexistent.yaml` nor `<callerCwd>/examples/steps/nonexistent.yaml` exists
- **THEN** the resolver throws `StepLoadError` whose message names the reference and both candidate absolute paths in order

#### Scenario: Missing `minifac:<name>` is rejected with both paths tried

- **WHEN** the resolver is asked to resolve `minifac:nonexistent`, `<install-root>/examples/steps/nonexistent.yaml` does not exist, and `<callerCwd>/examples/steps/nonexistent.yaml` does not exist
- **THEN** the resolver throws `StepLoadError` whose message names the reference, the install-root path, and the source-tree fallback path, in that order

#### Scenario: `<scope>/<name>` is rejected at resolution with a Reference.md pointer

- **WHEN** the resolver is asked to resolve `myorg/openspec-propose`
- **THEN** the resolver throws `StepLoadError` whose message names the reference, states that the scoped form is reserved for future remote resolution and is not yet supported, and points the operator at `docs/concepts/Reference.md` for the planned semantics

#### Scenario: `<scope>/<name>@<version>` is rejected at resolution

- **WHEN** the resolver is asked to resolve `myorg/openspec-propose@1.0.0`
- **THEN** the resolver throws `StepLoadError` matching the reservation rule above; the pin is preserved in the error message for diagnostics

#### Scenario: Path-like reference is rejected

- **WHEN** the resolver is asked to resolve `./steps/foo.yaml` or `../steps/foo`
- **THEN** the resolver throws `StepLoadError` naming the offending value and explaining that only the documented forms are accepted

#### Scenario: Reference with whitespace is rejected

- **WHEN** the resolver is asked to resolve `open spec verify`
- **THEN** the resolver throws `StepLoadError` naming the offending value
