import argparse
import json
import os
import time
from datetime import datetime

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager


def main():
    parser = argparse.ArgumentParser(
        description="Fetch IDX GetAnnouncement using manual-challenge browser session."
    )
    parser.add_argument("--kode", required=True, help="Kode emiten, contoh: CASS")
    parser.add_argument("--date-from", default="19010101", help="Format YYYYMMDD")
    parser.add_argument(
        "--date-to",
        default=datetime.now().strftime("%Y%m%d"),
        help="Format YYYYMMDD",
    )
    parser.add_argument("--page-size", default="100", help="Jumlah data per page")
    parser.add_argument(
        "--wait-seconds",
        type=int,
        default=45,
        help="Waktu untuk menyelesaikan challenge manual di browser",
    )
    parser.add_argument(
        "--out",
        default="",
        help="Path output JSON. Default: Downloads/GetAnnouncement_<KODE>_<YYYYMMDD_HHMMSS>.json",
    )
    args = parser.parse_args()

    kode = args.kode.strip().upper()
    if not kode:
        raise SystemExit("kode emiten wajib diisi")

    if args.out:
        out_path = args.out
    else:
        downloads = os.path.join(os.path.expanduser("~"), "Downloads")
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        out_path = os.path.join(downloads, f"GetAnnouncement_{kode}_{ts}.json")

    url = (
        "https://idx.co.id/primary/ListedCompany/GetAnnouncement"
        f"?kodeEmiten={kode}"
        "&emitenType=*"
        "&indexFrom=0"
        f"&pageSize={args.page_size}"
        f"&dateFrom={args.date_from}"
        f"&dateTo={args.date_to}"
        "&lang=id"
        "&keyword="
    )

    opts = Options()
    opts.add_argument("--start-maximized")

    driver = webdriver.Chrome(
        service=Service(ChromeDriverManager().install()),
        options=opts,
    )
    driver.set_script_timeout(90)

    try:
        driver.get("https://idx.co.id/id/perusahaan-tercatat/keterbukaan-informasi/")
        print(
            f"Browser terbuka. Selesaikan challenge/manual check dalam {args.wait_seconds} detik..."
        )
        time.sleep(args.wait_seconds)

        script = """
const done = arguments[0];
const u = arguments[1];
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 30000);
fetch(u, { credentials: 'include', signal: ctrl.signal })
  .then(async (r) => {
    clearTimeout(timer);
    const txt = await r.text();
    done(JSON.stringify({ status: r.status, ok: r.ok, body: txt }));
  })
  .catch((e) => {
    clearTimeout(timer);
    done(JSON.stringify({ error: String(e) }));
  });
"""
        raw = driver.execute_async_script(script, url)
        payload = json.loads(raw)

        if "error" in payload:
            raise RuntimeError(payload["error"])
        if not payload.get("ok"):
            raise RuntimeError(
                f"IDX API gagal: status={payload.get('status')} body={payload.get('body','')[:300]}"
            )

        body = payload.get("body", "")
        parsed = json.loads(body)
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(parsed, f, ensure_ascii=False)

        replies = parsed.get("Replies", []) if isinstance(parsed, dict) else []
        print(f"OK. Tersimpan di: {out_path}")
        print(f"ResultCount: {parsed.get('ResultCount') if isinstance(parsed, dict) else 'n/a'}")
        print(f"Replies: {len(replies)}")
        if replies:
            first_title = (
                replies[0].get("pengumuman", {}).get("JudulPengumuman", "")
                if isinstance(replies[0], dict)
                else ""
            )
            print(f"First title: {first_title}")
    finally:
        driver.quit()


if __name__ == "__main__":
    main()

