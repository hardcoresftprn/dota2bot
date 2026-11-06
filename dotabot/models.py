import re
from dataclasses import dataclass, field
from html import unescape


def clean(text: str) -> str:
    text = re.sub(r"\[img\b[^\]]*\].*?\[/img\]", "", text, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>|\[(?:/?[a-z*]+)(?:[^\]]*)\]", " ", text, flags=re.I)
    return re.sub(r"\s+", " ", unescape(text)).strip()


def patch_version(title: str, body: str = "") -> str | None:
    match = re.search(r"\b(\d+\.\d{2}[a-z]?)\b", title, flags=re.I)
    if not match:
        match = re.search(r"https://(?:www\.)?dota2\.com/patches/(\d+\.\d{2}[a-z]?)\b", body, flags=re.I)
    return match.group(1).lower() if match else None


@dataclass
class Event:
    key: str
    title: str
    url: str
    published: int
    categories: list[str] = field(default_factory=list)
    facts: list[str] = field(default_factory=list)
    body: str = ""
    version: str | None = None
    groups: dict[str, list[str]] = field(default_factory=dict)
