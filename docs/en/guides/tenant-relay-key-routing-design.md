# User-Supplied Relay Key (BYOK) Design

> Status: implementation plan
>
> Code baseline: DramaClaw `freezone-canvas`; relay = `claymore-llm-gateway` (a QuantumNous/new-api fork); EE = `SuperTale_main` (credits are implemented on the EE side in `ports_bootstrap.py`)
>
> Scope: shared instances for starter and trial customers. Large customers get dedicated deployments and are out of scope for this plan.

## 0. Implementation guide

**In one sentence: if a user configures their own relay key, use their key and do not deduct credits; if not, use the deployment-level key and deduct credits as usual.**

| User state | Which relay key | Who bears the cost | DramaClaw credits |
| --- | --- | --- | --- |
| Not configured | **Deployment-level** key (configured by the SaaS operator) | Operator | **Deducted** (the operator recovers cost this way) |
| Configured their own | **User-level** key (BYOK) | The user | **Not deducted** (otherwise double charging) |

Five things to do:

| # | What to do | Main files | Measured size |
| --- | --- | --- | --- |
| 1 | Bucket Agent singletons by key | `freezone/text_node.py`, `agents/global_video_optimizer.py`, `model_gateway_runtime.py` | 3 places with the same pattern, **6 getter call sites in total** |
| 2 | `tenant_relay_key` table + admin API | `model_gateway_settings.py`, `api/routes/model_gateway.py` | ~120 lines of mechanical work; `settings.db` and the `save_*` pattern already exist |
| 3 | `get_effective_newapi_config(username=...)`; BYOK flag in contextvars | `model_gateway_settings.py:499`, `llm_instrumentation.py`, `task_backend/run_core.py:196` | key resolution has **only 4 call sites**; the flag has **two set points** (request entry + task side) |
| 4 | Add a BYOK check to EE's `EEUsageMeter` | EE side `ports_bootstrap.py:170` | **6 `if`s in one class**; the 37 business-code sites change by zero lines (§3.2) |
| 5 | Relay-side configuration (user / token / channel / `auto` group) | Relay admin console or admin API | **Zero code**, pure back-office configuration |

**About 250 lines plus tests in total.** The scale is small because each choke point is narrow: `get_effective_newapi_config` has only 4 call sites, the three Agent getters have 6 call sites in total, deduction is funneled through 6 `if`s in a thin EE shell layer, and the relay side needs zero code.

**Deduction correctness depends on only three places**: one predicate function (reads a contextvar) and two flag set points (the HTTP request entry and `task_backend/run_core.py:196`). Acceptance only needs to cover these three; there is no need to review the 37 credit call sites one by one (§3.2).

**Item 1 must come first, and it is the only structural obstacle.** It is not a matter of "being careful not to get it wrong": the existing three `if is None` checks make the feature impossible. No matter how correct the key resolution logic is, requests to those three places will be overridden by the key of whoever created the singleton first (§3.4). The other items just need to be changed as described.

Item 1 can also **land independently of BYOK**: after bucketing by key, with only one bucket the behavior is exactly the same as today, so it is a risk-free structural cleanup that removes the only obstacle on this path. After that, BYOK is never blocked by it, whenever it is done.

**Zero code for routing logic.** The user's relay key is backed by their account on the relay. Which models that account can use, which go through their own upstream channel, and which fall back to the shared channel are all decided by the relay's channel configuration and the `Ability` table. DramaClaw writes no traffic-splitting logic.

**DramaClaw does not need to know how money flows upstream.** Whether the quota of the user's relay account is topped up by themselves, topped up on their behalf, or bound to their own telecom TokenHub channel is a matter for the relay side and business. DramaClaw only answers one question: **which relay key does this request use, and should credits be deducted.**

### 0.1 Ownership of the two key layers: deployment-level vs user-level

DramaClaw can be self-hosted (`_uses_ce_gateway_settings()` and `MODE_CUSTOM` exist for self-hosters to point at their own gateway), so **"the key that credits consume" does not necessarily belong to us; it belongs to whoever operates the deployment**. It may be the official hosted service, or a partner who runs their own DramaClaw as a SaaS.

| | Whose key | Who bears upstream cost | Role of credits |
| --- | --- | --- | --- |
| **Deployment-level key** | The SaaS operator (three sources: env / `custom` / `official`) | Operator | The operator charges its users and recovers cost |
| **User-level key (BYOK)** | The user | The user | Not involved; the user is directly accountable to their own relay account |

So the accurate description of this plan is: **the deployment-level key is the default path and counts credits; a user can choose to bring their own key on the BYOK path, in which case credits are not involved.**

This split makes the feature equally valuable to self-hosters. When they operate a SaaS they run into the same need, "most users buy my credits, a few want to use their own key", and the implementation is identical; there is no need to distinguish official hosting from self-hosting.

The rest of this document uses "**deployment-level key**" for the operator's key and "**user-level key**" or "**BYOK**" for the key the user brings. Any phrase like "our key" should be read as the deployment-level key.

### 0.2 Prerequisite decision: is BYOK really needed

**Confirm this before starting, because the amount of change without BYOK is zero.**

If the upstream quota (e.g. telecom TokenHub) is topped up by the operator on behalf of the customer, that quota **can simply live under the operator's own upstream account** and become an ordinary channel in the relay:

```text
Plan A (BYOK, this document)
    Customer's upstream account <- topped up by the operator
    Customer's relay key -> relay user -> their own channel
    DramaClaw must recognize username, bucket Agents, skip credits   ~ 250 lines + 4 items

Plan B (no BYOK)
    The operator's upstream account
    The relay adds a channel for that upstream with high priority
    The customer buys credits as usual, DramaClaw changes by zero lines   zero changes
```

**Under both plans the customer gets exactly the same thing**: models from that upstream and the quota the operator provides. The only difference is whose name the credential sits under.

Plan B does not work and BYOK is required in only these cases; **if any one holds, this plan is needed**:

1. The upstream requires the contract, invoice, or real-name entity to be the customer themselves;
2. Discounts or rebates are calculated per customer entity and cannot be obtained when merged under the operator;
3. The customer insists on holding the credential themselves and does not accept the quota sitting in the operator's account;
4. **The customer already has existing upstream quota** that was not topped up by the operator;
5. **The channel partner needs to attribute actual spend to the customers it referred**; see below.

If none of the five holds, **do not build BYOK**: Plan B achieves the same effect at zero cost and saves a table, a set of admin APIs, and the Agent bucketing.

Condition 4 holds most often (the customer arrives with existing quota), in which case BYOK is mandatory. Still, confirm conditions 1 and 2 first, because they are upstream supplier policy and not our decision.

#### Condition 5 explained: channel attribution is structurally impossible under Plan B

The channel partner who referred the customer (possibly the upstream supplier itself) often needs to know **"how much money the customers I referred actually spent"**, to settle commissions or evaluate campaign effectiveness. Plan B cannot satisfy this, for two reasons:

**(1) Credits are not money and cannot be reverse-derived.** Credits are the operator's internal unit of measure, with gifts, discounts, promotional prices, and plan differences. If you give the credit count to the channel partner, they cannot convert it into money; the conversion ratio is itself commercial information of the operator.

**(2) Under Plan B the upstream has only one ledger.** All customers' consumption happens under the same upstream account of the operator, and the upstream bill is merged, so it **cannot structurally be split by customer**. The operator can of course compute each customer's consumption from its own logs and report it to the channel partner, but that is **self-attestation**: the channel partner must choose to trust the data we provide.

Under BYOK each customer owns their own upstream account, consumption is priced in real currency and lands directly on that account, and **the channel partner can see it in their own system** without trusting third-party data. This is the difference between self-attestation and third-party attestation, and it is usually a hard requirement when commission settlement is involved.

So this condition is not just "Plan B does a bit worse"; it is **structurally impossible**. If a channel commission arrangement exists, BYOK is a must.

#### What BYOK buys: separation of funds, and fewer dedicated deployments

The above lists only "when it is unnecessary"; it must also state what building it buys, otherwise the decision is one-sided.

**The core benefit is separation of funds and accounts**, not "avoiding dedicated deployments"; Plan B can do the latter too (a small company just buys credits on the shared instance). What BYOK additionally gives is:

- Each customer's upstream consumption goes through their own ledger instead of being mixed in one operator pool;
- The operator **does not have to advance upstream prepayments on behalf of customers**;
- Customers can see and control their own upstream spending.

**This yields an implicit benefit: it defuses some of the triggers for dedicated deployment.** Against the four conditions in §9:

| Trigger in §9 | Does BYOK defuse it |
| --- | --- |
| (1) Compliance: data or credentials must not share a database with others | No. The customer key is still stored in plaintext in the shared relay database (§4.4) |
| (2) Concurrency interference | No |
| (3) Customer requires self-service management of credentials and accounts | **Partly**: the credential is theirs and the accounts are separate, but the key is still entered and managed by the operator |
| (4) Divergent model list or routing needs | **Partly**: they can have their own channels and model list (§4.1) |

So the practical effect of BYOK is: **it lets a group of small customers who would otherwise demand a dedicated deployment because of (3) and (4) be satisfied on the shared instance.** One fewer dedicated deployment saves not only servers but also the cost of re-merging this repository, a fork, on every upgrade (§9).

This also explains why it is worth those 250 lines: it is not a technical concession, but raises the bar for customers who qualify to demand a dedicated deployment.

### 0.3 This is an EE feature; it is inert under CE

**The target scenario of this feature is EE: one deployment serves multiple paying users and needs per-user keys and billing. CE does not need it.**

CE is the single-machine edition. The deployer configures their own relay key or another upstream. The existing `MODE_CUSTOM` (`custom_newapi_base_url` / `custom_newapi_api_key`) already does this, and **the deployer's key is already their own key**, so there is no need to distinguish multiple users. Moreover, CE uses `NoOpUsageMeter` and does not deduct credits at all.

The work items are therefore split by repository and edition:

| Work item | Where the code lives | CE | EE |
| --- | --- | --- | --- |
| Bucket Agent singletons by key | dramaclaw | Inert (only one bucket) | Required |
| `tenant_relay_key` table + admin API | dramaclaw | Inert (no records) | Required |
| Add `username` to `get_effective_newapi_config` | dramaclaw | Inert (old behavior when not passed) | Required |
| BYOK flag in contextvars | dramaclaw | Inert (nobody reads it) | Required |
| 6 `if`s in `EEUsageMeter` | **SuperTale_main** | Not applicable | Required |

The first four items land in the shared repository (dramaclaw), and CE gets them too, but **they are all inert under CE**: no `tenant_relay_key` records -> everything resolves to the deployment-level key -> Agent bucketing has only one bucket -> behavior is identical to before the change.

**The only acceptance needed on the CE side is one regression**: with no `tenant_relay_key` records, behavior is byte-for-byte identical to before the change.

#### Deduction acceptance belongs to the EE repository

The two credit-related acceptance items cannot be verified under CE, because CE uses `NoOpUsageMeter` and deducts for nobody; the test would "pass" but mean nothing:

- BYOK users are not deducted credits;
- Non-BYOK users are deducted credits exactly as before the change.

These two must live in the EE repository's tests. The existing test layout on both sides already matches this split:

```text
dramaclaw/tests/ports/          test_usage_noop.py                     <- only the no-op implementation
SuperTale_main/tests/ports/     test_usage_noop.py
                                test_usage_meter.py    <- real deduction; new tests go here
                                test_record_parity.py
```

What can be verified on the CE side is key resolution and usage recording: two concurrent users each use their own key, resolution is correct after the `enabled` switch is toggled, and usage records are complete with an empty `credit_reservation_id`.

#### BYOK differs in nature between the two editions

- **EE**: the user brings their own key -> does not consume the operator's quota -> their credits are not deducted. This is a **complete commercial capability** (key isolation + billing isolation);
- **CE**: there is no credit system. If a self-hoster later really needs per-user keys, what they get is a **purely technical capability** (key isolation only), and how to charge users must be solved outside CE.

## 1. Current state and blockers

### 1.1 DramaClaw is currently "one key per deployment"

`get_effective_newapi_config()` at `src/novelvideo/model_gateway_settings.py:499` **has no user dimension at all**; what it resolves is a process-level single value:

```text
_uses_ce_gateway_settings()?
├─ no  -> environment variable NEWAPI_API_KEY
└─ yes -> mode=custom  -> settings.custom_newapi_api_key
          mode=official -> settings.official_newapi_api_key
```

`relay_token_name` in `src/novelvideo/newapi_provisioner.py` is likewise a global single value (default `dramaclaw-ce-runtime`), and the matching function is `create_or_reuse_relay_token` (singular).

The official gateway address is at `src/novelvideo/official_defaults.py:3`:

```python
OFFICIAL_NEWAPI_BASE_URL = "https://relayclaw.cdnfg.com/v1"
```

This structure is enough when "one deployment serves one customer", because the deployment itself is the boundary. To support user-supplied keys, a user dimension must be added.

### 1.2 DramaClaw has no tenant entity

The code has no org / tenant / company model and no user table; data is isolated by the `output/<user>/<project>/` directory. The tenant concept must be created, but **no database needs to be introduced**; see §2.1.

### 1.3 The relay side already has the native capabilities

| Capability | Location | Notes |
| --- | --- | --- |
| Routing table | `model/ability.go` | `Ability(Group, Model, ChannelId)` + `Priority` / `Weight` |
| Group resolution | `middleware/auth.go:421` | If `token.Group` is empty, fall back to `userCache.Group`; if non-empty, it must also be within the user's available groups |
| Cross-group fallback | `service/channel_select.go:84` | With `token.Group = "auto"`, iterate the user's auto groups in order; if a group has no available channel for the model, move to the next group |
| Auto group computation | `service/group.go:45` | `GetUserAutoGroup(userGroup)` = global `AutoGroups` ∩ the user's available groups |
| Channel test | `controller/channel-test.go:828` | `TestChannel`, used for instant validation on entry |
| Consumption attribution | `model/log.go` | Has `UserId` / `ChannelId` / `ChannelName` / `Group` / `ModelName` / `TokenName` / `Quota` together |

**Therefore the relay side needs no code changes**; everything is back-office configuration or admin API calls.

## 2. The `tenant_relay_key` table

### 2.1 Where to store: the existing settings.db

`src/novelvideo/model_gateway_settings.py` already has SQLite and table-creation logic:

```python
_settings_db_path()  ->  {STATE_DIR}/local/settings.db     # line 112
CREATE TABLE IF NOT EXISTS runtime_settings (...)          # line 125
```

`api/routes/model_gateway.py` already exposes a set of save functions such as `save_official_newapi_key` / `save_custom_newapi_gateway` / `save_newapi_provider_channels` as admin APIs. **Do not introduce a new database or a new admin framework; reuse this.**

### 2.2 Table schema

```sql
CREATE TABLE IF NOT EXISTS tenant_relay_key (
  tenant_id    TEXT PRIMARY KEY,          -- tenant identifier, see §2.3
  tenant_name  TEXT NOT NULL DEFAULT '',  -- display name, for the admin list
  relay_key    TEXT NOT NULL,             -- the user's own relay key
  enabled      INTEGER NOT NULL DEFAULT 1,-- troubleshooting switch, semantics in §2.4
  note         TEXT NOT NULL DEFAULT '',  -- trial expiry date, contact person, etc.
  updated_at   INTEGER NOT NULL DEFAULT 0
);
```

**There is only one semantic: an enabled record in this table means the user brings their own key and pays their own cost.** Whether to deduct credits is derived from it, with no separate field (§3.2).

### 2.3 What `tenant_id` should be

There is currently no tenant entity, so there are two options:

- **Use `username` directly**: fits trial scenarios where "one DramaClaw user = one customer"; the simplest, use this first;
- **Define a separate `tenant_id` and add ownership to users**: required when one customer has several DramaClaw users.

**Conclusion: start with `username` as the primary key, but name the table and fields `tenant_*`**, so that when a `user -> tenant` ownership mapping is added later, only the resolution function changes, not the table structure.

### 2.4 `enabled` is the switch for "whether to take the own-key path"

It decides which path the user takes, and the two paths are mutually exclusive:

```text
enabled = 1  ->  use the user's own relay key, no credit deduction (cost is the user's)
enabled = 0  ->  use the deployment-level key, deduct credits as usual (cost is the operator's)
no record    ->  same as above: deployment-level key + credit deduction
```

The switch is kept instead of relying only on deleting records so that **troubleshooting can temporarily switch back to the deployment-level key**: when the user's key is suspected to be faulty, switch to verify without deleting the record (deleting would require the user to provide the key again).

**But it is not a "deactivate customer" switch**; this must be stated clearly, or operations will certainly misuse it:

```text
Trial expires -> set enabled to 0 -> the user starts using the deployment-level key and is deducted credits
```

When their credits are 0 they are blocked normally, which is the expected behavior. But **if trial credits were given and a balance remains, they keep using it, spending the operator's money**.

So:

- **"Deactivating a customer" must rely on zeroing credits or a separate account-status mechanism**, not on this field;
- On the admin page, label this switch "**Use own key**", with a note when off: "will use the platform key and deduct credits". Do not write it as a generic "enable / disable".

### 2.5 Supporting interfaces

```python
save_tenant_relay_key(tenant_id, *, relay_key, tenant_name, note, enabled)
list_tenant_relay_keys()          # admin list, relay_key returned masked
get_tenant_relay_key(tenant_id)   # for internal resolution, returns plaintext
delete_tenant_relay_key(tenant_id)
```

Attach them to the existing admin routes in `api/routes/model_gateway.py`. **`list_*` must mask** (return only the last four characters); the admin list page has no reason to show the full key.

## 3. DramaClaw-side changes

### 3.1 Add a user dimension to `get_effective_newapi_config()`

Existing signature (`model_gateway_settings.py:499`):

```python
def get_effective_newapi_config(
    *,
    official_base_url: str | None = None,
    official_api_key: str | None = None,
) -> EffectiveNewApiConfig:
```

Change to:

```python
def get_effective_newapi_config(
    *,
    username: str | None = None,          # new
    official_base_url: str | None = None,
    official_api_key: str | None = None,
) -> EffectiveNewApiConfig:
```

Resolution order:

```text
(1) username non-empty AND tenant_relay_key hit AND enabled=1
     -> source="tenant", api_key = that user's own relay_key
(2) otherwise use the existing logic (custom / official / environment), completely unchanged
```

**When `username` is not passed, behavior is byte-for-byte identical to before the change**, so existing call sites do not all need to change and can pass it gradually as needed. This is the precondition for landing this item safely.

`EffectiveNewApiConfig.source` needs a new `"tenant"` value, which is also the basis for the credit decision in the next section.

### 3.2 Credit skipping must reuse the same query result

**Do not query `tenant_relay_key` in two places.** One place deciding which key to use and another deciding whether to deduct credits will sooner or later drift apart, and both directions are silent errors:

- Used their key but deducted credits -> the customer pays twice, everything looks normal with no error;
- Used the deployment-level key but did not deduct credits -> the operator gives it away for free, equally silent.

The correct approach: the credit logic reads `EffectiveNewApiConfig.source`; `source == "tenant"` means skip reservation and deduction, without querying the table again.

`InsufficientCreditsStop` in `src/novelvideo/shared/billing_errors.py` inherits from `BaseException` (the comment states this is to escape broad `except` clauses), so once raised it necessarily aborts the request. **A user who brings their own key must never reach the path that raises it.**

Complete behavior on the three paths:

| State | Which key | Credit reservation and deduction | When credits are insufficient | Usage accounting |
| --- | --- | --- | --- | --- |
| `enabled = 1` | Their own relay key | **Skipped** | Not applicable | **Recorded as usual** |
| `enabled = 0` | Deployment-level key | Normal | Blocked normally | Recorded as usual |
| No record | Deployment-level key | Normal | Blocked normally | Recorded as usual |

For the latter two, credit behavior is **byte-for-byte identical** to before the change, and `InsufficientCreditsStop` changes by zero lines: when credits are insufficient, they are simply insufficient and blocked normally, with no special handling.

**Note that "no credit deduction" does not mean "no accounting".** Only credit reservation and confirmation are skipped; not a single usage record is dropped. Reasons:

- The relay's logs go only down to the level of "one relay user". If one customer has multiple DramaClaw users, **only DramaClaw has per-person granularity**;
- When the customer wants to see "who inside our team used how much", this is the only data source;
- Accounting and billing are two different things; writing usage records does not trigger any charge.

#### Down to the function: which to skip and which not to

The `UsageMeter` protocol in `src/novelvideo/ports/usage.py` separates two things clearly. The change touches only the first group; the second group is always called as usual:

```text
Skip (credit side, not called when source == "tenant")
    reserve_current_model_call_credit
    refund_model_call_credit_reservation
    reserve_feature_start_credits
    require_feature_credit_balance
    confirm_feature_credit_reservation
    refund_feature_credit_reservation

As usual (usage side, called on every path)
    bump_model_call
    record_llm_tokens
    bump_content_counter
    log_resource_attempts
    set_llm_usage_context / set_project_llm_usage_context
    and the three usage dbs: video_request_usage.py / image_request_usage.py / audio_request_usage.py
```

This boundary is far more actionable than a description like "skip deduction": **skip the group with `reservation` semantics; leave the `bump_*` / `record_*` / `log_*` group untouched.**

##### This list is for the implementation layer; do not decide at each site in business code

The credit-side functions have a sizeable call surface in business code. Measured:

```text
reserve_current_model_call_credit       10 sites
refund_feature_credit_reservation       10 sites
refund_model_call_credit_reservation     9 sites
confirm_feature_credit_reservation       5 sites
reserve_feature_start_credits            2 sites
require_feature_credit_balance           1 site
                                   total 37 sites
```

**Adding `if source == "tenant"` at each of the 37 sites will inevitably miss some, and every miss is a silent billing error.**

The correct approach is a **single choke point**, with the 37 business-code sites changing by zero lines. The choke point has been identified; see below.

##### The choke point is EE's `EEUsageMeter` (confirmed)

First, clear up an easy mistake: **`src/novelvideo/ports/local/usage.py` in this repository is `NoOpUsageMeter`, and all its credit methods are no-ops**:

```python
class NoOpUsageMeter:
    async def reserve_current_model_call_credit(...) -> str:
        return ""
    async def refund_model_call_credit_reservation(...) -> None:
        return None
    async def reserve_feature_start_credits(...) -> dict:
        return {"id": "", "cost": 0, "reserved": False, ...}
```

**CE does not deduct credits at all**, so adding a check in this file is pointless. The real implementation is in EE:

```text
EE ports_bootstrap.py:170   class EEUsageMeter
EE ports_bootstrap.py:478   register_port("usage_meter", EEUsageMeter())
```

And `EEUsageMeter` is a **thin, purely forwarding shell**; the core credit logic is in `metrics_emit` and `credit_ledger`:

```python
class EEUsageMeter:
    async def reserve_current_model_call_credit(self, *, model, ...) -> str:
        return await metrics_emit.reserve_current_model_call_credit(...)      # forward

    async def reserve_feature_start_credits(self, *, user_id, ...) -> dict:
        return await credit_ledger.reserve_feature_start_credits(...)         # forward
```

**This thin shell is the ideal choke point**: add a check at the top of each of the 6 credit methods, and return an empty value instead of forwarding:

```python
async def reserve_current_model_call_credit(self, *, model, ...) -> str:
    if _current_request_is_byok():
        return ""            # return value shape copied from NoOpUsageMeter
    return await metrics_emit.reserve_current_model_call_credit(...)
```

The return value shapes are **copied from `NoOpUsageMeter`** (`""` / `None` / `{"id": "", "cost": 0, "reserved": False, ...}`), which is an existing no-op contract in this repository that CE has long validated by running; do not design your own.

Three conclusions follow:

- **`metrics_emit` / `credit_ledger` are not changed**; the core credit logic is not touched at all;
- **No proxy wrapper or port instance replacement is needed**; the usage-side methods (`bump_model_call` / `record_llm_tokens`, etc.) stay as they are, naturally satisfying "do not deduct but do record";
- **The 37 business-code sites change by zero lines**.

The actual EE-side workload is **adding 6 `if`s in one class**.

##### The BYOK flag travels in contextvars and is rebuilt on the task side (confirmed)

The method signatures of `EEUsageMeter` have no username, so the basis for the decision must travel in request-level context. The mechanism has been confirmed to work:

`src/novelvideo/llm_instrumentation.py` uses `contextvars.ContextVar`, and there are two ready precedents to copy:

```python
_USER_CTX: ContextVar[Optional[str]]                    # the user id is already in the context
_CREDIT_RESERVATION_STACK: ContextVar[tuple[str, ...]]
_AGENT_CREDIT_RESERVATION_ACTIVE: ContextVar[bool]      # a ready pattern for boolean flags
```

Add a `_BYOK_ACTIVE: ContextVar[bool]` and set it together in `set_llm_usage_context()`, which is already the central place that sets the various contextvars.

**The known pitfall of contextvars is that they do not propagate across threads or processes**, while generation tasks go through `task_backend`. This has been confirmed not to be a problem:

```python
# src/novelvideo/task_backend/run_core.py:196
get_usage_meter().set_llm_usage_context(
    billing_user_id,
    project_id=...,
    resource_kind=_resource_kind_for_task(task_type),
    billing_metadata={...},
)
```

**The task side calls `set_llm_usage_context` again at the start of the task**, so the context is rebuilt and does not rely on cross-thread propagation. As long as the BYOK flag is also set at this one place, the task path behaves the same as the request path.

This one place is the only spot that needs care during implementation: **the flag must be set at both `run_core.py:196` and the HTTP request entry; missing either means BYOK users on the corresponding path will be wrongly charged credits.** Acceptance must cover the synchronous request path and the background task path separately.

This way, deduction correctness depends only on "one predicate function + two set points", and tests only need to cover these three. **"Each side deducts its own" is guaranteed by the choke point, not by the discipline of 37 sites.**

#### `credit_reservation_id` is naturally a path marker

The signature of `bump_model_call` has a `credit_reservation_id` parameter:

```python
async def bump_model_call(
    self, *, user_id, model="", project_id=None, resource_kind="",
    provider_request_id="", provider_task_id="",
    credit_reservation_id="",          # <- has a value on the credit path, empty with own key
    metadata=None,
) -> None: ...
```

With their own key, **just pass an empty string; do not fabricate a fake reservation id**. Then whether this field is empty is naturally the marker for "did this call go through credits", and when looking at history there is no need to join `tenant_relay_key` or work out the configuration at that time: **configuration changes, history does not.**

#### Record differences between the two paths

| Record item | Credit path (`enabled=0` / no record) | Own key (`enabled=1`) |
| --- | --- | --- |
| Credit reserve / confirm / refund | Has `reservation_id`, traceable end to end | **Skipped** |
| `bump_model_call` | With `credit_reservation_id` | `credit_reservation_id` is empty |
| `record_llm_tokens` | Yes | Yes |
| `bump_content_counter` | Yes | Yes |
| `log_resource_attempts` | Yes | Yes |
| Three usage dbs | Yes | Yes |

**On the credit path every call has both a credit voucher and a usage record; with their own key only the credit-voucher half is missing.**

#### What each side records: usage in DramaClaw, cost in the relay

This split decides "where to look when there is a problem", and both operations and support need to know it:

| Question to answer | Where the answer is |
| --- | --- |
| Who, when, which model, how much volume | DramaClaw usage records (`bump_*` / `record_*` / three usage dbs) |
| How much this call cost, which channel it took | The relay's `Log` (`Quota` / `ChannelId` / `ChannelName` / `ModelName`) |
| How much quota a user with their own key has left | The relay (their own account's quota) |
| How many credits a credit-path user has left | DramaClaw |

So if a user with their own key asks "how much did I spend", **the answer is in the relay, not in DramaClaw**. DramaClaw only knows how much volume they used, not what that volume converts to in cost in their own account (the rate is decided by the relay's model pricing and may differ from the credit pricing we give ordinary users).

Conversely, "who in their team uses the most" can only be answered by DramaClaw, because the relay sees only one relay user. **Both sides are indispensable; do not try to complete the picture on one side.**

#### Equivalent credits are not stored separately

"How many credits this consumption is worth" can be computed from usage records plus pricing rules, so **do not redundantly store a derivable value**, and do not record a "deduct 0" ledger entry for users with their own key; that only causes confusion during reconciliation.

One upgrade path is noted here: if you later need to invoice such customers or use it for conversion-to-paid quotes, what is needed is the equivalent credits **at that time**, and pricing rules change. At that point add an `equivalent_credits` column to the usage db to store a snapshot, with no impact on any existing logic. **Do not add it now**, because there is no need to invoice such customers yet.

#### The frontend credit display must be handled

`api/routes/auth.py:60-74` returns `credit_balance` to the frontend. For a user with their own key this value is meaningless; if it still shows "this call consumed 100 credits" while the balance does not move, customers will certainly ask. Either hide the credit-related display, or label it "paid upstream by yourself, no credits counted".

**This one is easy to miss**: whoever changes the backend usually does not think of the frontend still showing a meaningless credit balance.

### 3.3 Upstream errors must be translated into readable messages

When the quota of the user's own relay account runs out, or their upstream channel is disabled, requests fail. DramaClaw does not need to know **why** there is no quota (that is a matter for the relay side and business), but it must translate the upstream error into plain language instead of throwing the raw error at the user. Otherwise the user sees a technical error and cannot tell whether their quota ran out or the system is faulty.

This is the only responsibility DramaClaw bears toward the upstream in this plan.

### 3.4 Bucket Agent singletons by key (the only structural obstacle; do it first)

**This item is not "be careful not to get it wrong"; it is "not changing it means not doing it".** The other items just need to be changed as described, but here the existing code structure itself conflicts with fetching the key per user.

The blocker is at `src/novelvideo/freezone/text_node.py:152`:

```python
def create_freezone_translation_agent() -> Agent:
    model = get_newapi_text_pydantic_model(       # <- the key is frozen into the model object at this step
        "FREEZONE_TRANSLATION_MODEL",
        FREEZONE_TRANSLATION_MODEL,
    )
    return Agent(model, ...)                      # <- the Agent holds this model


def get_freezone_translation_agent() -> Agent:
    global _translation_agent
    if _translation_agent is None:                # <- created only the first time
        _translation_agent = create_freezone_translation_agent()
    return _translation_agent                     # <- afterwards all users reuse the same one
```

`get_newapi_text_pydantic_model()` internally calls `get_effective_newapi_config()` to fetch the key and **puts it into the model object**; the Agent holds that model, so the key is frozen along with the Agent. Combined with `if is None`:

```text
User A (own key) first request -> creates the Agent, containing A's key
User B request                 -> singleton is not None -> reused directly -> uses A's key
```

**No matter how correct the key resolution logic is, requests to these three places are overridden by the key of whoever created the singleton first.** The failure signature is "silent + expensive + found only afterwards": the upstream returns normally and it only shows up during reconciliation.

Three places, same pattern:

| Location | Now | Change to |
| --- | --- | --- |
| `text_node.py:136` | `_translation_agent: Optional[Agent]` | `dict[str, Agent]` |
| `text_node.py:137` | `_story_script_agent: Optional[Agent]` | same as above |
| `global_video_optimizer.py:833` | `_global_video_optimizer: Optional[...]` | same as above |

How to change:

```python
_translation_agents: dict[str, Agent] = {}

def get_freezone_translation_agent(username: str | None = None) -> Agent:
    gateway = get_effective_newapi_config(username=username)
    bucket = _runtime_version(gateway.api_key, gateway.base_url)   # existing fingerprint function
    if bucket not in _translation_agents:
        _translation_agents[bucket] = create_freezone_translation_agent(username=username)
    return _translation_agents[bucket]
```

**Bucket by key fingerprint, not by username.** All users without BYOK share the deployment-level key and should share one Agent instance; bucketing by username would create one per user, Agent creation has a cost, and memory would be unbounded.

Keep using the existing fingerprint function:

```python
def _runtime_version(api_key: str, base_url: str) -> str:      # model_gateway_runtime.py
    material = f"{base_url}\n{api_key}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()[:16]
```

`global_video_optimizer` is slightly special: internally it **already has** a per-language dictionary (`self._agents[language]`, line 223), so either add an outer key-bucket layer, or fold the key into its cache key.

Requirements:

- The cache key must cover both `api_key` and `base_url`; using only one would cross accounts in custom gateway scenarios;
- `_clear_agent_singletons()` should accordingly clear the whole dictionary (or clear a specific bucket by fingerprint);
- Buckets need an upper limit and an eviction policy (LRU recommended), otherwise users toggling on and off would make it grow without bound.

**Cognee needs separate confirmation.** The comment of `_cognee_runtime_status()` states:

> Cognee is process-global and must be restarted after its active gateway changes.

Cognee is process-global and needs a restart when the gateway changes. **This item must first confirm whether it uses only the deployment-level key**; if so, write this boundary down in the docs and code comments; if not, Cognee's multi-key support is a separate work item and should not be mixed into this plan.

## 4. Relay-side configuration

### 4.1 Four steps for each user with their own key

All can be done through the admin API:

```text
(1) Create a relay user    Group = tel-<user>              <- quota pool + routing key
(2) Create a token         owned by that user, Group left empty   <- this is the relay_key given to the user
(3) Create an upstream channel
       Key      = the user's upstream key (e.g. telecom TokenHub key)
       BaseURL  = upstream endpoint
       Models   = fill in only the models that upstream really has   <- this field is "which models go through their own channel"
       Group    = tel-<user>
       Tag      = tel · tokenhub                 <- Tag is indexed, used for bulk statistics
       Priority = high
(4) Settings
       available-group mapping   add { tel-<user>: [tel-<user>, default] }
       global AutoGroups list    add tel-<user> (keep default at the end)
```

The `tel-` prefix is only a naming convention (indicating the upstream source is telecom); the relay does not recognize it. When other upstream sources are added later, the prefix distinguishes them immediately, making troubleshooting and statistics easier.

### 4.2 Use the `auto` group; do not append the shared channel to user groups

`Channel.Group` at `model/channel.go:40` is **`varchar(64)`**, comma-separated, holding only three to five group names. **It will certainly overflow as users grow**, so do not take the path of "append every user group to the shared channel".

The correct approach is `token.Group = "auto"`, relying on the in-order iteration at `service/channel_select.go:84`:

```go
autoGroups := GetUserAutoGroup(userGroup)   // global AutoGroups ∩ the user's available groups
for i := startGroupIndex; i < len(autoGroups); i++ {
    channel, _ = model.GetRandomSatisfiedChannelWithExcludedTypes(autoGroup, param.ModelName, ...)
    if channel == nil { continue }          // this group has no such model -> try the next group
```

Effect: **look in their own `tel-` group first; models their upstream has hit their own channel, and the rest automatically fall to the shared channel in `default`.** The shared channel belongs only to the single group `default` and is never touched.

User groups appear only in the **settings** (available-group mapping + AutoGroups list), which are JSON and not subject to the 64-character limit.

**Use this from the start.** Changing it after an overflow requires recomputing the available-group configuration of all existing users, which is much more troublesome than using it from the beginning.

### 4.3 Never use multi-key mode to hold several users' keys

`ChannelInfo.IsMultiKey` / `MultiKeyPollingIndex` in `model/channel.go` allow one channel to hold several keys, which looks like it saves the work of creating several channels. **But it is round-robin:**

```go
channel.ChannelInfo.MultiKeyPollingIndex = (idx + 1) % len(keys)
```

Using it to hold different users' keys means **user A's requests randomly pay with user B's key**. This is a billing disaster, and since the upstream returns success it is hard to notice; it only blows up when the customer reconciles.

**One channel per user is mandatory.** This must be written into the operations documentation.

### 4.4 Customer keys are stored in plaintext; cover it with access control

`Channel.Key` is **stored in plaintext in the relay database and is not masked when returned** (no encrypt / mask logic can be found in the code). What was stored before was our own key; now it is **the customer's credential**, so a leak changes from an internal incident to a liability incident toward the customer.

At minimum:

- Tighten access to the relay database and back office; tier administrators (`model/authz_role.go` has a role mechanism), and do not make every operator a super admin;
- **Database backups are also plaintext**, so where backups are stored and who accesses them must be controlled too;
- State the key custody responsibility in the contract.

**Encrypted storage is not recommended now**: changing the read/write path of `Channel.Key` would touch multi-key mode, channel tests, and caches in several places, and this repository is a fork that must be re-merged on every upgrade. If a customer does not accept their key sharing a database with others, that is exactly the **trigger for dedicated deployment**, to be solved by deployment isolation rather than by changing to encryption.

## 5. Permission boundary: who can configure, who can change

Three things, three permission levels; they must be kept strictly separate:

| Configuration item | We pre-configure | User can change | Reason |
| --- | --- | --- | --- |
| **Relay key (`relay_key`)** | Yes | No; they should not even see the full value | This is the user's credential on the relay; with it they can bypass DramaClaw and call the relay directly, making local accounting, limits, and auditing all ineffective |
| **Upstream key (e.g. telecom TokenHub key)** | Yes, filled in for them | Yes, can be opened up | It is their own credential; letting them fill it in also avoids the key traveling through IM / email |
| **`enabled` switch** | Yes | No | It decides who bears the cost (§2.4); it is our operations and business action |

**Users must not be given relay back-office access.** Channel management is instance-level, so they would see and possibly modify other users' channels. If self-service entry of the upstream key is to be opened up, the boundary must be: the user fills in the key in the DramaClaw UI, the backend holds the relay admin credential and **operates only on their own single channel**, and immediately calls `TestChannel` (`controller/channel-test.go:828`) to validate and echo the result. The user never touches the relay at any point.

The self-service entry is not scheduled for now, for the reasons in §8.

## 6. Explicitly not doing

- **Do not add a separate field like `billing_mode`.** "Whether they configured their own key" itself decides whether to deduct credits, and both are driven by the same fact (§3.2). A separate field would introduce the trap of "configured a key but forgot to change the mode -> double charging with no error";
- **Do not scatter checks across generation paths.** Key resolution and credit skipping reach a conclusion in only one place (`EffectiveNewApiConfig.source`); missing one place is a silent double charge or giveaway;
- **Do not store the upstream key in DramaClaw.** It exists only in the relay's channel, so the credential is stored in one place and rotated in one place;
- **Do not hand the relay key to users.** See §5;
- **Do not give users relay back-office access.** Channel management is instance-level;
- **Do not change the relay's routing code.** `Ability(Group, Model, ChannelId)` is natively sufficient, and traffic splitting relies on the channel's `Models` field declaration;
- **Do not append the shared channel to every user group** (`varchar(64)` would overflow; use `auto`, see §4.2);
- **Do not use multi-key mode to hold multiple users** (round-robin would cross accounts, see §4.3);
- **Do not do encrypted storage in the relay** (high fork-merge cost; solve with access control and dedicated deployment, see §4.4);
- **Do not make DramaClaw care where the upstream money comes from.** Whether the quota of the user's relay account is topped up by themselves, by us on their behalf, or bound to their upstream channel is a matter for the relay side and business;
- **Do not create user-level keys for "per-person accounting inside one tenant".** The correct approach is to create multiple tokens under the same relay user sharing one quota pool, where `Log.TokenName` naturally splits the accounts, with no need to create more channels and groups.

## 7. Phasing and acceptance

### 7.1 Phasing

| Phase | Content | Trigger |
| --- | --- | --- |
| 1 | §3.4 Agent singleton bucketing (including the Cognee boundary confirmation) | Immediately, independent of the other items; shared by CE/EE, under CE there is only one bucket and behavior is unchanged |
| 2 | §2 table + §3.1 resolution change + §3.2 credit skipping + §3.3 error translation; manually configure the first two users on the relay side | The first customer with their own key |
| 3 | §4.1 provisioning automation (four-step API); fallback attribution dashboard (§7.3) | Monthly provisioning exceeds 5, or a customer asks for self-service key rotation |

### 7.2 Acceptance

Acceptance is split by repository, and **the two deduction-related items can only be verified in the EE repository** (§0.3):

| Acceptance item | Which repository runs it |
| --- | --- |
| With no `tenant_relay_key` records, behavior is the same as before the change | dramaclaw (the only required regression for CE) |
| Two concurrent users each use their own key | dramaclaw |
| Key resolution is correct after the `enabled` switch is toggled | dramaclaw |
| Usage records are complete and `credit_reservation_id` is empty | dramaclaw |
| BYOK users are not deducted credits | **SuperTale_main** (`tests/ports/test_usage_meter.py`) |
| Non-BYOK users are deducted credits exactly as before the change | **SuperTale_main** (same as above) |

Specific items:

- When `username` is not passed, the output of `get_effective_newapi_config()` is byte-for-byte identical to before the change (regression);
- Two users start text generation concurrently, and **the api_key each actually uses matches its configuration**. This is the core of §3.4, and concurrency must be tested; testing only that "the correct key can be fetched" is not enough;
- A user who configured their own key: the request uses their key, **and credits are not deducted**, but `bump_model_call` / `record_llm_tokens` / the three usage dbs **still have complete records**, with `credit_reservation_id` empty (§3.2);
- **Verify no credit deduction separately on the synchronous request path and the background task path.** The BYOK flag has two set points (the HTTP entry and `task_backend/run_core.py:196`); missing either means users on that path will be wrongly charged (§3.2);
- A user without configuration: the request uses the deployment-level key, **and credits are deducted and blocked normally** (regression);
- After `enabled = 0` the user switches back to the deployment-level key and **credit deduction resumes** (the semantics of §2.4);
- Models listed in the `Models` of their upstream channel land on their own channel; models not listed land on the `default` shared channel;
- When their relay quota is exhausted, the frontend gives a readable message instead of the raw upstream error (§3.3);
- `relay_key` is shown masked on the admin list page.

### 7.3 Fallback attribution (owned by operations, but recommended early)

When a user configures their own key, models their upstream lacks fall to our shared channel; **that portion is our cost**.

`Log` in `model/log.go` already has `UserId` / `ChannelId` / `ChannelName` / `Group` / `ModelName` / `TokenName` / `Quota` together, and `Channel.UsedQuota` also accumulates per channel. **No code change is needed**; a single query can split out three numbers per user: "total consumption / through their own channel / fell back to the shared channel".

After tagging with the `Tag` convention in §4.1, "consumption of all own-key channels" is also one query. **Get the Tag right from the first channel**; after dozens of channels it cannot be unified retroactively.

An alert that must exist: `AutoBan` automatically disables channels that fail consecutively. When a user's upstream key expires or its quota runs out, **as soon as the channel is disabled, all their requests fall to the shared channel and we pay**, while they are not deducted credits, and no mechanism can stop it. Therefore:

- **Alert immediately** when a user's upstream channel is disabled;
- Alert when a single user's fallback consumption exceeds a threshold;
- Define the policy explicitly: whether to keep paying for them or block directly. **Blocking is recommended by default**; paying on a customer's behalf should be an explicit decision, not a system default.

## 8. Open items

**User self-service entry of the upstream key vs. us filling it in** -- in the initial phase we fill it in; this plan does not draw a conclusion.

Reasons not to build a self-service entry too early: it is not yet clear whether customers want to operate it themselves (some enterprise customers prefer us to manage it), what the upstream key actually looks like (whether it comes with a secret, whether endpoints differ between vendors), and whether a customer will provide multiple keys (different quota pools or model plans). Building the entry before these are understood will most likely need a redo.

After filling in for two or three customers the shape will be clear. If an entry is built then, see §5 for the boundary.

**One edge scenario, not done now but noted**: if there later appears the case "we configure a separate relay key of **our own** for a particular user" (e.g. VIP isolation of quota and rate limits, but the cost is still ours), then "a record exists in the table" no longer equals "they pay themselves", and a boolean is needed to distinguish. **Do not add it now**, because that scenario does not exist; if it really appears, adding a `deduct_credits` boolean is enough and does not affect the table structure.

## 9. When to switch to a dedicated deployment

Dedicated deployment for large customers is already the established strategy. This section only records the criteria, to avoid misjudgment.

Dedicated deployment should be decided by trigger conditions; if any one occurs, it should be dedicated, regardless of the spend amount:

1. **Compliance**: the customer requires that data or credentials not share an instance or database with other customers;
2. **Concurrency interference**: the user's traffic peaks affect other users;
3. **Self-service management**: the customer requires managing channels and credentials themselves (the relay back office is instance-level and cannot expose only a part);
4. **Configuration divergence**: the model list or routing needs differ so much that the group mechanism cannot express them.

Include the hidden cost: this repository is a fork with custom commits already (Huimeng routing, billing changes, etc.). **Every additional dedicated deployment multiplies the merge and verification cost of later upgrades once more**, which is usually more worth calculating first than server fees.
