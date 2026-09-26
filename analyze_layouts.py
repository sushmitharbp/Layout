import openpyxl
import re

wb = openpyxl.load_workbook('Copy of Layout Standardization  - August 25, 12_23 PM.xlsx')
defined_map = {}
for k, v in wb.defined_names.items():
    ref = v.attr_text if hasattr(v, 'attr_text') else str(v)
    defined_map[k] = ref

print(f'Total defined names: {len(defined_map)}')
layout_img_defs = {k: v for k, v in defined_map.items() if 'Layout image' in str(v)}
print(f'Defined names pointing to Layout image: {len(layout_img_defs)}')

ws_img = wb['Layout image']
print(f'Images in Layout image: {len(ws_img._images)}')

# Map (row, col) to image index
img_by_cell = {}
for idx, img in enumerate(ws_img._images):
    from_cell = getattr(img.anchor, '_from', None)
    if from_cell:
        r = from_cell.row + 1
        c = from_cell.col + 1
        img_by_cell[(r, c)] = idx

print(f'Images with cell coordinates: {len(img_by_cell)}')

# Check how many defined names match an image cell
matched = 0
for name, target in layout_img_defs.items():
    m = re.search(r'\$([A-Z]+)\$(\d+)', target)
    if m:
        col_letter, row_str = m.groups()
        row = int(row_str)
        col = 0
        for ch in col_letter:
            col = col * 26 + (ord(ch) - ord('A') + 1)
        if (row, col) in img_by_cell:
            matched += 1

print(f'Defined names directly matching image cell: {matched} out of {len(layout_img_defs)}')
