"""Build the sample database `finance`: two fiscal years of made-up company expenses. No real data.

usage: CANVAS_SAMPLE_ROOT_PASSWORD=... CANVAS_DB_PASSWORD=... python sample/load_sample.py --host H --port P
It creates the tables, fills them (same rows every time: fixed seed) and creates the read-only user `canvas_ro`.
"""
import argparse
import datetime as dt
import os
import random

import pymysql

DEPARTMENTS = [("Sales", "Commercial"), ("Marketing", "Commercial"), ("Engineering", "Product"), ("Product", "Product"),
               ("Finance", "Corporate"), ("People", "Corporate"), ("Customer Success", "Commercial"), ("Executive", "Corporate")]
CATEGORIES = [  # name, group, gl account, typical amount, weight per department kind
    ("Airfare", "Travel", "6410", 520), ("Hotel", "Travel", "6420", 310), ("Ground transport", "Travel", "6430", 48),
    ("Meals while travelling", "Travel", "6440", 62), ("Conference fees", "Events", "6510", 1450), ("Client events", "Events", "6520", 2300),
    ("Team offsites", "Events", "6530", 3800), ("Trade show booth", "Events", "6540", 9200), ("Software subscriptions", "Software", "6610", 240),
    ("Office supplies", "Office", "6710", 55), ("Training", "People", "6810", 680), ("Client meals", "Meals", "6450", 140)]
VENDORS = {"Airfare": ["Delta", "United", "American Airlines", "JetBlue", "LATAM"], "Hotel": ["Marriott", "Hilton", "Hyatt", "Airbnb"],
           "Ground transport": ["Uber", "Lyft", "Hertz", "Amtrak"], "Meals while travelling": ["Restaurant", "Airport cafe", "Hotel restaurant"],
           "Conference fees": ["SaaStr", "Dreamforce", "AWS re:Invent", "Web Summit"], "Client events": ["Convene", "Private dining", "Stadium suite"],
           "Team offsites": ["Convene", "Mountain lodge", "WeWork events"], "Trade show booth": ["Freeman", "GES"],
           "Software subscriptions": ["Figma", "Notion", "Atlassian", "Zoom"], "Office supplies": ["Staples", "Amazon Business"],
           "Training": ["Coursera", "Reforge", "O'Reilly"], "Client meals": ["Restaurant", "Steakhouse", "Catering"]}
MIX = {"Sales": {"Travel": 5, "Events": 3, "Meals": 4, "Software": 1}, "Marketing": {"Events": 6, "Travel": 2, "Software": 2},
       "Engineering": {"Software": 5, "People": 2, "Travel": 1, "Events": 1}, "Product": {"Software": 3, "Travel": 1.5, "Events": 1, "People": 1},
       "Finance": {"Software": 2, "Office": 2, "Travel": 0.5}, "People": {"People": 4, "Events": 2, "Office": 1},
       "Customer Success": {"Travel": 4, "Meals": 2, "Software": 1}, "Executive": {"Travel": 3, "Events": 2, "Meals": 2}}
EVENTS = [("Sales Kickoff 2025", "2025-01-20", "Sales"), ("Annual User Conference 2025", "2025-06-10", "Marketing"), ("Fall Trade Show 2025", "2025-10-06", "Marketing"),
          ("Sales Kickoff 2026", "2026-01-19", "Sales"), ("Annual User Conference 2026", "2026-06-09", "Marketing"), ("Fall Trade Show 2026", "2026-10-05", "Marketing")]
DDL = """
CREATE TABLE departments (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(60) NOT NULL, division VARCHAR(40) NOT NULL COMMENT 'Commercial, Product or Corporate') COMMENT='Cost centres';
CREATE TABLE employees (id INT PRIMARY KEY AUTO_INCREMENT, full_name VARCHAR(80) NOT NULL, department_id INT NOT NULL, title VARCHAR(60), FOREIGN KEY (department_id) REFERENCES departments (id)) COMMENT='People who file expenses (made-up names)';
CREATE TABLE expense_categories (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(60) NOT NULL, category_group VARCHAR(30) NOT NULL COMMENT 'Travel, Events, Meals, Software, Office or People', gl_account CHAR(4) NOT NULL COMMENT 'General ledger account') COMMENT='Expense categories and the group and ledger account of each';
CREATE TABLE company_events (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(80) NOT NULL, starts_on DATE NOT NULL, owner_department_id INT NOT NULL, FOREIGN KEY (owner_department_id) REFERENCES departments (id)) COMMENT='Named company events; an expense line can belong to one';
CREATE TABLE expense_lines (id BIGINT PRIMARY KEY AUTO_INCREMENT, spent_on DATE NOT NULL COMMENT 'Day of the expense', employee_id INT NOT NULL, department_id INT NOT NULL COMMENT 'Cost centre charged', category_id INT NOT NULL, vendor VARCHAR(80), amount DECIMAL(12,2) NOT NULL COMMENT 'USD', event_id INT NULL COMMENT 'Set when the line belongs to a company event', status VARCHAR(12) NOT NULL COMMENT 'approved, pending or rejected', FOREIGN KEY (employee_id) REFERENCES employees (id), FOREIGN KEY (department_id) REFERENCES departments (id), FOREIGN KEY (category_id) REFERENCES expense_categories (id), FOREIGN KEY (event_id) REFERENCES company_events (id), INDEX (spent_on), INDEX (department_id), INDEX (category_id)) COMMENT='One row per expense line. Fiscal year = calendar year';
CREATE TABLE budgets (department_id INT NOT NULL, category_group VARCHAR(30) NOT NULL, month DATE NOT NULL COMMENT 'First day of the month', amount DECIMAL(12,2) NOT NULL COMMENT 'USD', PRIMARY KEY (department_id, category_group, month), FOREIGN KEY (department_id) REFERENCES departments (id)) COMMENT='Monthly budget per cost centre and category group';
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=3306)
    ap.add_argument("--through", default=None, help="last day of data, YYYY-MM-DD (default: yesterday)")
    args = ap.parse_args()
    rng = random.Random(20261112)
    last = dt.date.fromisoformat(args.through) if args.through else dt.date.today() - dt.timedelta(days=1)
    first = dt.date(last.year - 1, 1, 1)
    conn = pymysql.connect(host=args.host, port=args.port, user="root", password=os.environ["CANVAS_SAMPLE_ROOT_PASSWORD"], charset="utf8mb4", autocommit=False)
    cur = conn.cursor()
    cur.execute("DROP DATABASE IF EXISTS finance")
    cur.execute("CREATE DATABASE finance CHARACTER SET utf8mb4")
    cur.execute("USE finance")
    for statement in filter(None, (s.strip() for s in DDL.split(";\n"))):
        cur.execute(statement)
    cur.executemany("INSERT INTO departments (name, division) VALUES (%s,%s)", DEPARTMENTS)
    cur.executemany("INSERT INTO expense_categories (name, category_group, gl_account) VALUES (%s,%s,%s)", [(n, g, a) for n, g, a, _ in CATEGORIES])
    first_names = ["Ana", "Ben", "Carla", "Dev", "Elena", "Farid", "Grace", "Hugo", "Ines", "Jon", "Kira", "Leo", "Maya", "Noah", "Olga", "Pedro"]
    last_names = ["Almeida", "Brooks", "Chen", "Diaz", "Evans", "Fischer", "Gupta", "Haddad", "Ito", "Jensen", "Kim", "Lopez"]
    employees = []
    for dep_id, (dep, _) in enumerate(DEPARTMENTS, 1):
        for _ in range({"Sales": 22, "Engineering": 30, "Marketing": 12, "Customer Success": 14}.get(dep, 7)):
            employees.append((f"{rng.choice(first_names)} {rng.choice(last_names)}", dep_id, rng.choice(["Manager", "Director", "Lead", "Specialist", "Associate"])))
    cur.executemany("INSERT INTO employees (full_name, department_id, title) VALUES (%s,%s,%s)", employees)
    dep_ids = {name: i for i, (name, _) in enumerate(DEPARTMENTS, 1)}
    cur.executemany("INSERT INTO company_events (name, starts_on, owner_department_id) VALUES (%s,%s,%s)", [(n, d, dep_ids[o]) for n, d, o in EVENTS])
    by_dep = {}
    for emp_id, (_, dep_id, _) in enumerate(employees, 1):
        by_dep.setdefault(dep_id, []).append(emp_id)
    cats = {name: (i, group, base) for i, (name, group, _, base) in enumerate(CATEGORIES, 1)}
    lines, day = [], first
    while day <= last:
        growth = 1 + 0.22 * ((day - first).days / 365)                       # spend grows about 22% a year
        season = 1.25 if day.month in (1, 6, 10) else 0.8 if day.month in (7, 8, 12) else 1.0
        weekday = 0.15 if day.weekday() >= 5 else 1.0
        for dep, mix in MIX.items():
            dep_id = dep_ids[dep]
            n = rng.random() * len(by_dep[dep_id]) * 0.16 * growth * season * weekday
            for _ in range(int(n) + (1 if rng.random() < n % 1 else 0)):
                group = rng.choices(list(mix), weights=list(mix.values()))[0]
                name = rng.choice([c for c, (_, g, _) in cats.items() if g == group])
                cat_id, _, base = cats[name]
                amount = round(max(4.0, rng.lognormvariate(0, 0.55) * base * (1.35 if dep == "Executive" else 1.0)), 2)
                status = rng.choices(["approved", "pending", "rejected"], weights=[90, 7, 3])[0]
                lines.append((day, rng.choice(by_dep[dep_id]), dep_id, cat_id, rng.choice(VENDORS[name]), amount, None, status))
        day += dt.timedelta(days=1)
    for event_id, (name, start, owner) in enumerate(EVENTS, 1):                # each event: a burst of travel and event lines
        start = dt.date.fromisoformat(start)
        if start > last:
            continue
        size = 260 if "Kickoff" in name else 180 if "Conference" in name else 90
        for _ in range(size):
            cname = rng.choices(["Airfare", "Hotel", "Ground transport", "Meals while travelling", "Team offsites", "Client events", "Trade show booth"],
                                weights=[30, 30, 15, 15, 4, 4, 2 if "Trade" in name else 0.1])[0]
            cat_id, _, base = cats[cname]
            dep = owner if rng.random() < 0.6 else rng.choice(list(MIX))
            when = start + dt.timedelta(days=rng.randint(-3, 4))
            if when > last:
                continue
            lines.append((when, rng.choice(by_dep[dep_ids[dep]]), dep_ids[dep], cat_id, rng.choice(VENDORS[cname]),
                          round(rng.lognormvariate(0, 0.45) * base * 1.15, 2), event_id, "approved"))
    cur.executemany("INSERT INTO expense_lines (spent_on, employee_id, department_id, category_id, vendor, amount, event_id, status) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)", lines)
    cur.execute("""INSERT INTO budgets (department_id, category_group, month, amount)
                   SELECT l.department_id, c.category_group, DATE_FORMAT(l.spent_on, '%Y-%m-01'), ROUND(SUM(l.amount) * (0.82 + (l.department_id % 4) * 0.09), -2)
                   FROM expense_lines l JOIN expense_categories c ON c.id = l.category_id GROUP BY 1, 2, 3""")
    cur.execute("DROP USER IF EXISTS 'canvas_ro'@'%'")
    cur.execute("CREATE USER 'canvas_ro'@'%%' IDENTIFIED BY %s", (os.environ["CANVAS_DB_PASSWORD"],))
    cur.execute("GRANT SELECT ON finance.* TO 'canvas_ro'@'%'")
    conn.commit()
    cur.execute("ANALYZE TABLE expense_lines, budgets, employees")
    cur.fetchall()
    cur.execute("SELECT COUNT(*), MIN(spent_on), MAX(spent_on), ROUND(SUM(amount)) FROM expense_lines")
    print("expense_lines:", cur.fetchone())
    conn.close()


if __name__ == "__main__":
    main()
