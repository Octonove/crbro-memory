# Team memory

Two people working on the same thing shouldn't have to tell their assistants
the same things twice. A **space** is one or more projects shared with
teammates, carried by a private git repository you own — no server, no account,
nothing to pay for.

```bash
# One person, once:
crbro_space  action: create   name: "team"   remote: git@github.com:acme/team-memory.git   author: "ana"
crbro_share  neuron: "project_x"   space: "team"

# Everyone else, once:
crbro_space  action: join     name: "team"   remote: git@github.com:acme/team-memory.git   author: "bruno"
```

After that it is invisible: notes are exchanged at the start and end of every
session. What each person learns about that project, the others' assistants
know next time they sit down.

**How it stays out of your way**

- Nobody ever writes to anybody else's file. Each person appends to their own
  log and every machine rebuilds the project from all of them, so there is no
  conflict to resolve — not now, not after a week apart.
- If someone marks a fact as no longer true, that wins. Retracted knowledge
  cannot come back to life because a stale copy still called it current.
- A teammate who checks a shared fact against its source restarts everyone's
  shelf-life clock on it: the latest check wins. An explicit `shelf_life`
  travels too, and the most volatile one wins — a needless warning costs one
  check, a missing one a wrong answer — so a shared fact's shelf life can be
  shortened but not lengthened: the next sync restores the more volatile
  value from the log, and `crbro_learn` says so in `shared_warning`. A check
  dated more than a day in the future (a clock that is ahead) counts as no
  check. A teammate on an older CRBRO simply does not receive the checks.
- No connection is a normal answer, not an error. Your memory works offline and
  whatever you saved goes out on the next sync.

**What team sync excludes**

- Every project you did not explicitly share.
- Preferences — not shareable at all, at any setting. They are the field most
  likely to hold a key.
- Recognized credentials. `crbro_share` refuses outright if it finds one,
  and tells you where. The filter cannot recognize every possible secret;
  keep credential values in the separate OS keychain, never in shared notes.

These are team-sync exclusions, not guarantees about your AI client's data
flows or a cloud-synced folder you choose for the brain.

> **What was sent stays sent.** `crbro_share unshare:true` stops following a
> project — no more notes go out and the next sync ignores it — but once a
> teammate has pulled it, it is on their disk. Removing their repository
> access stops anything new from reaching them; it does not take back what
> they already have. That is true of any sync system — worth knowing before
> you share, not after.
