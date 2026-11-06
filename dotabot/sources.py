import asyncio
import logging
import re
import time
from urllib.parse import urlsplit

import httpx

from .models import Event, clean, patch_version

log = logging.getLogger(__name__)
DOTA = "https://www.dota2.com/datafeed/"
STEAM = "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/"


def notes(value, prefix=""):
    """Keep section/ability context while extracting Valve's localized notes."""
    result = []
    if isinstance(value, list):
        for item in value:
            result.extend(notes(item, prefix))
    elif isinstance(value, dict):
        heading = clean(str(value.get("title", "")))
        context = f"{prefix} / {heading}" if prefix and heading else heading or prefix
        if value.get("note"):
            text = clean(value["note"])
            if text:
                result.append(f"{context}: {text}" if context else text)
        for key, child in value.items():
            if isinstance(child, (dict, list)):
                result.extend(notes(child, context))
    return result


def categories_for_news(title, body):
    text = clean(title + " " + body).lower()
    categories = []
    if patch_version(title, body) and re.search(r"patch|update|патч|обновлен", text):
        categories.append("Патч")
    if re.search(r"new (?:playable )?hero(?!\s+(?:set|cosmetic|skin))\b|introducing.{0,60}hero\b|нов\w* геро|герой.{0,40}(?:доступен|добавлен)", text):
        categories.append("Новый герой")
    if re.search(r"matchmaking|\bmmr\b|ranked (?:match|system|role|queue|season)|calibration|glicko|rank confidence|рейтинг|калибров|подбор\w* матч", text) and re.search(r"chang|updat|introduc|replac|new|reset|измен|обнов|нов\w*|сброс", text):
        categories.append("Рейтинговая система")
    # Bug fixes and cosmetics alone are intentionally not balance updates.
    if re.search(r"(?:hero|item|gameplay|balance).{0,35}(?:balance|rework|adjust|buff|nerf)|(?:buff|nerf|rework).{0,35}(?:hero|item)|изменения баланса|баланс\w* (?:геро|предмет)", text):
        categories.append("Баланс")
    if re.search(r"coming soon|arriv(?:ing|es) (?:next|this|in)|will be released|скоро|выйдет|появится", text) and not re.search(r"out now|available now|released today|уже доступ|уже выш|вышел|выпущен", text):
        return []
    return categories


class Sources:
    def __init__(self, http: httpx.AsyncClient):
        self.http = http
        self.names = {"heroes": {}, "items": {}, "abilities": {}}
        self.names_updated = 0.0

    async def get(self, url, params=None):
        response = await self.http.get(url, params=params, timeout=35)
        response.raise_for_status()
        return response.json()

    async def patches(self):
        data = await self.get(DOTA + "patchnoteslist")
        if data.get("success") is not True or not data.get("patches"):
            raise ValueError("Пустой или некорректный список патчей Valve")
        result = data["patches"]
        if any(not re.fullmatch(r"\d+\.\d{2}[a-z]?", p.get("patch_number", "")) or not isinstance(p.get("patch_timestamp"), int) for p in result):
            raise ValueError("Неизвестный формат списка патчей")
        return sorted(result, key=lambda p: (p["patch_timestamp"], p["patch_number"]))

    async def load_names(self):
        if time.monotonic() - self.names_updated < 86400:
            return
        results = await asyncio.gather(*(self.get(DOTA + endpoint, {"language": "russian"}) for endpoint in ("herolist", "itemlist", "abilitylist")), return_exceptions=True)
        complete = True
        for category, data in zip(self.names, results):
            try:
                rows = data["result"]["data"]["heroes" if category == "heroes" else "itemabilities"]
                self.names[category] = {row["id"]: row.get("name_loc") or row.get("name_english_loc") or row["name"] for row in rows}
            except (TypeError, KeyError):
                complete = False
                log.warning("Имена %s временно недоступны", category)
        if complete:
            self.names_updated = time.monotonic()

    async def patch(self, metadata):
        version = metadata["patch_number"]
        data = await self.get(DOTA + "patchnotes", {"version": version, "language": "russian"})
        if data.get("patch_number") != version or not any(data.get(k) for k in ("general_notes", "heroes", "items", "neutral_items", "neutral_creeps")):
            raise ValueError("Полные примечания к патчу ещё недоступны")
        await self.load_names()
        facts = notes(data.get("general_notes", []), "Общие изменения")
        groups = {"general": list(facts), "heroes": [], "items": []}
        categories = ["Крупный патч" if re.fullmatch(r"\d+\.\d{2}", version) else "Баланс"]
        for key, names_key, id_key, label in (
            ("heroes", "heroes", "hero_id", "Герой"),
            ("items", "items", "ability_id", "Предмет"),
            ("neutral_items", "items", "ability_id", "Нейтральный предмет"),
            ("neutral_creeps", "heroes", "hero_id", "Нейтральный крип"),
        ):
            for record in data.get(key, []):
                before = len(facts)
                identifier = record.get(id_key)
                name = self.names[names_key].get(identifier, f"{label} #{identifier}")
                base = {k: v for k, v in record.items() if k != "abilities"}
                facts.extend(notes(base, name))
                for ability in record.get("abilities", []):
                    ability_name = self.names["abilities"].get(ability.get("ability_id"), "Способность")
                    facts.extend(notes(ability, f"{name} / {ability_name}"))
                groups["heroes" if key == "heroes" else "items"].extend(facts[before:])
        if not facts:
            raise ValueError("Не удалось извлечь изменения патча")
        if re.search(r"рейтинг|калибров|matchmaking|ranked|\bmmr\b", " ".join(facts), re.I):
            categories.append("Рейтинговая система")
        url = f"https://www.dota2.com/patches/{version}"
        return Event(f"patch:{version}", f"Dota 2 — патч {version}", url, int(metadata["patch_timestamp"]), categories, facts, "\n".join(facts), version, groups)

    async def news(self, since=None):
        """Page back to the last successful poll so downtime doesn't lose posts."""
        result, enddate = {}, None
        for _ in range(30):
            params = {"appid": 570, "count": 100, "maxlength": 0, "feeds": "steam_community_announcements"}
            if enddate is not None:
                params["enddate"] = enddate
            data = await self.get(STEAM, params)
            rows = data["appnews"]["newsitems"]
            if not rows:
                break
            for row in rows:
                if row.get("feedname") != "steam_community_announcements" or int(row.get("appid", 0)) != 570:
                    continue
                if since is None or int(row["date"]) >= since:
                    result[str(row["gid"])] = row
            oldest = min(int(r["date"]) for r in rows)
            if since is None or oldest < since or len(rows) < 100:
                break
            next_end = oldest - 1
            if enddate is not None and next_end >= enddate:
                raise ValueError("Steam не продвигает пагинацию новостей")
            enddate = next_end
        else:
            raise ValueError("Слишком большой разрыв истории: курсор Steam не обновлён")
        return sorted(result.values(), key=lambda row: (int(row["date"]), str(row["gid"])))

    @staticmethod
    def news_event(row):
        version = patch_version(row["title"], row["contents"])
        gid = str(row["gid"])
        if not gid.isdigit():
            raise ValueError("Некорректный идентификатор новости Steam")
        url = f"https://www.dota2.com/patches/{version}" if version else row.get("url", "")
        parts = urlsplit(url)
        if parts.scheme != "https" or parts.hostname not in {
            "www.dota2.com", "dota2.com", "store.steampowered.com",
            "steamcommunity.com", "steamstore-a.akamaihd.net",
        } or parts.username or parts.password:
            raise ValueError("Неизвестный адрес официальной публикации")
        return Event(
            f"patch:{version}" if version else f"news:{gid}",
            clean(row["title"]),
            url,
            int(row["date"]), categories_for_news(row["title"], row["contents"]),
            body=clean(row["contents"]), version=version,
        )
