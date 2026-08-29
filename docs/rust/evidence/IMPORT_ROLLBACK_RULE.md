# Import rollback rule

Source import is additive to an isolated development branch. A failed or superseded import is rolled back by abandoning that branch or reverting its exact import commit; it must never mutate main or production activation truth directly.
