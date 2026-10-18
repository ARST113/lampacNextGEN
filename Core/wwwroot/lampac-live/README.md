# lampac-live

Статические клиентские плагины, которые Lampac отдаёт напрямую.

## recommendations-v3.js — «Для вас»

Персональная лента для Lampa:

- читает `Lampa.Favorite` (`history`, `viewed`, `like`, `book`) активного профиля;
- нормализует карточки (TMDB id, тип, постер, год, рейтинг) и строит секции ленты;
- открывает штатный экран `full`, ничего не записывает в избранное и историю.

Подключение в `init.conf` (секция `LampaWeb` → `plugins`):

```json
{
  "url": "{localhost}/lampac-live/recommendations-v3.js?v=1",
  "status": 1,
  "name": "Для вас",
  "author": "lampac",
  "descr": "Персональная лента по истории и избранному активного профиля"
}
```

Лента использует историю просмотров, поэтому PidTor NextGen пишет её штатным
`Lampa.Favorite.add('history', …)` — просмотры через PidTor попадают и в «Историю», и в «Для вас».
