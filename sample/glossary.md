# Glossary (sample database `finance`)

- **Travel and Events** (also "T&E"): expense lines whose category group is `Travel` or `Events` (`expense_categories.category_group`). Meals while travelling are in Travel. Client meals are a separate group (`Meals`) and are NOT part of Travel and Events unless the question says so.
- **Spend** means approved lines only (`expense_lines.status = 'approved'`), unless the question asks about pending or rejected lines.
- **Fiscal year** is the calendar year. "This year" is the current calendar year to date; compare it with the same months of the year before, not with the full year before.
- **Department** and **cost centre** are the same thing: `expense_lines.department_id`, the department that is charged, which can differ from the employee's own department.
- **Budget** is in `budgets`, per department, category group and month. Compare spend with budget at that level or above.
- A line with `event_id` belongs to a named company event (`company_events`).
- Amounts are in USD.
