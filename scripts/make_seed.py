"""Print SQL that loads the shift list from shifts.json into Supabase.

Usage: python3 scripts/make_seed.py > supabase/seed.sql
Then paste supabase/seed.sql into the Supabase SQL Editor and run it.
Safe to re-run: existing shifts get their slot count updated.
"""
import json
import pathlib

root = pathlib.Path(__file__).resolve().parent.parent
config = json.loads((root / "shifts.json").read_text())

rows = [
    f"  ('{shift['id']}', {int(shift['slots'])})"
    for role in config["roles"]
    for shift in role["shifts"]
]

print("-- Generated from shifts.json by scripts/make_seed.py. Do not edit by hand.")
print("insert into public.shifts (id, slots) values")
print(",\n".join(rows))
print("on conflict (id) do update set slots = excluded.slots;")
