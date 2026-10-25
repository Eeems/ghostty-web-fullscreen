# ghostty-web fullscreen

Fullscreen ghostty-web. Based on `@ghostty-web/demo`. Runs tmux on startup.

*Security note: this exposes a real shell. Keep loopback unless you understand the risk.*

## Setup

Install dependencies:

```sh
npm install
npm start
```

Open http://127.0.0.1:8080.

## Configuration

Set these environment variables:

- `PORT`: HTTP port. Default `8080`.
- `HOST`: bind address. Default `127.0.0.1`.
- `GHOSTTY_ALLOWED_HOSTS`: comma-separated hostnames. Required for wildcard or non-loopback binds.
- `STARTUP_COMMAND`: command to run in the PTY. Default uses tmux.

Examples:

```sh
PORT=3000 HOST=127.0.0.1 npm start
```

```sh
PORT=8080 HOST=0.0.0.0 GHOSTTY_ALLOWED_HOSTS=example.com,localhost npm start
```

## Startup command

Set `STARTUP_COMMAND` to override the default. The value runs in the user's shell.

Default behavior: attach to an existing tmux session, or create one.

Example:

```sh
STARTUP_COMMAND='exec tmux new -s work' npm start
```

## Deployment

1. Copy the project to the target machine.
2. Run `npm install`.
3. Set `PORT`, `HOST`, and `GHOSTTY_ALLOWED_HOSTS`.
4. Run `npm start`.

### systemd example

```ini
[Unit]
Description=ghostty-web fullscreen
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/ghostty-web-fullscreen
Environment=PORT=8080
Environment=HOST=0.0.0.0
Environment=GHOSTTY_ALLOWED_HOSTS=example.com
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```
