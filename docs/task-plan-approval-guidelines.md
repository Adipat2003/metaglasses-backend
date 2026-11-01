# Task-plan approval guidelines

This rubric is used only when the authenticated user requests approval of a task plan. It is
separate from the plan review used to interpret instructions and help the user refine a draft.
Approval reviews the exact current version and must run again after every refinement.

## Approval checks

The reviewer assesses each category as `true` or `false` and provides a concise, actionable
blocker for every failed category.

### Clarity

- Each step describes one action in language that can be understood without guessing.
- The steps do not conflict with each other or the user's stated goal.
- Ambiguity that could change the action or its outcome is unresolved only when the user has
  supplied the missing information.

### Completeness

- The supplied steps contain enough information to carry out the user's requested task.
- Any missing choice that materially changes the task is raised as a clarification question.
- The reviewer does not invent facts, tools, prerequisites, or extra operational steps to fill gaps.

### Visual observability

- Every step has at least one concrete visual acceptance criterion.
- The criterion describes evidence that can be judged from the supported camera input.
- Completion must not depend only on hidden state, elapsed time, or an unsupported assumption.

### Safety

- Hazards, irreversible actions, and high-consequence actions are identified.
- A high-risk step must set `requiresUserConfirmation` to `true`.
- Unresolved safety concerns or unsafe actions block approval.
- A documented risk may remain when it is adequately mitigated and the required confirmation is
  explicit.

### Grounding and questions

- Unsupported claims block approval until removed or resolved.
- Any unresolved clarification question blocks approval.
- The reviewer distinguishes evidence in the plan from assumptions about the user's environment.

## Backend enforcement

The model cannot approve a plan. The API validates the review schema and derives
`approvalReady`; it does not trust a model-supplied readiness flag. Approval is blocked if any
guideline fails, a clarification remains open, a step has no visual acceptance criteria, an
unsupported claim remains, or a high-risk step lacks explicit confirmation.

The database saves the review and changes the plan to `approved` in one transaction only when:

- the reviewed version is still the current version;
- the plan remains eligible for approval and has no task run;
- all four guideline checks pass;
- there are no approval blockers, unsupported claims, or clarification questions.

If the review fails, the database saves it on the current version and leaves the plan editable as a
draft. The API returns `409 task_plan_guidelines_failed`. A `GET /v1/task-plans/{taskPlanId}`
response exposes `validation.guidelineChecks` and `validation.approvalBlockers`. The user can
refine the plan and request approval again.

## Review sequence

```text
Create plan
  -> optionally refine with natural language
  -> optionally call /validate for a plan-quality preview
  -> call /approve
  -> strict approval review of current version
       -> blockers: save review, leave draft editable, refine and retry
       -> passes: save review and approve that exact version
  -> create task run from approved version
```

The implementation prompt and deterministic checks live in
`supabase/functions/api/task_plan.ts`. Update the prompt, this rubric, and the automated tests
together when changing approval criteria.
