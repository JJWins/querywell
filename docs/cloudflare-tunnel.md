# Cloudflare tunnel

Beta hostname: **https://beta.querywell.in**

Named tunnel `querywell` forwards that hostname to the app on this PC. Node stays on `127.0.0.1`. Cloudflare serves HTTPS.

## This machine

| Item | Value |
|---|---|
| Tunnel name | `querywell` |
| Tunnel ID | `4a29dec6-90b5-43d7-900b-2357d14c666a` |
| Origin | `http://127.0.0.1:1112` |
| Hostname | `beta.querywell.in` |
| Binary | `C:\Program Files (x86)\cloudflared\cloudflared.exe` |
| Config | `C:\Users\john.j\.cloudflared\config.yml` |
| Credentials | `C:\Users\john.j\.cloudflared\4a29dec6-90b5-43d7-900b-2357d14c666a.json` |
| Login cert | `C:\Users\john.j\.cloudflared\cert.pem` |

`config.yml` must keep `url: http://127.0.0.1:1112`, matching `APP_PORT`. Pointing at `:3000` serves an old process (beta `/docs` returns `Not found.`).

Treat `cert.pem` and the credentials JSON as secrets. Do not commit them.

## Run

Start the app first (`npm start` on port 1112), then:

```powershell
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel run querywell
```

Leave that window open. Sleep on this PC or the embedding host drops the site.

After editing `config.yml`, stop `cloudflared` and run the command again.

## Recreate (only if the tunnel is gone)

```powershell
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel login
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel create querywell
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel route dns querywell beta.querywell.in
```

Write `config.yml` with the new tunnel ID and `url: http://127.0.0.1:1112`, then `tunnel run querywell`.
