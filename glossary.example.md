# Glossary

Write here what the words of your business mean in your database. The app gives this file to the model with every
question. Ten good entries change the answers more than any other setting. Copy this file to `glossary.md`.

One entry per term, in plain words, with the table and column that hold it:

- **<Term people say>** (also "<short form>"): <what it means>, found in `<table>.<column>` = <values>. <What it does
  NOT include, when people often get that wrong.>

Things worth an entry:

- The main measures: what counts as revenue, spend, an order, an active customer. Which rows are left out
  (cancelled, test, internal, pending).
- Groupings that people name: "Travel and Events", "Enterprise customers", "EMEA". Which values belong to each.
- Time: when the fiscal year starts, what "this year" should be compared with, which date column is the one to use.
- Names that differ between people and the database: a "cost centre" that the tables call `department`.
- Currency and units of the amount columns.
- Traps: a table that is no longer filled, a column that changed meaning, duplicates that must be removed.
