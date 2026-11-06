import asyncio
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx

from dotabot.config import Config
from dotabot.models import Event, clean, patch_version
from dotabot.service import Service
from dotabot.sources import Sources, categories_for_news, notes
from dotabot.store import Store
from dotabot.summary import Summarizer, fallback, render
from dotabot.telegram import Telegram, TelegramError


def event(version="7.99a", published=10):
    return Event("patch:" + version, "Патч " + version, "https://www.dota2.com/patches/" + version,
                 published, ["Баланс"], ["Axe: Базовая броня увеличена с 2 до 3"], version=version)


class ParsingTests(unittest.TestCase):
    def test_canonical_patch_id_across_sources(self):
        self.assertEqual(patch_version("7.99a Gameplay Patch"), "7.99a")
        self.assertEqual(patch_version("Update", '[url="https://www.dota2.com/patches/7.99a"]notes[/url]'), "7.99a")
        self.assertIsNone(patch_version("The International 2026"))

    def test_markup_removed(self):
        self.assertEqual(clean('[p]A &amp; B<br> [b]test[/b][/p]'), "A & B test")

    def test_nested_patch_sections(self):
        self.assertEqual(notes([{"title": "Economy", "generic": [{"note": "Gold changed"}]}]), ["Economy: Gold changed"])

    def test_cosmetics_and_bugfixes_ignored(self):
        self.assertEqual(categories_for_news("Trove of Terror", "New item sets and Arcana appearances"), [])
        self.assertEqual(categories_for_news("Dota 2 Update", "Fixed Axe attack animation. Fixed a crash."), [])
        self.assertEqual(categories_for_news("The International", "Ranked teams fight for a new trophy"), [])

    def test_new_hero_and_ranking_detected(self):
        self.assertIn("Новый герой", categories_for_news("Meet a new hero", "Playable now"))
        self.assertIn("Рейтинговая система", categories_for_news("Matchmaking update", "New calibration rules"))

    def test_official_news_uses_provided_url_not_guessed_id(self):
        # Steam's external-post ID isn't necessarily the announcement/event ID.
        url = "https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/123"
        row = {"gid": "123", "title": "Matchmaking update", "contents": "New ranked system available now", "date": 1000, "url": url}
        self.assertEqual(Sources.news_event(row).url, url)
        with self.assertRaises(ValueError):
            Sources.news_event({**row, "url": "https://untrusted.invalid/news/123"})

    def test_future_hero_announcement_not_release(self):
        self.assertEqual(categories_for_news("A new hero", "Coming soon next month"), [])
        self.assertEqual(categories_for_news("New hero sets", "New hero sets are available now"), [])

    def test_html_escaped_and_bounded(self):
        e = event()
        e.title = "Axe <script> & Dota"
        digest = render(e, {"changes": ["<b>&" * 400] * 10, "gameplay": "x" * 1000, "ranked": "y" * 1000})
        self.assertNotIn("<script>", digest)
        self.assertIn("&lt;script&gt;", digest)
        self.assertLess(len(clean(digest)), 3000)


class StoreTests(unittest.TestCase):
    database_url = ""

    def setUp(self):
        self.store = Store(":memory:", self.database_url, lock=False)

    def tearDown(self):
        if self.database_url:
            for table in ("deliveries", "events", "chats", "meta"):
                self.store.execute("DELETE FROM " + table)
        self.store.close()

    def test_dedup_per_chat_survives_repeat_ingestion(self):
        self.store.subscribe(1)
        self.store.subscribe(2)
        self.store.save(event(), "digest")
        self.store.save(event(), "second digest")
        self.assertEqual(len(self.store.pending()), 2)
        self.store.delivery(event().key, 1, "sent")
        self.assertEqual([r["chat_id"] for r in self.store.pending()], [2])

    def test_first_boot_has_no_broadcast(self):
        self.store.subscribe(1)
        self.store.save(event(), "digest", broadcast=False)
        self.assertEqual(len(self.store.pending()), 0)
        self.assertEqual(self.store.latest()["message"], "digest")

    def test_unsubscribe_cancels_pending_and_resubscribe_does_not_replay(self):
        self.store.subscribe(1)
        self.store.save(event(), "digest")
        self.store.subscribe(1, False)
        self.store.subscribe(1)
        self.assertEqual(len(self.store.pending()), 0)

    def test_new_subscriber_gets_only_new_events(self):
        self.store.save(event(), "old")
        self.store.subscribe(1)
        self.assertEqual(len(self.store.pending()), 0)
        self.store.save(event("7.99b", 20), "new")
        self.assertEqual(self.store.pending()[0]["message"], "new")

    def test_transaction_rollback(self):
        with self.assertRaises(ValueError):
            with self.store.transaction():
                self.store.set("test", "value")
                raise ValueError()
        self.assertIsNone(self.store.get("test"))

    def test_cursor_persisted(self):
        self.store.set("telegram_offset", 123)
        self.assertEqual(self.store.get("telegram_offset"), "123")

    def test_russian_message_preserved(self):
        self.store.save(event(), "Герои и предметы — изменения баланса 🎮")
        self.assertEqual(self.store.latest()["message"], "Герои и предметы — изменения баланса 🎮")


@unittest.skipUnless(os.getenv("DOTABOT_TEST_DATABASE_URL"), "Отдельная тестовая PostgreSQL не настроена")
class PostgresStoreTests(StoreTests):
    database_url = os.getenv("DOTABOT_TEST_DATABASE_URL", "")


class RestartTests(unittest.TestCase):
    def test_persistent_sqlite_and_uncertain_delivery(self):
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / "bot.sqlite3")
            store = Store(path)
            store.subscribe(1)
            store.save(event(), "digest")
            store.delivery(event().key, 1, "sending")
            store.close()
            restarted = Store(path)
            self.assertTrue(restarted.seen(event().key))
            self.assertEqual(restarted.pending(), [])
            self.assertEqual(restarted.execute("SELECT status FROM deliveries").fetchone()["status"], "uncertain")
            restarted.close()

    def test_second_process_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / "bot.sqlite3")
            first = Store(path)
            try:
                with self.assertRaises(RuntimeError):
                    Store(path)
            finally:
                first.close()


class AsyncTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.http = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={})))
        self.store = Store(":memory:")
        self.sources = SimpleNamespace(patches=AsyncMock(), patch=AsyncMock(return_value=event()), news=AsyncMock(return_value=[]), news_event=Sources.news_event)
        self.telegram = SimpleNamespace(username="test_bot", send=AsyncMock(), call=AsyncMock(), is_admin=AsyncMock(return_value=True))
        self.summary = Summarizer(self.http)
        self.service = Service(Config(), self.store, self.sources, self.summary, self.telegram)
        self.service.pause = AsyncMock()

    async def asyncTearDown(self):
        self.store.close()
        await self.http.aclose()

    async def test_bootstrap_then_new_patch_once(self):
        self.sources.patches.return_value = [{"patch_number": "7.99a", "patch_timestamp": 10}]
        self.store.subscribe(1)
        await self.service.check_patches()
        self.assertEqual(len(self.store.pending()), 0)
        self.sources.patches.return_value.append({"patch_number": "7.99b", "patch_timestamp": 20})
        self.sources.patch.return_value = event("7.99b", 20)
        await self.service.check_patches()
        await self.service.check_patches()
        self.assertEqual(len(self.store.pending()), 1)
        await self.service.deliver()
        await self.service.deliver()
        self.telegram.send.assert_awaited_once()

    async def test_news_and_patch_same_event_no_duplicate(self):
        self.store.subscribe(1)
        self.store.save(event(), "digest")
        self.store.set("news_cursor", int(time.time()))
        self.sources.news.return_value = [{"gid": "123", "title": "7.99a Gameplay Patch", "contents": "Patch is out", "date": 20}]
        await self.service.check_news()
        self.assertEqual(len(self.store.pending()), 1)
        self.assertTrue(self.store.seen("news:123"))

    async def test_news_bootstrap_does_not_hide_patch(self):
        self.sources.news.return_value = [{"gid": "123", "title": "7.99a Gameplay Patch", "contents": "Patch is out", "date": 20}]
        await self.service.check_news()
        self.assertFalse(self.store.seen("patch:7.99a"))

    async def test_first_patch_fetch_failure_can_retry(self):
        self.sources.patches.return_value = [{"patch_number": "7.99a", "patch_timestamp": 10}]
        self.sources.patch.side_effect = ValueError()
        with self.assertRaises(ValueError):
            await self.service.check_patches()
        self.assertIsNone(self.store.get("patches_initialized"))
        self.assertFalse(self.store.seen("patch:7.99a"))
        self.sources.patch.side_effect = None
        await self.service.check_patches()
        self.assertIsNotNone(self.store.latest())

    async def test_independent_source_failure(self):
        self.sources.patches.side_effect = httpx.ConnectError("offline")
        await self.service.check()
        self.sources.news.assert_awaited_once()
        self.assertIsNotNone(self.store.get("news_checked"))

    async def test_failed_news_does_not_advance_cursor(self):
        self.store.set("news_cursor", 100000)
        self.sources.news.side_effect = httpx.ReadTimeout("offline")
        with self.assertRaises(httpx.ReadTimeout):
            await self.service.check_news()
        self.assertEqual(self.store.get("news_cursor"), "100000")

    async def test_new_patch_via_steam_fetches_full_notes(self):
        self.store.set("news_cursor", 100000)
        self.store.subscribe(1)
        self.sources.news.return_value = [{"gid": "123", "title": "7.99a Gameplay Patch", "contents": "Notes link", "date": 100001}]
        await self.service.check_news()
        self.sources.patch.assert_awaited_once()
        self.assertEqual(len(self.store.pending()), 1)

    async def test_429_reschedules_and_later_sends(self):
        self.store.subscribe(1)
        self.store.save(event(), "digest")
        self.telegram.send.side_effect = TelegramError(429, 30)
        await self.service.deliver()
        row = self.store.execute("SELECT status,next_attempt FROM deliveries").fetchone()
        self.assertEqual(row["status"], "pending")
        self.assertGreater(row["next_attempt"], time.time())
        self.service.pause.assert_awaited_with(30)
        self.store.delivery(event().key, 1, "pending")
        self.telegram.send.side_effect = None
        await self.service.deliver()
        self.assertEqual(self.store.execute("SELECT status FROM deliveries").fetchone()["status"], "sent")

    async def test_timeout_not_blindly_resent(self):
        self.store.subscribe(1)
        self.store.save(event(), "digest")
        self.telegram.send.side_effect = httpx.ReadTimeout("unknown outcome")
        await self.service.deliver()
        await self.service.deliver()
        self.telegram.send.assert_awaited_once()
        self.assertEqual(self.store.execute("SELECT status FROM deliveries").fetchone()["status"], "uncertain")

    async def test_blocked_chat_disabled_other_chat_continues(self):
        self.store.subscribe(1)
        self.store.subscribe(2)
        self.store.save(event(), "digest")
        self.telegram.send.side_effect = [TelegramError(403), None]
        await self.service.deliver()
        self.assertFalse(self.store.is_active(1))
        self.assertTrue(self.store.is_active(2))
        self.assertEqual(self.telegram.send.await_count, 2)

    async def test_group_subscription_requires_admin(self):
        self.telegram.is_admin.return_value = False
        await self.service.handle({"message": {"text": "/start@test_bot", "chat": {"id": -1, "type": "group"}, "from": {"id": 42}}})
        self.assertFalse(self.store.is_active(-1))
        self.telegram.is_admin.return_value = True
        await self.service.handle({"message": {"text": "/start@test_bot", "chat": {"id": -1, "type": "group"}, "from": {"id": 42}}})
        self.assertTrue(self.store.is_active(-1))

    async def test_allowlist_and_other_bot_commands(self):
        self.service.config = Config(allowed_ids=frozenset({42}))
        await self.service.handle({"message": {"text": "/start", "chat": {"id": 1, "type": "private"}, "from": {"id": 99}}})
        self.assertFalse(self.store.is_active(1))
        await self.service.handle({"message": {"text": "/start@other_bot", "chat": {"id": 1, "type": "private"}, "from": {"id": 42}}})
        self.assertFalse(self.store.is_active(1))
        await self.service.handle({"message": {"text": "/start", "chat": {"id": 1, "type": "private"}, "from": {"id": 42}}})
        self.assertTrue(self.store.is_active(1))

    async def test_stop_and_status(self):
        msg = {"chat": {"id": 1, "type": "private"}, "from": {"id": 42}}
        await self.service.handle({"message": {**msg, "text": "/start"}})
        await self.service.handle({"message": {**msg, "text": "/stop"}})
        self.assertFalse(self.store.is_active(1))
        await self.service.handle({"message": {**msg, "text": "/status"}})
        self.assertIn("выключена", self.telegram.send.call_args.args[1])

    async def test_ai_schema_and_fallback(self):
        seen = []
        def handler(request):
            seen.append(json.loads(request.content))
            summary = {"significant": True, "changes": ["Axe: броня 2 → 3"], "gameplay": "Может лучше размениваться.", "ranked": "Проверьте пик Axe."}
            return httpx.Response(200, json={"status": "completed", "output": [{"content": [{"type": "output_text", "text": json.dumps(summary)}]}]})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            digest = await Summarizer(http, "fake-key").summarize(event())
        self.assertIn("броня", digest)
        self.assertFalse(seen[0]["store"])
        self.assertTrue(seen[0]["text"]["format"]["strict"])
        # Invalid or unavailable AI must not discard a known gameplay patch.
        digest = await Summarizer(self.http, "fake-key").summarize(event())
        self.assertIn("официальные", digest.lower())

    async def test_steam_pagination_only_official(self):
        seen_params = []
        def handler(request):
            seen_params.append(dict(request.url.params))
            if len(seen_params) == 1:
                rows = [{"gid": str(i), "date": 2000 - i, "appid": 570, "feedname": "steam_community_announcements"} for i in range(100)]
            else:
                rows = [{"gid": "101", "date": 1800, "appid": 570, "feedname": "third_party"}, {"gid": "102", "date": 1700, "appid": 570, "feedname": "steam_community_announcements"}]
            return httpx.Response(200, json={"appnews": {"newsitems": rows}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            rows = await Sources(http).news(since=1750)
        self.assertEqual(len(rows), 100)
        self.assertEqual(seen_params[1]["enddate"], "1900")
        self.assertEqual(seen_params[0]["feeds"], "steam_community_announcements")

    async def test_telegram_api_and_existing_webhook(self):
        def handler(request):
            if request.url.path.endswith("getMe"):
                return httpx.Response(200, json={"ok": True, "result": {"username": "Test_Bot"}})
            return httpx.Response(200, json={"ok": True, "result": {"url": "https://existing.invalid/hook"}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            telegram = Telegram(http, "fake-token")
            with self.assertRaises(RuntimeError):
                await telegram.start()


if __name__ == "__main__":
    unittest.main()
