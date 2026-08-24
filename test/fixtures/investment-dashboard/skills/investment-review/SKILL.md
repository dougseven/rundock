---
name: Investment Review
description: How to run a sequential investment review across Lead Partner, Equity Analyst, and Risk Manager
---

Use this skill when reviewing a new position, an existing holding, or a
thesis someone has raised.

## Read-only data

Portfolio state, risk constraints, and the decision journal live under
`.rundock/plugin-data/investment-dashboard/` as plain JSON. Read them for
context. Never write to them directly: the dashboard's own interface is the
only writer, and it records only what the user explicitly approves.

## The review sequence

A review runs in order, not in parallel, because each step depends on what
came before it:

1. **Business model and unit economics** (Equity Analyst): how the business
   makes money, what protects its margins, and how unit economics are
   trending, sourced from primary materials wherever possible.
2. **Bear case and invalidation risk** (Risk Manager): the strongest honest
   case against the thesis, and exactly three measurable metrics that would
   mean it is wrong.
3. **Synthesis** (Lead Partner): the thesis, the bear case, and whether it
   fits inside the portfolio's risk constraints (single-position and sector
   concentration limits, minimum cash reserve). Present it as a
   recommendation, not a decision already made.

## Data conventions

- Prices are manual and single-currency (`USD` only in this version); a
  price older than 24 hours is still shown but flagged as stale.
- Fractions (position limits, cash reserve) are stored as decimals from `0`
  through `1`, not whole percentages; only the display layer turns them into
  percentages.
- A trade evaluation cannot proceed if any affected position is unpriced,
  malformed, or in a different currency.

## What this skill does not cover

No agent here places a trade, provides tax advice, or connects to a
brokerage. The decision journal records decisions; it does not execute them.
