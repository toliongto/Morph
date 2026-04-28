#!/usr/bin/env python3

import argparse
import json
import re
import shutil
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urljoin, urlparse
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup


BASE_URL = "https://www.apkmirror.com"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Download APKMirror APKs by app, version, and variant.")
    parser.add_argument("--app-name", required=True)
    parser.add_argument("--package-name", required=True)
    parser.add_argument("--org", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--version", default="latest")
    parser.add_argument("--arch", default="universal")
    parser.add_argument("--fallback-arch", default="")
    parser.add_argument("--dpi", default="nodpi")
    parser.add_argument("--type", default="apk", choices=["apk", "bundle"])
    parser.add_argument("--out-file", default="")
    args = parser.parse_args()

    version_page = select_version_page(args.org, args.repo, args.version)
    variant = select_variant(version_page, args)
    download_page, download_url = resolve_download_url(variant["url"])

    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    filename = args.out_file or filename_from_url(download_url) or f"{args.repo}-{variant['version']}.apk"
    path = out_dir / filename

    with open_url(download_url, referer=download_page, accept="application/vnd.android.package-archive,*/*") as response:
        content_type = response.headers.get("Content-Type", "")
        if "text/html" in content_type.lower():
            raise RuntimeError(f"{args.app_name}: APKMirror returned HTML instead of an APK for {download_url}")

        with path.open("wb") as output:
            shutil.copyfileobj(response, output)

    print(json.dumps({
        "appName": args.app_name,
        "packageName": args.package_name,
        "source": "apkmirror",
        "sourcePage": version_page["url"],
        "variantPage": variant["url"],
        "downloadPage": download_page,
        "downloadUrl": download_url,
        "path": str(path),
        "filename": path.name,
        "version": variant["version"],
        "versionCode": variant.get("versionCode", ""),
        "fileType": variant["type"].upper(),
        "arch": variant["arch"],
        "dpi": variant["dpi"],
        "minAndroidVersion": variant.get("minAndroidVersion", ""),
        "size": format_bytes(path.stat().st_size),
    }))
    return 0


def select_version_page(org: str, repo: str, requested: str) -> dict[str, str]:
    if requested and requested not in {"latest", "stable"}:
        url = f"{BASE_URL}/apk/{org}/{repo}/{repo}-{requested.replace('.', '-')}-release/"
        ensure_page_exists(url)
        return {"name": requested, "url": url}

    url = f"{BASE_URL}/apk/{org}/{repo}/"
    soup = soup_from_url(url)
    versions = []
    version_list = soup.select_one('.listWidget:has(a[name="all_versions"])')
    if version_list:
        for row in version_list.select(".table-row"):
            link = row.select_one(".table-cell:nth-of-type(2) a[href]")
            if not link:
                continue
            name = link.get_text(" ", strip=True)
            href = link.get("href")
            if name and href:
                versions.append({"name": name, "url": absolute_url(href)})

    if not versions:
        raise RuntimeError(f"Could not find APKMirror versions for {org}/{repo}")

    if requested == "stable":
        selected = next((item for item in versions if "beta" not in item["name"].lower() and "alpha" not in item["name"].lower()), None)
    else:
        selected = versions[0]

    if not selected:
        raise RuntimeError(f"Could not find a suitable APKMirror {requested or 'latest'} version for {org}/{repo}")

    return selected


def ensure_page_exists(url: str) -> None:
    try:
        soup_from_url(url)
    except RuntimeError as exc:
        raise RuntimeError(f"APKMirror page was not available: {url}. {exc}") from exc


def select_variant(version_page: dict[str, str], args: argparse.Namespace) -> dict[str, str]:
    soup = soup_from_url(version_page["url"])
    direct = direct_download_button(soup)
    if direct:
        return {
            "version": version_page["name"],
            "type": args.type,
            "arch": args.arch,
            "dpi": args.dpi,
            "url": direct,
        }

    variants = parse_variants(soup)
    if not variants:
        raise RuntimeError(f"Could not find APKMirror variants at {version_page['url']}")

    selected = find_variant(variants, args.arch, args.dpi, args.type)
    if not selected and args.fallback_arch:
        selected = find_variant(variants, args.fallback_arch, args.dpi, args.type)
    if not selected:
        summary = ", ".join(f"{item['version']} {item['type']} {item['arch']} {item['dpi']}" for item in variants[:12])
        raise RuntimeError(
            f"Could not find APKMirror {args.type.upper()} variant for "
            f"arch={args.arch}, dpi={args.dpi}. Available: {summary or 'none'}"
        )

    return selected


def parse_variants(soup: BeautifulSoup) -> list[dict[str, str]]:
    variants = []
    for row in soup.select(".variants-table .table-row"):
        cells = row.select(".table-cell")
        link = row.select_one("a[href*='apk-download']")
        if len(cells) < 4 or not link:
            continue

        first = cells[0].get_text(" ", strip=True)
        version = link.get_text(" ", strip=True) or first.split()[0]
        file_type = "bundle" if "BUNDLE" in first.upper() else "apk"
        version_code_match = re.search(r"\b\d{7,}\b", first)

        variants.append({
            "version": version,
            "type": file_type,
            "arch": cells[1].get_text(" ", strip=True),
            "minAndroidVersion": cells[2].get_text(" ", strip=True),
            "dpi": cells[3].get_text(" ", strip=True),
            "url": absolute_url(link.get("href")),
            "versionCode": version_code_match.group(0) if version_code_match else "",
        })

    return variants


def find_variant(variants: list[dict[str, str]], arch: str, dpi: str, file_type: str) -> dict[str, str] | None:
    candidates = [item for item in variants if item["type"] == file_type]
    if dpi not in {"*", "any"}:
        candidates = [item for item in candidates if item["dpi"].lower() == dpi.lower()]

    if arch in {"universal", "noarch"}:
        preferred = [item for item in candidates if item["arch"].lower() in {"universal", "noarch"}]
        if preferred:
            return preferred[0]
        return None

    exact = [item for item in candidates if arch_matches(item["arch"], arch)]
    if exact:
        return exact[0]

    universal = [item for item in candidates if item["arch"].lower() in {"universal", "noarch"}]
    return universal[0] if universal else None


def arch_matches(value: str, requested: str) -> bool:
    parts = [part.strip().lower() for part in re.split(r"[,+]", value)]
    return requested.lower() in parts


def direct_download_button(soup: BeautifulSoup) -> str:
    button = soup.select_one("a.downloadButton[href*='/download/']")
    return absolute_url(button.get("href")) if button else ""


def resolve_download_url(variant_url: str) -> tuple[str, str]:
    variant_soup = soup_from_url(variant_url)
    first = direct_download_button(variant_soup)
    if not first:
        raise RuntimeError(f"Could not find APKMirror download button at {variant_url}")

    final_soup = soup_from_url(first, referer=variant_url)
    link = (
        final_soup.select_one(".card-with-tabs a[href*='download.php']")
        or final_soup.select_one("a[href*='download.php']")
    )
    if not link:
        raise RuntimeError(f"Could not find APKMirror final download link at {first}")

    download_php = absolute_url(link.get("href"))
    response = open_url(download_php, referer=first, accept="application/vnd.android.package-archive,*/*")
    try:
        return first, response.geturl()
    finally:
        response.close()


def soup_from_url(url: str, referer: str = "") -> BeautifulSoup:
    with open_url(url, referer=referer) as response:
        text = response.read().decode("utf-8", "ignore")
    if "Enable JavaScript and cookies to continue" in text or "Just a moment..." in text:
        raise RuntimeError("APKMirror returned a JavaScript/cookie challenge")
    return BeautifulSoup(text, "html.parser")


def open_url(url: str, referer: str = "", accept: str | None = None):
    headers = dict(HEADERS)
    if referer:
        headers["Referer"] = referer
    if accept:
        headers["Accept"] = accept

    try:
        return urlopen(Request(url, headers=headers), timeout=60)
    except HTTPError as exc:
        body = exc.read().decode("utf-8", "ignore")
        detail = " JavaScript/cookie challenge" if "Enable JavaScript" in body or "Just a moment..." in body else ""
        raise RuntimeError(f"HTTP {exc.code} for {url}.{detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"Network error for {url}: {exc.reason}") from exc


def absolute_url(value: str) -> str:
    return urljoin(BASE_URL, value)


def filename_from_url(url: str) -> str:
    path = unquote(urlparse(url).path)
    return Path(path).name


def format_bytes(bytes_count: int) -> str:
    units = ["B", "KB", "MB", "GB"]
    value = float(bytes_count)
    unit = 0
    while value >= 1024 and unit < len(units) - 1:
        value /= 1024
        unit += 1
    return f"{value:.0f} {units[unit]}" if unit == 0 else f"{value:.1f} {units[unit]}"


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
