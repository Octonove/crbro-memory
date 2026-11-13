# Daemon mode (several clients on one brain)

```bash
npx crbro-memory daemon on       # then restart your MCP clients
npx crbro-memory daemon status
```

By default every MCP client starts its own CRBRO: its own copy of the index, its own embedding model (~0.5 GB), its own in-memory index that it writes over the others' when it closes. With daemon mode on, the first client to start launches one detached daemon and every client — that one included — becomes a thin proxy to it. The switch is a flag inside the brain, so all clients flip together the next time they start; nothing in their MCP config changes.

It is built so that it can only ever cost speed. No daemon to be had: the client serves itself in-process, as before. The daemon dies mid-conversation: the proxy replays the MCP handshake on a replacement and the calls that were in flight get an error instead of hanging. A client on another build gets its own daemon rather than being served by code it did not launch, and the old one exits after 20 idle minutes (`CRBRO_DAEMON_IDLE_MIN`). The pipe or socket is reachable only with a token kept in `<brain>/.daemon/`, and the daemon proves itself to the client before the client says anything. `CRBRO_DAEMON=0` in one client's env keeps that client out. Numbers and the real-process test are in [`benchmarks/daemon/`](https://github.com/Octonove/crbro-memory/tree/master/benchmarks/daemon). A single client gains nothing from it.
