import csv
import os

def parse_rm_code(rm_code):
    parts = rm_code.split('-')
    try:
        w = float(parts[-1])
        l = float(parts[-2])
        t = float(parts[-3])
        wt = round(l * w * t * 0.00000785, 3)
    except Exception:
        wt = 50.0
    return wt

input_csv = 'Unit_1_Part_Master_Cleaned.csv'
with open(input_csv, 'r', encoding='utf-8') as f:
    rows = list(csv.DictReader(f))

rms = set(r['standard_rm'] for r in rows if r['standard_rm'])

sql_lines = []
sql_lines.append('-- ============================================================================')
sql_lines.append('-- SheetLayout AI — Unit 1 Parts & RM Import Script')
sql_lines.append('-- Fixes incompatible data issues: clean types, foreign keys, and no duplicates')
sql_lines.append('-- ============================================================================\n')

sql_lines.append('-- 1. Ensure all Unit 1 Raw Material standards exist in public.rm first')
sql_lines.append('-- (Prevents Foreign Key violation on standard_rm REFERENCES rm(rm_code))\n')

for rm in sorted(list(rms)):
    wt = parse_rm_code(rm)
    sql_lines.append(f"INSERT INTO public.rm (rm_code, company_id, available_sheets, weight_per_sheet) VALUES ('{rm}', 'PEPIPL', 0, {wt}) ON CONFLICT (rm_code) DO NOTHING;")

sql_lines.append('\n-- 2. Insert or update 443 clean Unit 1 Parts into public.parts\n')
sql_lines.append('INSERT INTO public.parts (company_id, part_no, part_desc, grade, thickness, length, width, weight, offtake, strip_per_blank_qty, standard_rm)')
sql_lines.append('VALUES')

values_list = []
for r in rows:
    pno = r['part_no'].replace("'", "''")
    pdesc = r['part_desc'].replace("'", "''")
    grade = r['grade'].replace("'", "''")
    srm = r['standard_rm'].replace("'", "''")
    val = f"  ('{r['company_id']}', '{pno}', '{pdesc}', '{grade}', {r['thickness']}, {r['length']}, {r['width']}, {r['weight']}, {r['offtake']}, {r['strip_per_blank_qty']}, '{srm}')"
    values_list.append(val)

sql_lines.append(',\n'.join(values_list))
sql_lines.append('''ON CONFLICT (part_no) 
DO UPDATE SET
    company_id          = EXCLUDED.company_id,
    part_desc           = EXCLUDED.part_desc,
    grade               = EXCLUDED.grade,
    thickness           = EXCLUDED.thickness,
    length              = EXCLUDED.length,
    width               = EXCLUDED.width,
    weight              = EXCLUDED.weight,
    offtake             = EXCLUDED.offtake,
    strip_per_blank_qty = EXCLUDED.strip_per_blank_qty,
    standard_rm         = EXCLUDED.standard_rm,
    updated_at          = now();
''')

with open('import_unit_1_parts.sql', 'w', encoding='utf-8') as f:
    f.write('\n'.join(sql_lines))

print(f'Generated import_unit_1_parts.sql with {len(rows)} parts and {len(rms)} RM standards.')

