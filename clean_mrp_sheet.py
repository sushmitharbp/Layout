import csv
from collections import defaultdict

input_file = 'Unit_1_Part_Master_Created - Sheet1.csv'
output_csv = 'Unit_1_MRP_Schedule_Cleaned.csv'
output_sql = 'import_unit_1_mrp.sql'

with open(input_file, 'r', encoding='utf-8', errors='ignore') as f:
    reader = csv.DictReader(f)
    rows = list(reader)

print(f'Total input rows: {len(rows)}')

# Aggregate duplicates by (company_id, month_year, part_no)
aggregated = defaultdict(lambda: {'monthly_schedule': 0, 'current_stock': 0})

for r in rows:
    pno = (r.get('part_no') or '').strip()
    if not pno:
        continue
    cid = (r.get('company_id') or 'PEPIPL').strip().upper()
    my = (r.get('month_year') or '2026-10').replace('_', '-')
    
    key = (cid, my, pno)
    
    try:
        sched = int(float(r.get('monthly_schedule') or 0))
    except Exception:
        sched = 0
    try:
        stock = int(float(r.get('current_stock') or 0))
    except Exception:
        stock = 0
        
    aggregated[key]['monthly_schedule'] += sched
    aggregated[key]['current_stock'] = max(aggregated[key]['current_stock'], stock)

print(f'Aggregated unique rows: {len(aggregated)}')

# Write clean CSV without empty 'id' column
fieldnames = ['company_id', 'month_year', 'part_no', 'monthly_schedule', 'current_stock']
with open(output_csv, 'w', newline='', encoding='utf-8') as f:
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    for (cid, my, pno), data in aggregated.items():
        writer.writerow({
            'company_id': cid,
            'month_year': my,
            'part_no': pno,
            'monthly_schedule': data['monthly_schedule'],
            'current_stock': data['current_stock']
        })

print(f'Saved clean CSV to {output_csv}')

# Write SQL script
sql_lines = []
sql_lines.append('-- ============================================================================')
sql_lines.append('-- SheetLayout AI — Unit 1 MRP Schedule & Stock Import Script')
sql_lines.append('-- Target Table: public.mrp')
sql_lines.append('-- ============================================================================\n')

sql_lines.append('INSERT INTO public.mrp (company_id, month_year, part_no, monthly_schedule, current_stock)')
sql_lines.append('VALUES')

values_list = []
for (cid, my, pno), data in aggregated.items():
    pno_esc = pno.replace("'", "''")
    values_list.append(f"  ('{cid}', '{my}', '{pno_esc}', {data['monthly_schedule']}, {data['current_stock']})")

sql_lines.append(',\n'.join(values_list))
sql_lines.append('''ON CONFLICT (month_year, part_no)
DO UPDATE SET
    company_id       = EXCLUDED.company_id,
    monthly_schedule = EXCLUDED.monthly_schedule,
    current_stock    = EXCLUDED.current_stock,
    updated_at       = now();
''')

with open(output_sql, 'w', encoding='utf-8') as f:
    f.write('\n'.join(sql_lines))

print(f'Saved SQL import script to {output_sql}')

