# External Skill Import

An external Markdown/ZIP is a conversion source; the product runtime still uses native Skill JSON + Recipes, and no second Skill Runtime is introduced.

## Default conversion path (report v3)

1. Read the MD, or a ZIP containing one SKILL.md, and check size, path safety, and referenced resources. Attached scripts are not executed.
2. One model call extracts the key methods and designs the Skill/Recipes. The design is internal auxiliary information and does not require verbatim citation lists, one-to-one mapping, or test scenarios.
3. Generate a native Bundle. Code fills in the repeated metadata that can be determined; non-empty conflicts still raise errors. Existing Recipes must be reused as is, or given a new ID.
4. Validate the Bundle, Skill, Recipes, references, input parameters, and rating scales, normalize the result and validate once more. Independent structural errors are fed back together for repair.
5. Review the final package against the full original text. Blocking is limited to specific method omissions, method changes, and wrong Recipe responsibilities, which must come with original-text basis and Bundle field evidence; optional suggestions are warnings. The intermediate design is not a final hard contract.
6. A package that passes the structure and method review can be installed; with warnings it can be installed after confirmation. A modified draft must be re-validated, and the report is bound to the final package content hash.

By default no Graph is generated, and models, credentials, real assets, runtime configuration, or capability snapshots are not checked. The existing workflow execution mechanism stays as is. The standalone static Graph validation tool does not take part in import and install decisions.

Without repairs there are usually three model calls: design, generation, and review. Each format error is corrected at most once, with at most three rounds of candidate packages (leaving a chance for method repair after a format repair), for at most ten calls in total. A repair carries the specific errors and the previous answer. Re-validating a draft edited by the user only checks and does not rewrite it for the user.

## UI and API

Settings → Skills → Import external Skill. Submitting a task currently still needs project context, and the task runs through the default queue; closing the dialog does not interrupt it. The Hermes/Codex in chat share the external import tool entry.

`/api/v1/projects/{project}/freezone/skill-imports` supports submission and listing; `/{id}` reads details, `/{id}/retry` re-converts, `/{id}/validate` checks a draft, and `/{id}/install` installs. Source and conversion records are isolated by project and requester, and installation goes to the current user's skill library.

The list expands/collapses inline per record. The result shows only the structure check and method completeness, and offers edit, re-check, install, copy to Skill Studio, and download JSON. The task center can open the corresponding record.

An old v2 report cannot directly unlock installation: re-convert or re-validate to generate a v3 report. The new version discards the old capability mapping and Graph blocking, re-checks against the final package, and does not turn an old report into a pass directly.

## Background diagnostics

Each run has a diagnostic_run_id, correlated with import_id, task_id, model route, stage, attempt count, input hash, and duration. Ordinary application logs use the skill_import prefix and record meta information only.

The sanitized requests, responses, and errors are saved in the diagnostics field of `<state_dir>/skill_imports/<account_hash>/<import_id>.json`, and the public API does not return them. Requests are at most 180,000 characters and responses at most 100,000 characters; each import keeps the latest 100 events with a total of no more than 2 MB, with truncation and eviction records. Diagnostics contain user content and are for background troubleshooting only.

## Verification boundary

Content review is a model-assisted check, not a guarantee of production results. Installation only confirms the native package structure and the converted content, and does not prove that any workflow or media output is correct. It will not install automatically, overwrite shared Recipes, execute source package scripts, or generate media.

### Recipe reuse

The conversion design stage reads the full native definition of existing Recipes and compares inputs and outputs, mandatory formats, production methods, and quality constraints. When compatible, the existing ID is referenced as is; if only the subject, style, or task parameters differ, context is preferably passed by Skill planning. A new one is added only when there is a method conflict, and the design record `recipe_decisions` keeps the candidates and reasons; the reuse count is not an installation threshold.

The generation stage may omit definitions of shared Recipes that are already referenced; the server fills them in from the catalog snapshot, forming a complete exportable Bundle. A rewritten existing definition is still rejected and never silently overwritten. The final report `recipe_reuse` marks reused and newly added IDs based on the actual Bundle, and the background records a `recipe_reuse_resolved` log. Validation of a user's hand-edited draft does not automatically write content.
