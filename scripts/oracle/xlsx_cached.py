"""TT46 test-only oracle: for each .xlsx path on stdin (one per line), openpyxl (MIT, independent OOXML reader) lists every
formula cell with the value the authoring application (usually Excel) cached in the file. Output: JSON lines
{"file", "sheets": {name: [[ref, formula, cached, type]]}} or {"file", "error"}."""
import sys, json, warnings, datetime
warnings.filterwarnings("ignore")
import openpyxl
for line in sys.stdin:
    p = line.rstrip("\n")
    if not p: continue
    try:
        wf = openpyxl.load_workbook(p, data_only=False, read_only=False)
        wv = openpyxl.load_workbook(p, data_only=True, read_only=False)
        out = {}
        for ws in wf.worksheets:
            vs = wv[ws.title]; rows = []
            for row in ws.iter_rows():
                for c in row:
                    f = c.value
                    if isinstance(f, str) and f.startswith("="):
                        v = vs[c.coordinate].value
                        if v is None: continue
                        if isinstance(v, (datetime.datetime, datetime.date, datetime.time)): continue  # openpyxl date coercion: compare serials only
                        rows.append([c.coordinate, f, v if not isinstance(v, float) or v == v else None, type(v).__name__])
            if rows: out[ws.title] = rows
        print(json.dumps({"file": p, "sheets": out}), flush=True)
    except Exception as e:
        print(json.dumps({"file": p, "error": f"{type(e).__name__}: {e}"[:200]}), flush=True)
