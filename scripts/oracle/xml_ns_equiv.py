#!/usr/bin/env python3
"""TT67 oracle: namespace equivalence of canonicalizeNs output, checked by lxml (independent XML parser).

Input: a JSON file [{"id", "orig", "canon", "map": {uri: prefix}}]. For every item:
  1. both documents parse (lxml, no network, no entities resolved);
  2. the trees are equivalent under XML Namespaces 1.0: same expanded element names ({uri}local), same attributes in
     Clark notation, same text / tail, same comments and PIs, in the same order;
  3. canonical form: every element / attribute whose namespace is in `map` uses exactly that prefix ("" = default);
  4. Markup Compatibility (ECMA-376 Part 3): every prefix named by mc:Ignorable / MustUnderstand / mc:Choice@Requires
     and by mc:ProcessContent / PreserveElements / PreserveAttributes is declared where it is used, and denotes the
     SAME namespace as in the original document.
Prints one JSON line {id, ok, problems[]} per item and a final summary line. Exit 1 if any item fails.
A test-only verifier: it shares no code with src/lib/office/xml-ns.ts.
"""
import json
import sys

from lxml import etree

MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
PREFIX_LISTS = {"Ignorable", "MustUnderstand"}
QNAME_LISTS = {"ProcessContent", "PreserveElements", "PreserveAttributes"}


def parse(s):
    parser = etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=True, remove_blank_text=False)
    return etree.fromstring(s.encode("utf-8") if isinstance(s, str) else s, parser)


def mce_tokens(el):
    """[(attr, prefix)] for the MCE prefix lists on this element."""
    out = []
    for k, v in el.attrib.items():
        q = etree.QName(k)
        local = q.localname
        if q.namespace == MC and local in PREFIX_LISTS | QNAME_LISTS:
            for t in v.split():
                out.append((local, t.split(":")[0] if local in QNAME_LISTS else t))
        if q.namespace is None and local == "Requires" and etree.QName(el).namespace == MC and etree.QName(el).localname == "Choice":
            for t in v.split():
                out.append(("Requires", t))
    return out


def compare(a, b, canon, path, probs):
    if not isinstance(a.tag, str) or not isinstance(b.tag, str):
        if type(a) is not type(b) or (a.text or "") != (b.text or ""):
            probs.append(f"{path}: comment/PI differs")
        if (a.tail or "") != (b.tail or ""):
            probs.append(f"{path}: tail differs")
        return
    if a.tag != b.tag:
        probs.append(f"{path}: element {a.tag} became {b.tag}")
        return
    # MCE prefix lists legitimately change spelling with the renaming; their MEANING is checked token by token below
    strip = lambda e: {k: v for k, v in e.attrib.items() if not (etree.QName(k).namespace == MC and etree.QName(k).localname in PREFIX_LISTS | QNAME_LISTS)
                       and not (k == "Requires" and etree.QName(e).namespace == MC and etree.QName(e).localname == "Choice")}
    if strip(a) != strip(b):
        probs.append(f"{path}: attributes differ {strip(a)} vs {strip(b)}"[:300])
    if (a.text or "") != (b.text or ""):
        probs.append(f"{path}: text differs")
    if (a.tail or "") != (b.tail or ""):
        probs.append(f"{path}: tail differs")
    ns = etree.QName(b).namespace
    if ns in canon:
        want = canon[ns] or None
        if b.prefix != want:
            probs.append(f"{path}: {b.tag} has prefix {b.prefix!r}, canonical is {want!r}")
    for k in b.attrib:
        q = etree.QName(k)
        if q.namespace in canon and canon[q.namespace]:
            # lxml exposes attribute prefixes through the nsmap of the element
            pref = [p for p, u in b.nsmap.items() if u == q.namespace and p]
            if canon[q.namespace] not in pref:
                probs.append(f"{path}: attribute {k} not under canonical prefix {canon[q.namespace]}")
    ta, tb = mce_tokens(a), mce_tokens(b)
    if len(ta) != len(tb):
        probs.append(f"{path}: MCE token count differs")
    for (la, pa), (lb, pb) in zip(ta, tb):
        ua, ub = a.nsmap.get(pa), b.nsmap.get(pb)
        if ub is None:
            probs.append(f"{path}: mc {lb} names undeclared prefix {pb!r}")
        elif ua != ub:
            probs.append(f"{path}: mc {lb} prefix {pb!r} means {ub}, was {ua}")
    ka, kb = list(a), list(b)
    if len(ka) != len(kb):
        probs.append(f"{path}: child count {len(ka)} vs {len(kb)}")
        return
    for i, (x, y) in enumerate(zip(ka, kb)):
        compare(x, y, canon, f"{path}/{i}", probs)
        if len(probs) > 20:
            return


def main():
    items = json.load(open(sys.argv[1], encoding="utf-8"))
    bad = 0
    for it in items:
        probs = []
        try:
            a, b = parse(it["orig"]), parse(it["canon"])
            compare(a, b, it.get("map", {}), "", probs)
        except etree.XMLSyntaxError as e:
            probs.append(f"parse error: {e}")
        ok = not probs
        bad += 0 if ok else 1
        print(json.dumps({"id": it["id"], "ok": ok, "problems": probs[:5]}))
    print(json.dumps({"summary": True, "items": len(items), "failed": bad}))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
