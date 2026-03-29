import argparse
import http.client
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote, unquote, urlparse

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager


def resolve_chrome_binary() -> str:
    """Path ke Google Chrome / Chromium. VPS sering tidak punya 'google-chrome' di PATH default Selenium."""
    for key in ("CHROME_BIN", "CHROMIUM_BIN"):
        raw = (os.environ.get(key) or "").strip()
        if raw and os.path.isfile(raw) and os.access(raw, os.X_OK):
            return raw
    for p in (
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
    ):
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return ""


# Bulan ID lengkap + singkatan EN; panjang dulu (maret sebelum mar) agar "Maret 2025" terdeteksi.
_IDX_MONTH_SHORT_YEAR_RE = re.compile(
    r"\b(?:"
    r"januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|"
    r"jan|feb|mar|apr|may|jun|jul|agu|aug|sep|sept|oct|okt|nov|dec"
    r")\b[.\s_-]*(?:20)?\d{2}\b",
    re.I,
)
# Bulan Indonesia + tahun 4 digit dengan teks di antaranya (mis. "Maret MSTI 2025", "Maret_2025").
_IDX_ID_MONTH_FULL_YEAR_RE = re.compile(
    r"\b(?:"
    r"januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember"
    r")\b"
    r"[^0-9]{0,120}"
    r"\b20\d{2}\b",
    re.I,
)

# Judul harus mengandung minimal satu substring allow (ingest / lampiran). Selaras lib/idx.ts.
DEFAULT_ALLOW_TITLE_SUBSTRINGS = [
    "penyampaian laporan keuangan",
    "pengungkapan laporan keuangan",
    "laporan keuangan",
    "financial report",
    "financial statements",
    "financial statement",
    "annual report",
    "interim financial",
    "quarterly report",
    "laporan tahunan",
    "laporan interim",
    # Judul IDX sering memakai singkatan LK tanpa kata "laporan keuangan"
    "penyampaian lk",
    "lk triwulan",
    "lk tahunan",
    "lk interim",
    "laporan triwulan",
    "laporan semester",
    "ikhtisar keuangan",
    "ringkasan keuangan",
    "laporan penggunaan dana",
    "laporan informasi",
    "fakta material",
    "informasi atau fakta material",
    "public expose",
    "paparan publik",
    "pemenuhan kewajiban",
    "hasil paparan",
]

# Judul yang mengandung salah satu substring ini dilewati (lapisan kedua setelah allow).
DEFAULT_EXCLUDE_TITLE_SUBSTRINGS = [
    "Penyampaian Bukti",
    "Laporan Bulanan Registrasi Pemegang Efek",
    "registrasi pemegang efek",
    "registrasi kepemilikan efek",
    "Perubahan Alamat/Nomor Telepon/Fax/E-Mail/Website/NPWP/NPKP",
    "Perubahan Nama dan Kawasan Gedung Perkantoran",
    "penunjukan/perubahan kantor akuntan publik",
    "Ringkasan Risalah Rapat umum",
    "konfirmasi emiten grup",
    "penjelasan atas volatilitas transaksi",
    "rencana penyelenggaraan",
    "Pemanggilan rapat umum",
    "Pemberitahuan Rencana Rapat Umum",
    "rencana penyampaian",
    "Pengumuman RUPS",
    "Perubahan Nama",
    "Rencana perubahan status anak perusahaan",
    "pengunduran diri",
]
DEFAULT_EXCLUDE_ATTACHMENT_SUBSTRINGS = ["lamp1"]
# Surat ke regulator / non-isi; "penyampaian" sendiri terlalu lebar — ikut membuang PDF laporan keuangan
# yang memang bernama "Penyampaian Laporan Keuangan ...". Lihat should_skip_attachment.
SKIP_ATTACHMENT_HARD_SUBSTRINGS = [
    "bapepam",
    "pengunduran diri",
    # Semua lampiran checklist regulator / keterbukaan (bukan LK)
    "checklist",
    "daftar periksa",
]
ALLOW_LAMP1_TITLE_SUBSTRINGS = ["laporan informasi", "fakta material"]

# Judul pengumuman: jika mengandung salah satu ini, jangan buang lampiran hanya karena kata "penyampaian" di nama file.
TITLE_ALLOWS_PENYAMPAIAN_IN_FILENAME = [
    "penyampaian laporan keuangan",
    "laporan keuangan",
    "laporan interim",
    "penyampaian lk",
    "lk tahunan",
    "lk triwulan",
    "lk interim",
    "laporan triwulan",
    "laporan semester",
    "laporan penggunaan dana",
    "laporan informasi",
    "fakta material",
    "public expose",
    "pemenuhan kewajiban",
    "paparan publik",
    "lk audit",
]


def merge_exclude_title_substrings(*parts):
    seen = set()
    out = []
    for lst in parts:
        if not lst:
            continue
        for s in lst:
            t = (s or "").strip()
            if not t:
                continue
            key = t.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(t)
    return out


def resolve_exclude_title_substrings():
    extra = os.environ.get("IDX_EXCLUDE_TITLE_SUBSTRINGS", "")
    extra_parts = [x.strip() for x in extra.split(",") if x.strip()]
    return merge_exclude_title_substrings(DEFAULT_EXCLUDE_TITLE_SUBSTRINGS, extra_parts)


def merge_allow_title_substrings(*parts):
    seen = set()
    out = []
    for lst in parts:
        if not lst:
            continue
        for s in lst:
            t = (s or "").strip()
            if not t:
                continue
            key = t.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(t)
    return out


def resolve_allow_title_substrings():
    extra = os.environ.get("IDX_ALLOW_TITLE_SUBSTRINGS", "")
    extra_parts = [x.strip() for x in extra.split(",") if x.strip()]
    return merge_allow_title_substrings(DEFAULT_ALLOW_TITLE_SUBSTRINGS, extra_parts)


ALLOWLIST_REJECT_LABEL = "(di luar kategori judul yang diproses)"


def _title_is_financial_lk_submission(lower: str) -> bool:
    """Judul yang jelas pengumuman LK — jangan kena exclude 'Penyampaian Bukti' (substring tabrakan)."""
    if "laporan keuangan" in lower:
        return True
    if "laporan interim" in lower:
        return True
    if "yang tidak diaudit" in lower or "tidak diaudit" in lower:
        return True
    if re.search(r"\bpenyampaian\s+lk\b", lower):
        return True
    return False


def title_matches_allow_list(title: str, allow_substrings) -> bool:
    lower = (title or "").lower()
    return any(p.strip().lower() in lower for p in allow_substrings if (p or "").strip())


def title_matches_exclude_list(title: str, exclude_substrings) -> bool:
    lower = (title or "").lower()
    for ex in exclude_substrings:
        t = (ex or "").strip().lower()
        if not t or t not in lower:
            continue
        # Jangan buang "Rencana Penyampaian Laporan Keuangan ..."
        if t == "rencana penyampaian" and "laporan keuangan" in lower:
            continue
        if t == "penyampaian bukti" and _title_is_financial_lk_submission(lower):
            continue
        return True
    return False


def title_allows_lamp1(title: str) -> bool:
    lower_title = (title or "").lower()
    return any(k in lower_title for k in ALLOW_LAMP1_TITLE_SUBSTRINGS)


def title_allows_penyampaian_filename(title: str) -> bool:
    lt = (title or "").lower()
    return any(p in lt for p in TITLE_ALLOWS_PENYAMPAIAN_IN_FILENAME)


def should_skip_attachment(name_or_url: str, title: str) -> bool:
    lower = (name_or_url or "").lower()
    if "lamp1" in lower and title_allows_lamp1(title):
        return False
    if any(k in lower for k in SKIP_ATTACHMENT_HARD_SUBSTRINGS):
        return True
    if "penyampaian" in lower:
        if title_allows_penyampaian_filename(title):
            return False
        return True
    return any(k in lower for k in DEFAULT_EXCLUDE_ATTACHMENT_SUBSTRINGS)


def first_matching_exclude(title: str, exclude_substrings) -> str:
    lower = (title or "").lower()
    for ex in exclude_substrings:
        t = (ex or "").strip().lower()
        if not t or t not in lower:
            continue
        if t == "rencana penyampaian" and "laporan keuangan" in lower:
            continue
        if t == "penyampaian bukti" and _title_is_financial_lk_submission(lower):
            continue
        return ex.strip()
    return ""


def format_output_block(pengumuman: str, date: str, output_pdf: str) -> str:
    """Satu pengumuman = satu baris output (selaras formatIdxAnnouncementOutputBlock di TS)."""
    return (
        "{Pengumuman: "
        + (pengumuman or "").strip()
        + "\nDate: "
        + (date or "").strip()
        + "\nOutput PDF: "
        + (output_pdf or "").strip()
        + "}"
    )


def sanitize_idx_pdf_url(url: str) -> str:
    """Hapus whitespace/karakter kontrol di string URL (sering muncul dari JSON IDX)."""
    if not url:
        return ""
    s = str(url).strip()
    s = re.sub(r"[\x00-\x1f\x7f]", "", s)
    return s.strip()


def _pdf_basename_from_url(url: str) -> str:
    """Jika OriginalFilename kosong, pakai nama file dari path URL (selaras perilaku UI TS)."""
    if not (url or "").strip():
        return ""
    try:
        path = urlparse(str(url).strip()).path or ""
        name = unquote(path.rsplit("/", 1)[-1]).strip()
        if name.lower().endswith(".pdf"):
            return name
    except (ValueError, OSError):
        pass
    return ""


def save_file_name_from_attachment(att: dict, url: str) -> str:
    """OriginalFilename; jika kosong, fallback basename .pdf dari URL."""
    orig = str(att.get("OriginalFilename") or "").strip()
    if orig:
        return orig
    return _pdf_basename_from_url(url)


def _pdf_request_headers(url: str = "") -> dict:
    h = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        ),
        "Accept": "application/pdf,*/*",
    }
    if "idx.co.id" in (url or "").lower():
        h["Referer"] = "https://www.idx.co.id/"
        h["Origin"] = "https://www.idx.co.id"
    return h


def _total_bytes_from_content_range(value: str) -> int:
    # e.g. "bytes 0-0/7340032" or "bytes 0-7340031/7340032"
    m = re.search(r"/(\d+)\s*$", (value or "").strip())
    if m:
        try:
            n = int(m.group(1))
            return n if n > 0 else -1
        except ValueError:
            return -1
    return -1


def _content_length_int(headers) -> int:
    raw = (headers.get("Content-Length") or "").strip() if headers else ""
    if not raw or not raw.isdigit():
        return -1
    try:
        n = int(raw)
        return n if n > 0 else -1
    except ValueError:
        return -1


def _drain_response_body(resp, max_bytes: int = 65536) -> None:
    try:
        n = 0
        while n < max_bytes:
            chunk = resp.read(8192)
            if not chunk:
                break
            n += len(chunk)
    except Exception:
        pass


def pdf_url_size_bytes(url: str) -> int:
    """Ukuran file: HEAD + beberapa GET Range; identity encoding sering diperlukan agar Content-Range/CL ada."""
    url = sanitize_idx_pdf_url(url)
    if not url:
        return -1
    base = _pdf_request_headers(url)
    header_sets = (
        base,
        {**base, "Accept-Encoding": "identity"},
    )

    for h in header_sets:
        try:
            req = urllib.request.Request(url, method="HEAD", headers=h)
            with urllib.request.urlopen(req, timeout=18) as resp:
                n = _content_length_int(resp.headers)
                if n > 0:
                    return n
        except (
            urllib.error.URLError,
            urllib.error.HTTPError,
            OSError,
            ValueError,
            http.client.InvalidURL,
            http.client.HTTPException,
        ):
            pass

    for h in header_sets:
        for rng in ("bytes=0-0", "bytes=0-16383"):
            try:
                hh = dict(h)
                hh["Range"] = rng
                req = urllib.request.Request(url, method="GET", headers=hh)
                with urllib.request.urlopen(req, timeout=28) as resp:
                    cr = resp.headers.get("Content-Range")
                    if cr:
                        total = _total_bytes_from_content_range(cr)
                        if total > 0:
                            _drain_response_body(resp)
                            return total
                    n = _content_length_int(resp.headers)
                    if n > 0:
                        _drain_response_body(resp)
                        return n
            except (
                urllib.error.URLError,
                urllib.error.HTTPError,
                OSError,
                ValueError,
                http.client.InvalidURL,
                http.client.HTTPException,
            ):
                pass
    return -1


def _idx_attachment_blob_lower(file_name: str, url: str) -> str:
    n = (file_name or "").strip().lower()
    path = ""
    try:
        path = unquote(urlparse(url or "").path).lower()
    except (ValueError, OSError):
        pass
    return f"{n} {path}"


def is_penjelasan_20_persen_pdf(file_name: str, url: str) -> bool:
    """Penjelasan fluktuasi ~20% (OJK/IDX) — disimpan bersama PDF utama pengumuman yang sama."""
    blob = _idx_attachment_blob_lower(file_name, url)
    if "penjelasan" not in blob:
        return False
    if "persen" not in blob and "percent" not in blob:
        return False
    if not re.search(r"\b20\b", blob) and "20%" not in blob:
        return False
    return True


# LK/interim EN umum: "OBAT SEP 2025.pdf", "Report MSTI Mar 2025" — sering di-thin-kan oleh pola bulan;
# tetap diambil sebagai lampiran tambahan bila beda URL dari pemenang utama.
_EN_MONTH_YEAR_LK_PDF_RE = re.compile(
    r"\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|okt|nov|dec)\b[\s._-]*20\d{2}\b",
    re.I,
)


def is_en_month_year_lk_style_pdf(file_name: str, url: str) -> bool:
    blob = _idx_attachment_blob_lower(file_name, url)
    if not _EN_MONTH_YEAR_LK_PDF_RE.search(blob):
        return False
    if is_penjelasan_20_persen_pdf(file_name, url):
        return False
    return True


def is_cover_letter_pdf_name(file_name: str, url: str) -> bool:
    """Surat cover (ID: penyampaian LK) atau EN: cover letter — jangan dipilih bila ada lampiran lain."""
    blob = _idx_attachment_blob_lower(file_name, url)
    if re.search(r"cover[\s_-]+letter", blob, re.I):
        return True
    if "penyampaian" not in blob:
        return False
    if "lkq" in blob:
        return True
    if re.search(r"\blk\s*q?\s*[1-4]\b", blob, re.I):
        return True
    if re.search(r"\bpenyampaian[\s_-]+lk\b", blob, re.I):
        return True
    return False


def is_thin_supplemental_lk_pdf(file_name: str, url: str) -> bool:
    """Ringkasan regulator / surat penyampaian singkat / LK singkat — bukan PDF utama bila ada alternatif."""
    blob = _idx_attachment_blob_lower(file_name, url)
    if "checklist" in blob or "daftar periksa" in blob:
        return True
    if any(
        k in blob
        for k in (
            "consolidated",
            "konsolid",
            "audited",
            "audit",
            "tahunan",
            "annual",
            "triwulan",
            "kuartal",
            "financial statement",
            "final report",
            "interim",
        )
    ):
        return False
    # PDF utama EN sering "Report {TICKER} Mar 2025" — \bmar\b jangan bikin thin (beda dari LK ID bulanan).
    if re.search(r"\breport\b", blob, re.I) and "laporan keuangan" not in blob:
        return False
    # Surat direksi/komisaris (bukan FS) — sering lebih kecil dari Financial Report / LK
    if re.search(r"\bpernyataan\s+direksi\b", blob, re.I):
        return True
    if re.search(r"\bpernyataan\s+komisaris\b", blob, re.I):
        return True
    if "surat pernyataan" in blob:
        return True
    if re.search(r"\bstatement\s+of\s+directors?\b", blob, re.I):
        return True
    # Penjelasan / klarifikasi pasar (bukan laporan keuangan utama)
    if "kenaikan aset" in blob and "penjelasan" in blob:
        return True
    if re.search(r"\bpenjelasan\s+atas\s+volatilitas\b", blob, re.I):
        return True
    if re.search(r"\.fa\.\d+", blob, re.I):
        return True
    if re.search(r"\blap\.?\s*keu\b", blob, re.I):
        return True
    if "penyampaian laporan keuangan" in blob:
        return True
    if _IDX_MONTH_SHORT_YEAR_RE.search(blob):
        return True
    if _IDX_ID_MONTH_FULL_YEAR_RE.search(blob):
        return True
    return False


def heuristic_bonus(file_name: str, url: str = "") -> int:
    f = _idx_attachment_blob_lower(file_name, url)
    score = 0
    if "checklist" in f or "daftar periksa" in f:
        score -= 900
    if "billingual" in f or "bilingual" in f:
        score += 500
    if "final report" in f or "final_report" in f:
        score += 400
    if "consolidated" in f:
        score += 350
    if "financialstatement" in f:
        score += 200
    if "public expose" in f:
        score += 100
    if "lamp" in f:
        score -= 50
    # Surat penyampaian / ringkas — jangan menang dari FS utama bila ukuran probe gagal
    if "penyampaian" in f and ("lkq" in f or " lk" in f or f.endswith("lk.pdf") or " lk3" in f):
        score -= 600
    if re.search(r"cover[\s_-]+letter", f, re.I):
        score -= 650
    if re.search(r"\bpernyataan\s+direksi\b", f, re.I) or re.search(
        r"\bpernyataan\s+komisaris\b", f, re.I
    ):
        score -= 580
    if "surat pernyataan" in f:
        score -= 560
    if "kenaikan aset" in f and "penjelasan" in f:
        score -= 570
    if re.search(r"\bpenjelasan\s+atas\s+volatilitas\b", f, re.I):
        score -= 570
    if re.search(r"\.fa\.\d+", f, re.I):
        score -= 500
    if re.search(r"\blap\.?\s*keu\b", f, re.I):
        score -= 450
    if "penyampaian laporan keuangan" in f and not any(
        k in f
        for k in (
            "tahunan",
            "triwulan",
            "kuartal",
            "konsolid",
            "consolidated",
            "audited",
            "audit",
            "financial statement",
        )
    ):
        score -= 520
    _month_exempt = (
        "tahunan",
        "triwulan",
        "annual",
        "kuartal",
        "konsolid",
        "consolidated",
        "audit",
        "interim",
        "q1",
        "q2",
        "q3",
        "q4",
    )
    if (
        (_IDX_MONTH_SHORT_YEAR_RE.search(f) or _IDX_ID_MONTH_FULL_YEAR_RE.search(f))
        and not any(k in f for k in _month_exempt)
        and not (re.search(r"\breport\b", f, re.I) and "laporan keuangan" not in f)
    ):
        score -= 400
    return score


def _override_thin_if_larger_non_thin(
    pool1: List[Dict[str, Any]], winner: Optional[Dict[str, Any]]
) -> Optional[Dict[str, Any]]:
    """Jangan biarkan lampiran 'thin' menang bila ada non-thin terukur lebih besar (pool fallback)."""
    if winner is None:
        return None
    wfn = str(winner.get("file_name") or "")
    wurl = str(winner.get("url") or "")
    if not is_thin_supplemental_lk_pdf(wfn, wurl):
        return winner
    wsz = int(winner.get("size_bytes_probe", -1) or -1)
    best_alt: Optional[Dict[str, Any]] = None
    best_sz = -1
    for p in pool1:
        pfn = str(p.get("file_name") or "")
        pu = str(p.get("url") or "")
        if is_thin_supplemental_lk_pdf(pfn, pu):
            continue
        psz = int(p.get("size_bytes_probe", -1) or -1)
        if psz > best_sz:
            best_sz = psz
            best_alt = p
    if best_alt is not None and best_sz > 0 and (wsz < 0 or best_sz > wsz):
        return best_alt
    return winner


def pick_largest_pdf_per_announcement(pdfs: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Satu PDF: buang cover letter / penyampaian LKQ bila ada lampiran lain; lalu pilih ukuran terbesar (probe).

    Nama file (FS utama) hanya dipakai sebagai tie-break jika ukuran sama atau semua probe gagal —
    bukan untuk membatasi pool (supaya PDF besar yang nama generik tetap menang).
    """
    if not pdfs:
        return None
    non_cover = [
        p
        for p in pdfs
        if not is_cover_letter_pdf_name(
            str(p.get("file_name") or ""), str(p.get("url") or "")
        )
    ]
    pool1 = non_cover if non_cover else pdfs
    non_thin = [
        p
        for p in pool1
        if not is_thin_supplemental_lk_pdf(str(p.get("file_name") or ""), str(p.get("url") or ""))
    ]
    pool = non_thin if non_thin else pool1
    for p in pool1:
        p["size_bytes_probe"] = pdf_url_size_bytes(str(p.get("url") or ""))
    if len(pool) == 1:
        return _override_thin_if_larger_non_thin(pool1, pool[0])
    scored: List[Tuple[Dict[str, Any], int]] = []
    for p in pool:
        sz = int(p.get("size_bytes_probe", -1) or -1)
        scored.append((p, sz))
    measured = [(p, sz) for p, sz in scored if sz >= 0]
    if measured:
        best_p: Optional[Dict[str, Any]] = None
        best_key: Optional[Tuple[int, int]] = None
        for p, sz in measured:
            hb = heuristic_bonus(str(p.get("file_name") or ""), str(p.get("url") or ""))
            key = (sz, hb)
            if best_key is None or key > best_key:
                best_key = key
                best_p = p
        max_sz = max(sz for _, sz in measured)
        unmeas = [p for p, sz in scored if sz < 0]
        # PDF utama sering > ~600 KiB; kalau yang terukur semua kecil tapi ada kandidat tanpa ukuran,
        # pilih yang nama file lebih mirip laporan utama (probe CDN sering gagal untuk satu URL).
        suspect_small = 550_000
        hb_gap = 400
        if max_sz < suspect_small and unmeas:
            best_u = max(
                unmeas,
                key=lambda p: heuristic_bonus(
                    str(p.get("file_name") or ""), str(p.get("url") or "")
                ),
            )
            hb_p = heuristic_bonus(
                str(best_p.get("file_name") or ""), str(best_p.get("url") or "")
            )
            hb_u = heuristic_bonus(
                str(best_u.get("file_name") or ""), str(best_u.get("url") or "")
            )
            if hb_u >= hb_p + hb_gap:
                best_u["size_bytes_probe"] = -1
                return _override_thin_if_larger_non_thin(pool1, best_u)
        return _override_thin_if_larger_non_thin(pool1, best_p)
    best = None
    best_key: Optional[Tuple[int, int]] = None
    for p, sz in scored:
        hb = heuristic_bonus(str(p.get("file_name") or ""), str(p.get("url") or ""))
        key = (hb, sz)
        if best_key is None or key > best_key:
            best_key = key
            best = p
    return _override_thin_if_larger_non_thin(pool1, best)


def pick_pdfs_for_announcement(pdfs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Satu pengumuman: PDF utama + lampiran tambahan (Penjelasan 20 Persen, LK bulan EN+ tahun, beda URL)."""
    if not pdfs:
        return []
    primary = pick_largest_pdf_per_announcement(pdfs)
    if not primary:
        return []

    def norm_u(p: Dict[str, Any]) -> str:
        return sanitize_idx_pdf_url(str(p.get("url") or ""))

    seen: set = set()
    out: List[Dict[str, Any]] = []

    def add(p: Dict[str, Any]) -> None:
        u = norm_u(p)
        if not u or u in seen:
            return
        seen.add(u)
        out.append(p)

    add(primary)
    extras: List[Dict[str, Any]] = []
    for p in pdfs:
        fn = str(p.get("file_name") or "")
        u = str(p.get("url") or "")
        if is_penjelasan_20_persen_pdf(fn, u) or is_en_month_year_lk_style_pdf(fn, u):
            extras.append(p)
    extras.sort(key=lambda p: str(p.get("file_name") or "").lower())
    for p in extras:
        add(p)
    return out


def safe_name(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]+', "_", name).strip()


def unique_target_path(directory: Path, desired_name: str) -> Path:
    base_name = safe_name(desired_name) or "attachment.pdf"
    stem = Path(base_name).stem
    suffix = Path(base_name).suffix or ".pdf"
    candidate = directory / f"{stem}{suffix}"
    idx = 1
    while candidate.exists():
        candidate = directory / f"{stem} ({idx}){suffix}"
        idx += 1
    return candidate


def parse_args():
    parser = argparse.ArgumentParser(
        description="Download IDX PDFs (satu atau lebih per pengumuman bila ada Penjelasan 20 Persen + LK utama)."
    )
    parser.add_argument("--kode", default="CASS", help="Kode emiten, contoh CASS")
    parser.add_argument(
        "--output-dir",
        default=str(Path.home() / "Downloads" / "idx-dokumen"),
        help="Folder output file PDF",
    )
    parser.add_argument("--wait-seconds", type=int, default=10, help="Waktu tunggu challenge manual")
    parser.add_argument(
        "--no-prompt",
        action="store_true",
        help="Tidak menunggu input Enter (untuk mode background)",
    )
    parser.add_argument(
        "--json-out",
        default="",
        help="Path output JSON ringkasan hasil (optional)",
    )
    parser.add_argument(
        "--skip-announcement-ids-file",
        default="",
        help="JSON array of pengumuman.Id2 already imported for this project (skip pick + download)",
    )
    parser.add_argument("--headless", action="store_true", help="Jalankan chrome headless")
    return parser.parse_args()


def announcement_id_from_reply(r: dict) -> str:
    p = r.get("pengumuman")
    if not isinstance(p, dict):
        return ""
    v = p.get("Id2") or p.get("id2") or ""
    return str(v).strip()


def load_skip_import_keys(path_str: str) -> Tuple[set, set]:
    """Dari JSON array: URL http(s) → skip_urls; string lain atau 'id:...' → skip announcement Id2."""
    if not (path_str or "").strip():
        return set(), set()
    p = Path(path_str).expanduser().resolve()
    try:
        raw = p.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, json.JSONDecodeError):
        return set(), set()
    if not isinstance(data, list):
        return set(), set()
    ids: set = set()
    urls: set = set()
    for x in data:
        s = str(x).strip()
        if not s:
            continue
        low = s.lower()
        if low.startswith("http://") or low.startswith("https://"):
            u = sanitize_idx_pdf_url(s)
            if u:
                urls.add(u)
        elif s.startswith("id:"):
            t = s[3:].strip()
            if t:
                ids.add(t)
        else:
            ids.add(s)
    return ids, urls


def main():
    args = parse_args()
    kode = (args.kode or "").strip().upper()
    if not kode:
        raise RuntimeError("kode emiten wajib diisi")
    skip_announcement_ids, skip_import_urls = load_skip_import_keys(
        args.skip_announcement_ids_file
    )
    out_dir = Path(args.output_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    start_ts = time.time()

    opts = Options()
    opts.add_argument("--start-maximized")
    # Kurangi jejak otomasi (banyak situs memperlakukan headless berbeda dari windowed).
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_experimental_option("excludeSwitches", ["enable-automation"])
    opts.add_experimental_option("useAutomationExtension", False)
    if args.headless:
        opts.add_argument("--headless=new")
        opts.add_argument("--disable-gpu")
        opts.add_argument("--no-sandbox")
        opts.add_argument("--disable-dev-shm-usage")
        opts.add_argument("--window-size=1920,1080")
    prefs = {
        "download.default_directory": str(out_dir),
        "download.prompt_for_download": False,
        "download.directory_upgrade": True,
        "plugins.always_open_pdf_externally": True,
        "safebrowsing.enabled": True,
    }
    opts.add_experimental_option("prefs", prefs)
    chrome_bin = resolve_chrome_binary()
    if chrome_bin:
        opts.binary_location = chrome_bin
        print(f"Chrome binary: {chrome_bin}")
    elif sys.platform.startswith("linux"):
        raise RuntimeError(
            "Chrome/Chromium tidak ditemukan. Di VPS: sudo apt install -y chromium-browser "
            "(atau google-chrome-stable), atau set env CHROME_BIN=/path/ke/chromium"
        )
    driver = webdriver.Chrome(
        service=Service(ChromeDriverManager().install()),
        options=opts,
    )
    driver.set_script_timeout(120)
    driver.set_page_load_timeout(60)

    try:
        driver.get("https://idx.co.id/id/perusahaan-tercatat/keterbukaan-informasi/")
        if args.wait_seconds > 0:
            print("Selesaikan challenge manual di browser.")
            if args.no_prompt:
                print(f"Tunggu {args.wait_seconds} detik sebelum lanjut...")
                time.sleep(args.wait_seconds)
            else:
                input("Jika halaman IDX sudah kebuka normal, tekan Enter di terminal untuk lanjut...")

        page_size = 100
        max_pages = 50
        replies: List[dict] = []
        result_count: Optional[int] = None
        date_to = datetime.now().strftime("%Y%m%d")
        raw_pages: List[Dict[str, Any]] = []
        for page_idx in range(max_pages):
            index_from = page_idx * page_size
            api_url = (
                "https://idx.co.id/primary/ListedCompany/GetAnnouncement"
                f"?kodeEmiten={quote(kode)}"
                "&emitenType=*"
                f"&indexFrom={index_from}"
                f"&pageSize={page_size}"
                "&dateFrom=19010101"
                f"&dateTo={date_to}"
                "&lang=id"
                "&keyword="
            )
            try:
                driver.get(api_url)
            except Exception:
                pass
            body_text = driver.find_element("tag name", "body").text.strip()
            if not body_text.startswith("{"):
                raise RuntimeError(
                    f"IDX API tidak mengembalikan JSON (page {page_idx}). Preview: {body_text[:250]}"
                )
            data = json.loads(body_text)
            chunk = data.get("Replies") or []
            if result_count is None:
                rc = data.get("ResultCount")
                if isinstance(rc, int):
                    result_count = rc
            replies.extend(chunk)
            raw_pages.append(
                {
                    "indexFrom": index_from,
                    "pageSize": page_size,
                    "resultCount": data.get("ResultCount"),
                    "replyCount": len(chunk),
                    "replies": chunk,
                }
            )
            if len(chunk) < page_size:
                break
            if result_count is not None and index_from + page_size >= result_count:
                break
        print(f"IDX GetAnnouncement: {len(replies)} baris (hingga {max_pages} halaman @ {page_size}).")
        if (args.json_out or "").strip():
            raw_out = Path(args.json_out).expanduser().resolve().parent / "get_announcement_raw.json"
            raw_out.parent.mkdir(parents=True, exist_ok=True)
            raw_snapshot: Dict[str, Any] = {
                "kodeEmiten": kode,
                "fetchedAt": datetime.now(timezone.utc).isoformat(),
                "resultCount": result_count,
                "pagesFetched": len(raw_pages),
                "mergedReplyCount": len(replies),
                "pages": raw_pages,
            }
            raw_out.write_text(
                json.dumps(raw_snapshot, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            print(f"IDX raw GetAnnouncement tersimpan: {raw_out}")
        exclude_titles = resolve_exclude_title_substrings()
        allow_titles = resolve_allow_title_substrings()

        # Full list for JSON / ticker cache (must include every pick). Skip-by-Id2 only
        # affects browser downloads — otherwise a stale cache after "delete project" would
        # only ever contain the non-skipped subset from the previous run.
        all_picks: List[Dict[str, Any]] = []
        skipped_by_title_filter = 0
        excluded_announcements: List[Dict[str, str]] = []
        for r in replies:
            id2 = announcement_id_from_reply(r)
            title = str(r.get("pengumuman", {}).get("JudulPengumuman", "")).strip()
            pub = str(r.get("pengumuman", {}).get("TglPengumuman", ""))
            if title_matches_exclude_list(title, exclude_titles):
                skipped_by_title_filter += 1
                excluded_announcements.append(
                    {
                        "publishedAt": pub,
                        "title": title,
                        "matchedExclude": first_matching_exclude(title, exclude_titles),
                    }
                )
                continue
            if not title_matches_allow_list(title, allow_titles):
                skipped_by_title_filter += 1
                excluded_announcements.append(
                    {
                        "publishedAt": pub,
                        "title": title,
                        "matchedExclude": ALLOWLIST_REJECT_LABEL,
                    }
                )
                continue
            pdfs = []
            for a in r.get("attachments", []):
                if a.get("IsAttachment") is not True:
                    continue
                url = sanitize_idx_pdf_url(str(a.get("FullSavePath", "")))
                if not url:
                    continue
                if not re.search(r"\.pdf(\?|$)", url, re.IGNORECASE):
                    continue
                fname = save_file_name_from_attachment(a, url)
                if not fname:
                    continue
                if should_skip_attachment(fname, title) or should_skip_attachment(url, title):
                    continue
                pdfs.append(
                    {
                        "title": title,
                        "date": str(r.get("pengumuman", {}).get("TglPengumuman", "")),
                        "url": url,
                        "file_name": fname,
                        "announcement_id": id2,
                    }
                )
            for picked in pick_pdfs_for_announcement(pdfs):
                all_picks.append(picked)

        def should_skip_download(pick: Dict[str, Any]) -> bool:
            u = sanitize_idx_pdf_url(str(pick.get("url") or ""))
            if u and u in skip_import_urls:
                return True
            aid = str(pick.get("announcement_id") or "").strip()
            return bool(aid and aid in skip_announcement_ids)

        skipped_already_imported = sum(1 for p in all_picks if should_skip_download(p))
        to_download = [p for p in all_picks if not should_skip_download(p)]

        if skipped_already_imported:
            print(
                f"Baris PDF tanpa unduhan browser (URL/Id2 sudah di DB project): {skipped_already_imported}"
            )

        if not all_picks:
            print("Tidak ada dokumen PDF baru (semua dilewati atau tidak ada lampiran PDF).")
            if args.json_out:
                summary = {
                    "kode": kode,
                    "selected_docs": [],
                    "excluded_announcements": excluded_announcements,
                    "counts": {
                        "selected": 0,
                        "download_detected": 0,
                        "excluded_announcements": skipped_by_title_filter,
                        "skipped_already_imported": skipped_already_imported,
                    },
                }
                out_json = Path(args.json_out).expanduser().resolve()
                out_json.parent.mkdir(parents=True, exist_ok=True)
                out_json.write_text(
                    json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
                )
            return

        print(f"Pengumuman dilewati (exclude / allowlist judul): {skipped_by_title_filter}")
        if excluded_announcements:
            print("Daftar pengumuman terlewati:")
            print(json.dumps(excluded_announcements, ensure_ascii=False, indent=2))

        print(f"Kandidat dokumen PDF terpilih (total): {len(all_picks)}")
        print(f"Unduhan browser (belum ada Id2 di DB): {len(to_download)}")
        print("Mulai download via browser session (hanya entri yang perlu unduhan)...")
        url_to_download_row: Dict[str, Dict[str, Any]] = {}
        for item in to_download:
            print(f"DOWNLOAD_FILE: {item['file_name']}")
            before = {
                str(fp): fp.stat().st_mtime_ns
                for fp in out_dir.glob("*.pdf")
            }
            driver.get(item["url"])
            # tunggu file baru/updated untuk URL ini
            picked_fp = None
            for _ in range(40):
                pending = list(out_dir.glob("*.crdownload"))
                changed = []
                for fp in out_dir.glob("*.pdf"):
                    key = str(fp)
                    prev_mtime = before.get(key)
                    now_mtime = fp.stat().st_mtime_ns
                    if prev_mtime is None or now_mtime != prev_mtime:
                        changed.append(fp)
                if changed and not pending:
                    changed.sort(key=lambda p: p.stat().st_mtime, reverse=True)
                    picked_fp = changed[0]
                    break
                time.sleep(1)

            renamed_fp = picked_fp
            if picked_fp:
                expected_name = item["file_name"]
                sanitized_expected = safe_name(expected_name) or "attachment.pdf"
                if picked_fp.name != sanitized_expected:
                    target = unique_target_path(out_dir, sanitized_expected)
                    try:
                        picked_fp.rename(target)
                        renamed_fp = target
                    except OSError:
                        # Keep original browser filename if rename fails.
                        renamed_fp = picked_fp

            result = {
                "title": item["title"],
                "date": item["date"],
                "expected_file_name": item["file_name"],
                "url": item["url"],
                "announcement_id": str(item.get("announcement_id") or "").strip(),
                "downloaded_file_name": renamed_fp.name if renamed_fp else "",
                "downloaded_size_bytes": renamed_fp.stat().st_size if renamed_fp else -1,
            }
            url_to_download_row[sanitize_idx_pdf_url(item["url"])] = result

        download_results: List[Dict[str, Any]] = []
        for pick in all_picks:
            url_key = sanitize_idx_pdf_url(pick["url"])
            if should_skip_download(pick):
                download_results.append(
                    {
                        "title": pick["title"],
                        "date": pick["date"],
                        "expected_file_name": pick["file_name"],
                        "url": pick["url"],
                        "announcement_id": str(pick.get("announcement_id") or "").strip(),
                        "downloaded_file_name": "",
                        "downloaded_size_bytes": -1,
                    }
                )
            else:
                dr = url_to_download_row.get(url_key)
                if dr:
                    download_results.append(dr)
                else:
                    download_results.append(
                        {
                            "title": pick["title"],
                            "date": pick["date"],
                            "expected_file_name": pick["file_name"],
                            "url": pick["url"],
                            "announcement_id": str(pick.get("announcement_id") or "").strip(),
                            "downloaded_file_name": "",
                            "downloaded_size_bytes": -1,
                        }
                    )

        # wait pending .crdownload settles
        for _ in range(30):
            pending = list(out_dir.glob("*.crdownload"))
            if not pending:
                break
            time.sleep(1)

        downloaded = []
        for fp in out_dir.glob("*.pdf"):
            if fp.stat().st_mtime >= start_ts - 2:
                downloaded.append(fp)

        success_count = sum(1 for r in download_results if r["downloaded_file_name"])
        print(f"Total kandidat dokumen PDF: {len(all_picks)}")
        print(f"Berhasil download (terdeteksi per entri): {success_count}")
        print(f"Gagal/terblokir kemungkinan: {max(len(to_download) - len(downloaded), 0)}")
        print(f"Folder output: {out_dir}")
        print(f"\n--- Output final (setelah download, {len(download_results)} entri) ---")
        for r in download_results:
            output_pdf = r["expected_file_name"]
            print(format_output_block(r["title"], r["date"], output_pdf))
            print()
        if downloaded:
            print("File PDF baru di folder (nama bisa dari browser):")
            for fp in sorted(downloaded, key=lambda p: p.name.lower()):
                print(f"  - {fp.name} ({round(fp.stat().st_size / 1024 / 1024, 2)} MB)")
        else:
            print("Tidak ada file yang berhasil di-download.")
            print("Kemungkinan sesi challenge belum lolos penuh untuk endpoint file.")

        if args.json_out:
            summary = {
                "kode": kode,
                "selected_docs": download_results,
                "excluded_announcements": excluded_announcements,
                "counts": {
                    "selected": len(all_picks),
                    "browser_downloads_attempted": len(to_download),
                    "download_detected": success_count,
                    "excluded_announcements": skipped_by_title_filter,
                    "skipped_already_imported": skipped_already_imported,
                },
            }
            out_json = Path(args.json_out).expanduser().resolve()
            out_json.parent.mkdir(parents=True, exist_ok=True)
            out_json.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    finally:
        driver.quit()


if __name__ == "__main__":
    main()

