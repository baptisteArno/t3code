# Agents in this fork

This checkout is a personal fork; [README.md](README.md) says how a change lands.

- When the user says commit, land, ship, merge or deploy, a change is done only once it is on
  `origin/custom-nightly`. Those words are the ask to push. Commit, fold or add it as
  [Adding a change](README.md#adding-a-change) says, run `vp run check:changed <upstream tag>`, and
  push with the lease, without asking again. A commit left on a `t3/*` branch is unfinished work.
- Report the commit as it stands on `custom-nightly`, and say the build carrying it comes with the
  next 06:00 run or `fork/nightly.sh --next`, started from a T3 Code thread on the Macbook.
