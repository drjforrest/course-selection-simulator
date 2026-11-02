"""Build data/base.json from the schedule spreadsheet and catalog extract.

Usage: python3 scripts/build_base.py

Inputs (in scripts/):
  schedule.xlsx          Health Informatics Course Schedule (HINF, PHTH, DA INSH sheets)
  catalog_courses.json   Titles, credits and descriptions from catalog.northeastern.edu (2026-2027)
"""
import json
import re
from pathlib import Path

import openpyxl

HERE = Path(__file__).parent
ROOT = HERE.parent

# Pools per program variant (2026-2027 catalogue + HINF Curriculum Pathways v1.0).
# HLTH 5800 counts toward Health Informatics at Boston/Vancouver, Technical in the general online variant.
BUSINESS = ["HINF 5407", "HINF 6201", "HINF 6202", "HINF 6215", "EMGT 5220", "HINF 6240", "HINF 6335", "PHTH 5226"]
HEALTH_INF = ["HINF 5102", "HINF 5110", "HINF 5200", "HINF 5300", "HINF 5301", "HINF 5500", "HINF 6205",
              "HINF 6404", "HINF 6405", "HLTH 5800", "PHTH 5232"]
TECHNICAL = ["HINF 6220", "HINF 6355", "HINF 6400", "PHTH 5202", "PHTH 5210", "PHTH 6210", "PHTH 7400", "PHTH 7440"]
TECH_LIMITED = ["DA 5020", "DA 5030", "INSH 5301", "INSH 5302"]  # at most one counts toward Technical
ELECTIVES = ["DA 5020", "DA 5030", "HINF 6345", "INSH 5301", "INSH 5302", "PHIL 5110"]
CORE = ["HINF 5101", "HINF 5105", "HINF 5106", "HINF 7701"]

# Prerequisites from the catalogue. Each inner list is an OR-group; all groups are required.
# Alternatives outside this program (MATH 5010, PHTH 6830) are listed so students can mark them completed.
PREREQS = {
    "HINF 6355": [["HINF 5101"]],
    "PHTH 6210": [["PHTH 5210", "MATH 5010", "PHTH 6830"]],
    "PHTH 7400": [["PHTH 5210"]],
    "PHTH 7440": [["PHTH 6210", "PHTH 6830"]],
}
EXTERNAL = {
    "MATH 5010": "Introductory Probability and Statistics (or equivalent)",
    "PHTH 6830": "Biostatistics course PHTH 6830 (or equivalent)",
}

# Spreadsheet course numbers that are recording errors for another course.
CODE_FIXES = {"HINF 6401": "HINF 6400", "HINF 5103": "HINF 5102", "HINF 7702": "HINF 7701"}

TERM_IDS = {"Spr2025": "2025-SP", "Spring25": "2025-SP", "Fall 2025": "2025-FA", "Spr2026": "2026-SP",
            "Sum2026": "2026-SU", "Fall 2026": "2026-FA"}


def fmt(v):
    s = (str(v).strip().lower() if v is not None else "")
    if s == "x":
        return "online"
    if s == "hybrid":
        return "hybrid"
    return "on-ground"


def read_schedule():
    wb = openpyxl.load_workbook(HERE / "schedule.xlsx", data_only=True)
    sections = []  # (term_id, code, format)
    for r in wb["HINF"].iter_rows(min_row=2, values_only=True):
        if r[0] in (None, "--"):
            continue
        if r[0] == "Fall 2026":  # this block has shifted columns: term, course#, section, CRN, title, instr, credits, online
            term, num, online = r[0], r[1], r[7]
        else:
            term, num, online = r[1], r[2], r[7]
        if term not in TERM_IDS or num is None:
            continue
        sections.append((TERM_IDS[term], f"HINF {int(num)}", fmt(online)))
    for sheet, dept in (("PHTH", "PHTH"), ("DA INSH", None)):
        for r in wb[sheet].iter_rows(min_row=2, values_only=True):
            if r[0] not in TERM_IDS or r[1] is None:
                continue
            num = str(r[1])
            code = f"{dept} {num}" if dept else re.sub(r"^([A-Z]+)(\d+)$", r"\1 \2", num)
            sections.append((TERM_IDS[r[0]], code, fmt(r[8])))
    return sections


def main():
    catalog = json.loads((HERE / "catalog_courses.json").read_text())
    codes = sorted(set(CORE + BUSINESS + HEALTH_INF + TECHNICAL + TECH_LIMITED + ELECTIVES))

    def pools(variant):
        out = {}
        for c in codes:
            p = []
            if c in BUSINESS: p.append("business")
            if c in TECHNICAL or c in TECH_LIMITED: p.append("technical")
            if c in HEALTH_INF: p.append("health")
            if c in ELECTIVES: p.append("elective")
            if c == "HLTH 5800" and variant == "online":
                p = ["technical"]
            out[c] = p
        return out

    courses = {}
    for c in codes:
        cat = catalog[c]
        text = cat["text"]
        desc = re.split(r"\s(?:Prerequisite\(s\)|Corequisite\(s\)|Attribute\(s\)):", text)[0].strip()
        courses[c] = {
            "code": c,
            "title": cat["title"],
            "credits": int(cat["credits"]),
            "description": desc,
            "prereqs": PREREQS.get(c, []),
        }
    courses["EMGT 5220"]["equivalentTo"] = "HINF 6215"

    # History: term -> code -> sorted formats. Coverage says which departments a term's data speaks for;
    # a course from a covered department that is absent was not offered.
    history = {}
    for term, code, f in read_schedule():
        code = CODE_FIXES.get(code, code)
        if code not in courses:
            continue
        history.setdefault(term, {}).setdefault(code, set()).add(f)
    coverage = {t: ["HINF"] for t in ["2025-SP", "2025-FA", "2026-SP", "2026-SU", "2026-FA"]}
    coverage["2025-SP"] += ["PHTH 5202", "PHTH 5210", "PHTH 6210", "DA 5020", "DA 5030", "INSH 5301", "INSH 5302"]

    base = {
        "source": "Health Informatics Course Schedule.xlsx; NU Academic Catalogue 2026-2027; HINF Curriculum Pathways v1.0",
        "courses": courses,
        "external": EXTERNAL,
        "pools": {v: pools(v) for v in ("boston", "online", "vancouver")},
        "techLimited": TECH_LIMITED,
        "history": {t: {c: sorted(f) for c, f in sorted(m.items())} for t, m in sorted(history.items())},
        "coverage": coverage,
    }
    (ROOT / "data").mkdir(exist_ok=True)
    (ROOT / "data" / "base.json").write_text(json.dumps(base, indent=1))
    print(f"{len(courses)} courses, {len(base['history'])} historical terms")


if __name__ == "__main__":
    main()
