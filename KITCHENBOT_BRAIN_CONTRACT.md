# KitchenBot Brain Contract

## Purpose

This document defines what KitchenBot is, how its brain is supposed to work, and what architectural behaviors are allowed or forbidden.

It is the product/runtime contract for KitchenBot itself.

Unlike `AGENTS.md`, which is an implementation charter for coding agents, this document defines the intended shape of the KitchenBot runtime.

If the code and this document disagree, the code should be considered architecturally suspect until proven otherwise.

---

## What KitchenBot Is

KitchenBot is a household agent with one brain.

It is not:
- a generic chatbot with some command handlers
- a collection of product lanes
- a UI shell around hidden deterministic workflows

KitchenBot is:
- a single agent that reads a turn
- understands the relevant household context
- decides what to do
- does it if needed
- responds naturally

Its intelligence should feel unified to the user, even when it uses explicit app features under the hood.

---

## Core Runtime Loop

KitchenBot’s runtime must follow this loop:

1. Read the user message
2. Identify the relevant entities for the turn
3. Select the relevant context for the turn
4. Retrieve the most relevant memory and live state for those entities and needs
5. Decide whether to:
   - `reply_only`
   - `execute_action`
   - `clarify`
6. If `execute_action`, execute one or more allowed skill actions on the server
7. Respond in natural language
8. Optionally persist one lightweight next-step object for bounded follow-up turns

This loop is the center of gravity of the product.

Anything that bypasses this loop is suspect.

“Agent reasons” includes deciding what context matters for the turn, not just deciding the final action.

---

## Smart Brain, Dumb Executors (the executor contract)

The brain does the deciding. Executors do the doing. This is the single most important
structural rule in KitchenBot, and most architectural debt is a violation of it.

**The brain (the agent loop) owns every DECISION**, including:
- what to do, and in what order
- which items to add / remove / change, and their quantities
- which section or category something belongs in
- whether a memory is about a person or the household, and who
- whether a turn is a refinement, a fresh plan, or a question
- what the user's "this" / "that" refers to
- which pantry staples are already on hand and should be excluded from a shopping list

**Executors (tools) are MECHANICAL.** An executor receives explicit, already-decided inputs
from the brain and mutates state. It must NOT:
- call a model to decide what to do, what items to derive, or how to classify
- re-read the chat transcript to reconstruct intent or re-plan
- run regex / heuristics that *select an action* or *infer intent*

**The only side-model calls allowed** are pure *parse / shape / structure* helpers that
transform already-given data without choosing an action: titling a chat, OCR, structuring a
recipe from external page/image text, fetching a URL. These convert data; they do not decide.
Deterministic transforms (name normalization, dedup, or a cheap section-guess FALLBACK for
when the brain declined to specify one) are fine — as a fallback, never as the primary decider.

**Why this rule exists:** the executors were built intelligent to compensate for the OLD
deterministic router, which only picked one capability and handed over a thin input — so each
executor had to re-read the chat, re-plan, classify, and derive on its own. The v3 loop replaced
that router with a real brain but left the executors smart. Any remaining executor intelligence
is now a SECOND brain competing with the first — the direct cause of "it can't actually do X,"
"it re-did the wrong thing," and silent, uncontrollable behavior. One brain, or it isn't KitchenBot.

**The test for any executor:** if you removed its ability to call a model or read the transcript,
could the brain still reach the same outcome by passing richer inputs? If yes, that intelligence
belongs in the brain, not the executor — move it.

---

## Core Cognition

The following are part of KitchenBot’s brain and must be treated as global cognition, not as skills:

- understanding who is speaking
- identifying which people or entities are relevant to the turn
- deciding whether household memory or person-specific memory applies
- deciding which context families are relevant to the turn
- retrieving relevant memory and live context
- deciding whether the user wants conversation, clarification, or an action
- deciding whether an app-state mutation is appropriate
- applying tone, personality, and preference constraints to replies and planning
- deciding which background resources are relevant to the current turn

These behaviors should be available to all replies and all skills.

They should not be implemented as optional tools the model may or may not remember to call.

---

## Context Model

KitchenBot reasons over three broad kinds of context:

### Durable Memory

Durable memory includes household and person-specific memory saved over time.

Examples:
- person preferences
- household notes
- stable household operating assumptions that belong in memory

Writing durable memory is a skill.

Reading durable memory is part of core cognition.

### Live App State

Live app state is current structured household state that KitchenBot may read when relevant.

Examples:
- Pantry
- Grocery List
- household defaults
- app structure / navigation context
- local-time context for the current turn

These are valid background context sources when selectively relevant.

They are not durable memory.

They should not be injected into every prompt by default.

### Short-Term Chat Working Context

Working context is lightweight, per-chat short-term continuity.

Examples:
- current meal ideas under discussion
- active meal refinements in this chat
- grocery focus for referential follow-ups like “for this”

Working context is allowed when it is:
- short-term
- selective
- bounded
- not a visible workflow artifact
- not mutating app state by itself

Working context is not a privileged planning lane.

---

## Memory Contract

KitchenBot must be able to both write and read memory correctly.

### Writing Memory

Writing memory is a skill.

KitchenBot may save, update, or delete memory only through explicit server-side skill execution.

### Reading Memory

Reading memory is part of core cognition.

KitchenBot should automatically retrieve relevant memory when reasoning about a turn, without requiring the user to explicitly ask for it.

### Retrieval Rules

Memory and context retrieval must be:
- selective
- relevant
- token-budgeted
- upstream of both reply generation and skill selection/execution

KitchenBot must not:
- dump all memory into every prompt
- dump pantry, grocery, defaults, or working context into every prompt by default
- require an explicit “use memory” instruction to benefit from relevant memory
- treat “read memory” as a skill
- let memory or live context become an always-on blob that dominates every turn

### Memory Scope

KitchenBot must distinguish between:
- household memory
- person-specific memory
- future entity-specific memory

It must apply the right scope by default.

---

## Skills

A skill is an explicit app-facing ability that KitchenBot can use.

A skill may:
- mutate app state
- read or transform structured app data
- ask for a bounded follow-up via a generic next-step object
- shape how its results are explained to the user
- declare explicit context requirements

Examples of current skills:
- save memory
- generate a grocery preview
- commit grocery list changes
- add Pantry items
- move Pantry items to Grocery List
- move Grocery List items to Pantry
- update household defaults
- refine the current meal thread
- explain capabilities / help

A skill is for doing.

The brain is for understanding.

---

## Skill Contract

Every skill should define, directly or through a registry-owned interface:

- `id`
- human-facing description / capability description
- when it may be exposed to classification
- input schema / normalization rules
- executor
- optional feature-specific follow-up interpreter
- optional next-step schema
- optional outcome-to-reply formatter
- optional explicit context requirements

A new feature should be addable by defining a new skill and registering it.

If a new feature requires adding feature-specific logic to the core runtime, the architecture is regressing.

---

## Entities

KitchenBot reasons over entities.

At minimum, the system must support:
- `household`
- `person`

Future entity types may be added, but only if they fit the same model:
- explicit identity
- explicit memory/context
- clear role in reasoning

The active speaker is always a relevant entity candidate.

Explicitly mentioned people are also relevant entity candidates.

Household context is globally available when relevant, but should not dominate every turn by default.

---

## Stored Artifacts

Stored artifacts are server-owned background resources.

Examples:
- grocery previews
- summary objects
- next-step state
- thread-scoped working context

These artifacts are allowed to support reasoning and execution.

They are not allowed to become first-class instructions.

A stored artifact may inform the brain only when it is relevant to the current turn.

If an artifact starts steering normal conversation by default, that is a bug.

Allowed:
- bounded next-step state
- selective short-term working context
- thread-scoped derived context that helps with follow-up continuity

Forbidden:
- always-on artifact injection
- hidden product lanes
- artifact-driven ordinary conversation by default

---

## App-State Mutation Rules

KitchenBot may only change app state through explicit skill execution.

This means:
- plain conversational replies do not mutate state
- post-reply background writes are forbidden
- previews are not commits
- silent artifact mutation is forbidden
- if something changed in the app, the change should be attributable to an executed skill

Next-step state is allowed, but it must be:
- lightweight
- generic
- bounded
- clearly tied to an already-executed or already-selected action path

---

## Natural Language Behavior

KitchenBot should feel like one coherent agent.

Magic means:
- it uses relevant memory when it matters
- it uses relevant live app state when it matters
- it recognizes who the turn is about
- it knows when to act and when to simply help
- it makes app features feel like extensions of one brain
- it stays truthful while still feeling smooth and natural

Magic does not mean:
- hidden state changes
- fake certainty
- invisible product lanes
- background artifacts steering everything
- pretending actions happened when they did not

If a behavior would feel impressive but relies on deception or hidden mutation, do not do it.

---

## Help And Capability Explanation

When KitchenBot explains what it can do, that explanation should reflect real available skills.

Help must not become a manually maintained fiction that drifts away from actual capabilities.

The system should prefer deriving capability explanations from the current skill set and its metadata.

---

## Prohibited Architectural Behaviors

The following are forbidden in the KitchenBot runtime:

- pending headers as primary behavior
- checkpoint-driven flow
- command-lane architecture
- browser-owned pending state
- compat or shared-command plumbing as a primary path
- post-reply background writes
- silent artifact mutation after a plain reply
- hidden state changes that are not attributable to executed skills
- feature-specific planning logic in core turn policy
- feature-specific orchestration in core action execution
- broad always-on pantry/grocery/defaults/context injection into every prompt
- turning working context into a hidden planning subsystem
- letting deterministic logic become the effective brain

Selective context planning is allowed.

Always-on context blobs are not.

---

## Smell Test

If a feature starts behaving like a privileged lane, treat that as an anti-magic smell.

Examples of bad smells:
- memory only being used when explicitly requested instead of automatically when relevant
- pantry, grocery, or defaults being dumped into every prompt whether needed or not
- help text being hand-maintained instead of reflecting actual skills
- grocery behavior hardcoded into the brain instead of expressed as skill behavior
- working context becoming a hidden planning product rather than bounded chat continuity
- deterministic parsing becoming the main brain instead of temporary scaffolding

If a feature needs special treatment, ask:
- is this core cognition?
- or is this skill-specific behavior?

If it is neither, it is probably accidental architecture and should be removed.
