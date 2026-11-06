import asyncio
import logging
import time
from datetime import datetime, timezone

import httpx

from .telegram import TelegramError

log = logging.getLogger(__name__)
HELP = """🎮 <b>Dota Patch Watch</b>

Слежу за официальными обновлениями Valve: крупными патчами, новыми героями, балансом героев и предметов, изменениями рейтинга.

/start — подписаться на новые обновления
/stop — отключить рассылку
/latest — запросить последний разбор
/status — состояние подписки и источников
/help — эта справка

Можно пользоваться в личке или добавить меня в общий чат. В группе подписку включает и выключает администратор: /start@{username} и /stop@{username}.

Проверяю источники каждые {minutes} мин. Косметика, турниры и обычные исправления багов не входят в рассылку. При первом запуске старые публикации не рассылаю. /latest показывает разбор по вашему запросу, даже если вы уже его видели.

Выводы о влиянии — оценка по примечаниям, без выдуманной статистики побед."""


class Service:
    def __init__(self, config, store, sources, summarizer, telegram):
        self.config, self.store = config, store
        self.sources, self.summarizer, self.telegram = sources, summarizer, telegram
        self.stop = asyncio.Event()

    async def check_patches(self):
        patches = await self.sources.patches()
        if not self.store.get("patches_initialized"):
            # Fetch and summarize before committing the baseline. A failed first
            # request must never permanently suppress the latest patch.
            latest = await self.sources.patch(patches[-1])
            message = await self.summarizer.summarize(latest)
            with self.store.transaction():
                for row in patches[:-1]:
                    self.store.archive("patch:" + row["patch_number"], row["patch_timestamp"])
            self.store.save(latest, message, broadcast=False)
            self.store.set("patches_initialized", 1)
        else:
            for row in patches:
                key = "patch:" + row["patch_number"]
                if self.store.seen(key):
                    continue
                event = await self.sources.patch(row)
                message = await self.summarizer.summarize(event)
                self.store.save(event, message)
                log.info("Обработан %s", key)
        self.store.set("patches_checked", int(time.time()))

    async def check_news(self):
        started = int(time.time())
        cursor = self.store.get("news_cursor")
        rows = await self.sources.news(int(cursor) - 86400 if cursor else None)
        if not cursor:
            # Article IDs are independent of canonical patch IDs: a Steam
            # baseline cannot suppress a failed patchnotes fetch.
            with self.store.transaction():
                for row in rows:
                    self.store.archive("news:" + str(row["gid"]), int(row["date"]))
                self.store.set("news_cursor", started)
        else:
            for row in rows:
                article_key = "news:" + str(row["gid"])
                if self.store.seen(article_key):
                    continue
                event = self.sources.news_event(row)
                if not self.store.seen(event.key):
                    if event.version:
                        event = await self.sources.patch({"patch_number": event.version, "patch_timestamp": event.published})
                    message = await self.summarizer.summarize(event)
                    self.store.save(event, message)
                self.store.archive(article_key, int(row["date"]))
            self.store.set("news_cursor", started)
        self.store.set("news_checked", started)

    async def check(self):
        # Independent failures: Steam being down must not block patchnotes.
        for name, operation in (("Valve", self.check_patches), ("Steam", self.check_news)):
            try:
                await operation()
            except (httpx.HTTPError, ValueError, KeyError, TypeError) as error:
                log.warning("Ошибка источника %s (%s); повтор при следующей проверке", name, type(error).__name__)

    async def deliver(self):
        for row in self.store.pending():
            if self.stop.is_set():
                return
            key, chat_id = row["event_key"], row["chat_id"]
            self.store.delivery(key, chat_id, "sending")
            try:
                await self.telegram.send(chat_id, row["message"])
            except TelegramError as error:
                if error.code == 429:
                    self.store.delivery(key, chat_id, "pending", max(error.retry_after, 5))
                    # Honor a bot-wide Telegram flood limit, not just this chat.
                    await self.pause(max(error.retry_after, 5))
                    return
                if error.code == 403:
                    self.store.subscribe(chat_id, False)
                    self.store.delivery(key, chat_id, "blocked")
                else:
                    self.store.delivery(key, chat_id, "uncertain" if error.code >= 500 else "failed")
                    log.warning("Отправка %s не подтверждена: Telegram %s", key, error.code)
            except httpx.ConnectError:
                self.store.delivery(key, chat_id, "pending", 60)
            except httpx.HTTPError:
                # A read timeout can happen after Telegram accepted the message.
                self.store.delivery(key, chat_id, "uncertain")
                log.warning("Нет подтверждения Telegram для %s; автоматический повтор отключён", key)
            else:
                self.store.delivery(key, chat_id, "sent")
            await self.pause(1.1)

    async def pause(self, seconds):
        try:
            await asyncio.wait_for(self.stop.wait(), timeout=seconds)
        except TimeoutError:
            pass

    async def worker(self):
        next_check = 0
        while not self.stop.is_set():
            if time.monotonic() >= next_check:
                await self.check()
                next_check = time.monotonic() + self.config.interval
            await self.deliver()
            await self.pause(min(3, max(0, next_check - time.monotonic())))

    async def handle(self, update):
        message = update.get("message")
        if not message or not message.get("text", "").startswith("/"):
            return
        chat_id = message["chat"]["id"]
        command = message["text"].split()[0][1:]
        name, _, mention = command.partition("@")
        if mention and mention.lower() != self.telegram.username:
            return
        if name not in ("start", "stop", "latest", "status", "help"):
            return
        user_id = message.get("from", {}).get("id")
        if self.config.allowed_ids and user_id not in self.config.allowed_ids:
            await self.telegram.send(chat_id, "Этот бот доступен только участникам списка ALLOWED_USER_IDS.")
            return
        if name in ("start", "stop") and not await self.telegram.is_admin(message):
            await self.telegram.send(chat_id, "Включать и выключать рассылку для группы может её администратор.")
            return
        if name == "start":
            self.store.subscribe(chat_id)
            answer = "✅ Подписка включена. Пришлю новые важные обновления с кратким разбором и ссылкой Valve.\n\nПоследний разбор: /latest\nОтключить: /stop"
        elif name == "stop":
            self.store.subscribe(chat_id, False)
            answer = "🔕 Рассылка отключена. Вернуться: /start"
        elif name == "latest":
            latest = self.store.latest()
            answer = latest["message"] if latest else "Пока готовлю первый разбор. Попробуйте после проверки источников: /status"
        elif name == "status":
            def checked(key):
                timestamp = self.store.get(key)
                if not timestamp:
                    return "ещё не было успешной проверки"
                stamp = datetime.fromtimestamp(int(timestamp), timezone.utc).strftime("%d.%m.%Y %H:%M UTC")
                stale = int(time.time()) - int(timestamp) > self.config.interval * 2
                return stamp + (" ⚠️ источник давно не отвечал" if stale else "")
            answer = (f"Рассылка: {'включена ✅' if self.store.is_active(chat_id) else 'выключена 🔕'}\n"
                      f"Интервал: {self.config.interval // 60} мин.\n"
                      f"Valve: {checked('patches_checked')}\nSteam: {checked('news_checked')}\n"
                      f"Разбор: {'AI с резервной сводкой Valve' if self.config.openai_key else 'автоматическая сводка Valve'}")
        else:
            answer = HELP.format(username=self.telegram.username, minutes=self.config.interval // 60)
        await self.telegram.send(chat_id, answer)

    async def poll(self):
        offset = int(self.store.get("telegram_offset", "0"))
        while not self.stop.is_set():
            try:
                updates = await self.telegram.call("getUpdates", offset=offset, timeout=25, allowed_updates=["message"])
                for update in updates:
                    try:
                        await self.handle(update)
                    except (TelegramError, httpx.HTTPError) as error:
                        log.warning("Ошибка обработки команды (%s)", type(error).__name__)
                    offset = int(update["update_id"]) + 1
                    self.store.set("telegram_offset", offset)
            except TelegramError as error:
                if error.code in (401, 409):
                    raise RuntimeError(f"Telegram {error.code}: проверьте токен и отсутствие второго процесса бота") from None
                await self.pause(max(5, error.retry_after))
            except (httpx.HTTPError, ValueError, KeyError) as error:
                log.warning("Telegram временно недоступен (%s)", type(error).__name__)
                await self.pause(5)
