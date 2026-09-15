## MODIFIED Requirements

### Requirement: Step reference syntax and lookup precedence

The reference grammar SHALL accept four forms. In all forms, `<name>` matches `[a-z][a-z0-9-]*` and `<version>`, when present, matches a non-empty string after `@`:

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
- `library:<name>` or `library:<name>@<version>` (library prefix) — SHALL try the **local layer** — `<callerCwd>/.minifac/steps/<name>.yaml`, then `<callerCwd>/steps/<name>.yaml` when `<callerCwd>` is a factory repo (its root carries `factory.yaml`) — and then `<library-root>/steps/<name>.yaml`, where `<library-root>` is the project's library tree at the pinned sha (per the `library-resolution` capability). A local step of the same name SHALL replace the library's step wholly; no field of the library step is merged. The resolver SHALL NOT fall through to a built-in. When the project declares no library, the resolver SHALL throw `StepLoadError` stating that the `library:` namespace needs a `library:` declaration. On a miss, the message SHALL name the reference, state that neither the library (by repo, ref and sha) nor the local layer has such a step, and list every path tried. The `library:` form SHALL NOT accept a scope.
- `<name>` or `<name>@<version>` (bare) — SHALL try the local layer (as above), then `<library-root>/steps/<name>.yaml` when the project declares a library, then fall back to the built-in lookup, which this change leaves as it was. The first existing file wins.

A reference whose value contains a path separator (other than the single `<scope>/<name>` separator), a file extension, or whitespace SHALL be rejected with a `StepLoadError` naming the offending value; only the four forms above are valid.

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

#### Scenario: Bare `<name>` resolves from the library before built-ins

- **WHEN** the project pins a library whose tree has `steps/review.yaml`, and no local `review` step exists
- **THEN** the resolver returns the library's `steps/review.yaml` at the pinned sha

#### Scenario: A factory step replaces the library step wholly

- **WHEN** a factory repo has `steps/review.yaml`, the pinned library also has `steps/review.yaml`, and a node declares `uses: review` or `uses: library:review`
- **THEN** the resolver returns the factory's `steps/review.yaml`, and no field of the library step appears in the inlined node

#### Scenario: `library:<name>` the library lacks is a load error naming the namespace

- **WHEN** a node declares `uses: library:nope`, and neither the local layer nor the pinned library has a `nope` step
- **THEN** the resolver throws `StepLoadError` whose message names `library:nope` and the library's repo, ref and sha

#### Scenario: `library:<name>` without a declared library is a load error

- **WHEN** a node declares `uses: library:review` and the project declares no library
- **THEN** the resolver throws `StepLoadError` stating that the project declares no library
