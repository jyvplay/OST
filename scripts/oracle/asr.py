"""
Independent speech-recognition oracle for Fusion Voice tests (TT32).

Uses CMU PocketSphinx 5 (CMU BSD-style licence, installed from PyPI into the tools venv) with its bundled US-English acoustic
model, language model and CMUdict. It is a TEST oracle only — nothing from it ships in Fusion.

Input (stdin): JSON {"jobs": [{"wav": path, "mode": "grammar"|"open"|"phones", "words": [..]}]}
  grammar: forced choice among "words" (each item may be a multi-word phrase); open: 60k-word LM; phones: allphone.
Output (stdout): JSON {"results": [{"wav": path, "hyp": str|None}]}
"""
import json, sys, wave

from pocketsphinx import Decoder


def read_pcm(path):
    with wave.open(path, "rb") as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2, path
        return w.readframes(w.getnframes())


def main():
    req = json.load(sys.stdin)
    dec = Decoder(samprate=16000, loglevel="FATAL")
    import os, pocketsphinx
    model_dir = os.path.join(os.path.dirname(pocketsphinx.__file__), "model", "en-us")
    dec.add_lm_file("open", os.path.join(model_dir, "en-us.lm.bin"))
    dec.add_allphone_file("phones", os.path.join(model_dir, "en-us-phone.lm.bin"))
    grammars = {}
    out = []
    for job in req["jobs"]:
        mode = job.get("mode", "grammar")
        if mode == "grammar":
            key = "|".join(job["words"])
            if key not in grammars:
                name = f"g{len(grammars)}"
                missing = sorted({w for ph in job["words"] for w in ph.split() if dec.lookup_word(w) is None})
                if missing:
                    raise SystemExit(f"words not in the recogniser dictionary: {missing}")
                gram = "#JSGF V1.0;\ngrammar %s;\npublic <w> = %s ;\n" % (name, " | ".join(job["words"]))
                dec.add_jsgf_string(name, gram)
                grammars[key] = name
            dec.activate_search(grammars[key])
        else:
            dec.activate_search(mode)
        dec.start_utt()
        dec.process_raw(read_pcm(job["wav"]), full_utt=True)
        dec.end_utt()
        h = dec.hyp()
        out.append({"wav": job["wav"], "hyp": h.hypstr if h else None})
    json.dump({"results": out}, sys.stdout)


if __name__ == "__main__":
    main()
