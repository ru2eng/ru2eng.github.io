"""Tatoeba local data builder.

Downloads Tatoeba per-language dump files, unpacks them and builds a compact
local dataset in data/ that replaces the live Tatoeba API for the trainer app.

Usage:
    python tools/build_index.py [--limit N] [--dump-dir DIR] [--out DIR] [--keep]

Options:
    --limit N       process at most N lines from each dump (test mode)
    --dump-dir DIR  cache directory for downloaded .bz2 dumps
    --out DIR       output directory for generated data files
    --skip-download reuse existing dump files without re-downloading

Outputs:
    data/eng.jsonl       {"id":N,"t":"...","w":K}   eng sentences (<=20 words, with audio)
    data/ru.jsonl        {"id":N,"t":"..."}         russian sentences referenced by links
    data/links.json      { "engId": [rusId,...], ... }
    data/audio.json      { "engId": [audioId,...], ... }   (no license filter)
    data/wordidx.json    { "token": [engId,...], ... }
    data/version.json    build metadata
"""

import argparse
import bz2
import json
import os
import re
import sys
import tempfile
import unicodedata
import urllib.request
from datetime import datetime, timezone

BASE_URL = "https://downloads.tatoeba.org/exports/per_language"

FILES = [
    ("eng_sentences.tsv.bz2", "eng"),
    ("rus_sentences.tsv.bz2", "rus"),
    ("eng-rus_links.tsv.bz2", "links"),
    ("eng_sentences_with_audio.tsv.bz2", "audio"),
]

AUDIO_BASE_URL = "https://tatoeba.org/audio"

HARD_LIMIT = 100 * 1024 * 1024
WARN_LIMIT = 90 * 1024 * 1024


def out_paths(root):
    return {
        "eng": os.path.join(root, "eng.jsonl"),
        "ru": os.path.join(root, "ru.jsonl"),
        "links": os.path.join(root, "links.json"),
        "audio": os.path.join(root, "audio.json"),
        "wordidx": os.path.join(root, "wordidx.json"),
        "version": os.path.join(root, "version.json"),
    }


def download(url, dest):
    if os.path.isfile(dest) and os.path.getsize(dest) > 0:
        return False
    tmp = dest + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": "tatoeba-local-builder/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as fh:
        while True:
            chunk = resp.read(1 << 16)
            if not chunk:
                break
            fh.write(chunk)
    os.replace(tmp, dest)
    return True


def iter_tsv(dump_dir, name, limit):
    path = os.path.join(dump_dir, name)
    with bz2.open(path, "rt", encoding="utf-8", newline="") as fh:
        for i, line in enumerate(fh):
            if limit and i >= limit:
                break
            line = line.rstrip("\n")
            if not line:
                continue
            yield line.split("\t")


def tokenize_key(text):
    norm = unicodedata.normalize("NFKC", text).lower()
    return [t.strip("'") for t in re.findall(r"[0-9a-z']+", norm) if t.strip("'")]


def main():
    parser = argparse.ArgumentParser(description="Build local Tatoeba dataset.")
    parser.add_argument("--limit", type=int, default=0, help="max lines per dump (test mode)")
    parser.add_argument("--dump-dir", default=os.path.join(tempfile.gettempdir(), "kilo", "tatoeba_dumps"))
    parser.add_argument("--out", default="data")
    parser.add_argument("--skip-download", action="store_true")
    args = parser.parse_args()

    if sys.stdout and hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    dump_dir = args.dump_dir
    out_dir = args.out
    limit = args.limit or None
    os.makedirs(dump_dir, exist_ok=True)
    os.makedirs(out_dir, exist_ok=True)

    SUBDIR = {"eng": "eng", "rus": "rus", "links": "eng", "audio": "eng"}

    if not args.skip_download:
        for name, kind in FILES:
            url = f"{BASE_URL}/{SUBDIR[kind]}/{name}"
            print(f"download {url} ...", flush=True)
            download(url, os.path.join(dump_dir, name))
    else:
        missing = [n for n, _ in FILES if not os.path.isfile(os.path.join(dump_dir, n))]
        if missing:
            print(f"missing dumps in {dump_dir}: {missing}", file=sys.stderr)
            sys.exit(1)

    print("loading english sentences ...", flush=True)
    eng_text = {}
    eng_words = {}
    for cols in iter_tsv(dump_dir, "eng_sentences.tsv.bz2", limit):
        if len(cols) >= 3:
            sid = int(cols[0])
            text = cols[2]
            w = len(text.split())
            if text.strip() and 1 <= w <= 20:
                eng_text[sid] = text
                eng_words[sid] = w
    print(f"  english sentences (<=20 words): {len(eng_text)}", flush=True)

    print("loading russian sentences ...", flush=True)
    rus_text = {}
    for cols in iter_tsv(dump_dir, "rus_sentences.tsv.bz2", limit):
        if len(cols) >= 3:
            sid = int(cols[0])
            text = cols[2]
            if text.strip():
                rus_text[sid] = text
    print(f"  russian sentences: {len(rus_text)}", flush=True)

    print("loading audio records ...", flush=True)
    audio_raw = {}
    for cols in iter_tsv(dump_dir, "eng_sentences_with_audio.tsv.bz2", limit):
        if len(cols) >= 2:
            sid = int(cols[0])
            aid = int(cols[1])
            audio_raw.setdefault(sid, []).append(aid)
    print(f"  audio records: {sum(len(v) for v in audio_raw.values())} for {len(audio_raw)} sentences", flush=True)

    kept_ids = {sid for sid in eng_text if sid in audio_raw}
    print(f"english sentences with audio: {len(kept_ids)}", flush=True)

    print("loading links ...", flush=True)
    links = {}
    for cols in iter_tsv(dump_dir, "eng-rus_links.tsv.bz2", limit):
        if len(cols) < 2:
            continue
        a, b = int(cols[0]), int(cols[1])
        if a in eng_text and b in rus_text:
            links.setdefault(a, set()).add(b)
        elif b in eng_text and a in rus_text:
            links.setdefault(b, set()).add(a)
    print(f"  links: {sum(len(v) for v in links.values())} pairs", flush=True)

    kept_links = {sid: sorted(links[sid]) for sid in kept_ids if sid in links}
    kept_audio = {sid: audio_raw[sid] for sid in kept_ids}
    referenced_ru = set()
    for ids in kept_links.values():
        referenced_ru.update(ids)

    print("building word index ...", flush=True)
    wordidx = {}
    for sid in kept_ids:
        for tok in set(tokenize_key(eng_text[sid])):
            wordidx.setdefault(tok, set()).add(sid)

    paths = out_paths(out_dir)
    target_estimate = 0

    with open(paths["eng"], "w", encoding="utf-8", newline="\n") as fh:
        for sid in kept_ids:
            fh.write(json.dumps({"id": sid, "t": eng_text[sid], "w": eng_words[sid]}, ensure_ascii=False) + "\n")
    target_estimate += os.path.getsize(paths["eng"])

    with open(paths["ru"], "w", encoding="utf-8", newline="\n") as fh:
        for sid in sorted(referenced_ru):
            fh.write(json.dumps({"id": sid, "t": rus_text[sid]}, ensure_ascii=False) + "\n")
    target_estimate += os.path.getsize(paths["ru"])

    with open(paths["links"], "w", encoding="utf-8", newline="\n") as fh:
        json.dump({str(k): v for k, v in kept_links.items()}, fh, ensure_ascii=False, separators=(",", ":"))
    target_estimate += os.path.getsize(paths["links"])

    with open(paths["audio"], "w", encoding="utf-8", newline="\n") as fh:
        json.dump({str(k): v for k, v in kept_audio.items()}, fh, ensure_ascii=False, separators=(",", ":"))
    target_estimate += os.path.getsize(paths["audio"])

    with open(paths["wordidx"], "w", encoding="utf-8", newline="\n") as fh:
        json.dump({k: sorted(v) for k, v in sorted(wordidx.items())}, fh, ensure_ascii=False, separators=(",", ":"))
    target_estimate += os.path.getsize(paths["wordidx"])

    meta = {
        "build_date": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "dump_date": "2026-11-14",
        "source": BASE_URL,
        "stat": {
            "eng_with_audio": len(kept_ids),
            "ru_sentences": len(referenced_ru),
            "links": sum(len(v) for v in kept_links.values()),
            "audio_records": sum(len(v) for v in kept_audio.values()),
            "word_tokens": len(wordidx),
        },
    }
    with open(paths["version"], "w", encoding="utf-8", newline="\n") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)
    target_estimate += os.path.getsize(paths["version"])

    print(flush=True)
    for key in ("eng", "ru", "links", "audio", "wordidx", "version"):
        size = os.path.getsize(paths[key])
        print(f"  {paths[key]}  {size/1024:.0f} KiB", flush=True)
    print(f"\ntotal data: {target_estimate/1024/1024:.1f} MiB", flush=True)
    if any(os.path.getsize(paths[k]) > HARD_LIMIT for k in ("eng", "ru", "links", "audio", "wordidx")):
        print("FAIL: a data file exceeds 100 MiB (GitHub Pages limit) - use Plan B (shard/binary)", file=sys.stderr)
        sys.exit(2)
    if any(os.path.getsize(paths[k]) > WARN_LIMIT for k in ("eng", "ru", "links", "audio", "wordidx")):
        print("WARNING: a data file is close to the 100 MiB GitHub Pages limit", file=sys.stderr)
    print("done.", flush=True)


if __name__ == "__main__":
    main()